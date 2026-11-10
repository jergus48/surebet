// Bet executor. For one surebet it opens every leg in THAT bookmaker's own
// debug Chrome window (separate port/profile per book), in parallel:
//   1. bring the book's window up (launch it if needed)
//   2. open the event (deep link, else search URL, else the homepage)
//   3. if the site is calibrated: click the odds, type the stake, re-read slip odds
//   4. mode 'fill' -> stop here, you click Place in each window
//      mode 'auto' -> only if EVERY leg is ready and odds held, click Place on all
//
// Main risk: one leg placed, the other rejected/odds moved = you hold an open
// position, not an arb. Every partial result is logged and sent to Telegram.
const chrome = require('./chrome');
const sites = require('./sites');
const db = require('../db');
const notify = require('../notify');
const { marketLabel } = require('../arb');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inFlight = new Set();

function priceTexts(p) {
  const a = p.toFixed(2), b = String(p);
  return [...new Set([a, b, a.replace('.', ','), b.replace('.', ',')])];
}
const { parseMoney, parsePrice } = require('./parse');
const balances = require('./balances');

function legUrl(site, sb, leg) {
  if (leg.link) return leg.link;
  if (site.search) return site.search.replace('{q}', encodeURIComponent(`${sb.home} ${sb.away}`));
  return site.home;
}

// Prepare one leg up to (not including) the Place click.
async function prepareLeg(settings, sb, leg) {
  const bk = settings.bookmakers[leg.book];
  if (!bk || !bk.enabled) throw new Error(`${leg.book}: not enabled in Settings`);
  const site = sites.load()[leg.book];
  if (!site) throw new Error(`${leg.book}: no site profile`);
  const url = legUrl(site, sb, leg);

  await chrome.launch(bk.port, leg.book, site.home);
  const page = await chrome.betPage(bk.port);
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const S = site.selectors;
  if (S.loggedIn && !(await page.$(S.loggedIn))) throw new Error(`${leg.book}: not logged in in its Chrome window`);
  if (!sites.calibrated(site)) {
    return { leg, page, site, ready: false, note: `opened ${url}; type stake ${leg.stake} on ${leg.sel} @ ${leg.price} yourself (site not calibrated)` };
  }

  // Balance check: this book must be able to cover its stake.
  leg.balance = null;
  if (S.balance) {
    leg.balance = parseMoney(await page.$eval(S.balance, el => el.innerText).catch(() => ''));
    if (leg.balance != null && leg.balance < leg.stake) {
      throw new Error(`${leg.book}: balance ${leg.balance} is below the stake ${leg.stake}, top it up`);
    }
  }

  // Click the odds cell whose text is the scanned price.
  await page.waitForSelector(S.oddsButton, { timeout: 15000 });
  const texts = priceTexts(leg.price);
  const handles = await page.$$(S.oddsButton);
  let target = null;
  for (const h of handles) {
    const t = (await h.evaluate(el => el.innerText || '')).trim();
    if (texts.some(x => t === x || t.endsWith(x))) { target = h; break; }
  }
  if (!target) throw new Error(`${leg.book}: odds ${leg.price} not found on page (moved or wrong event)`);
  await target.click();

  await page.waitForSelector(S.stakeInput, { timeout: 10000 });
  await page.click(S.stakeInput, { clickCount: 3 });
  await page.type(S.stakeInput, String(leg.stake), { delay: 40 });

  if (S.slipOdds) {
    const now = parsePrice(await page.$eval(S.slipOdds, el => el.innerText));
    const floor = leg.price * (1 - settings.maxOddsDropPct / 100);
    if (!now || now < floor) throw new Error(`${leg.book}: slip odds ${now} below scanned ${leg.price}`);
    leg.slipPrice = now;
  }
  return { leg, page, site, ready: true, note: `stake ${leg.stake} on slip @ ${leg.slipPrice || leg.price}` };
}

// Polls read() until the balance is at least `stake` below `before`. true = the money left the account.
async function waitForDrop(read, before, stake, { timeoutMs = 20000, everyMs = 1000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(everyMs);
    const now = await read().catch(() => null);
    if (now != null && now <= before - stake + 0.01) return true;
  }
  return false;
}

// Returns 'confirmed' or 'unconfirmed' (clicked, but no proof the site took the bet).
async function placeLeg(p) {
  const S = p.site.selectors;
  await p.page.click(S.placeButton);
  if (S.placedConfirm) {
    await p.page.waitForSelector(S.placedConfirm, { timeout: 20000 });
    return 'confirmed';
  }
  if (S.balance && p.leg.balance != null) {
    const read = async () => parseMoney(await p.page.$eval(S.balance, el => el.innerText));
    return (await waitForDrop(read, p.leg.balance, p.leg.stake)) ? 'confirmed' : 'unconfirmed';
  }
  await sleep(3000);
  return 'unconfirmed';
}

function autoAllowed(settings, sb) {
  if (sb.profitPct < settings.autoMinProfitPct) return `profit ${sb.profitPct}% < ${settings.autoMinProfitPct}%`;
  if (sb.staked > settings.autoMaxStakeTotal) return `stake ${sb.staked} > max ${settings.autoMaxStakeTotal}`;
  if (sb.suspect) return 'suspect: a price is far above the other books (likely stale)';
  if (settings.autoPrematchOnly && sb.live) return 'live bets disabled for auto';
  if (db.autoBetsToday() >= settings.autoDailyMaxBets) return 'daily auto-bet limit reached';
  return null;
}

// Per-bookmaker cap on ONE bet (settings.bookmakers.<book>.maxStakePerBet, in your currency).
// If any leg is above its book's cap, ALL legs are scaled down by the same factor so the
// surebet stays balanced. Returns the (possibly scaled) surebet, or { error }.
function applyStakeCaps(settings, sb) {
  let factor = 1;
  for (const l of sb.legs) {
    const bk = settings.bookmakers[l.book] || {};
    // Percentage of the bankroll you keep at this book wins; else the fixed per-bet cap.
    // The live balance (read from the logged-in window) replaces the typed-in bankroll.
    const bankroll = balances.fresh(l.book) ?? Number(bk.bankroll);
    const pct = bankroll > 0 && Number(bk.stakePercent) > 0 ? bankroll * Number(bk.stakePercent) / 100 : 0;
    const cap = pct || Number(bk.maxStakePerBet);
    if (!(cap > 0)) return { error: `${l.book}: set bankroll + stake % (or a max stake per bet) for auto` };
    factor = Math.min(factor, cap / l.stake);
  }
  if (factor >= 1) return { sb };
  const step = settings.roundStakeTo || 1;
  const legs = sb.legs.map(l => ({ ...l, stake: Math.floor(l.stake * factor / step) * step }));
  if (legs.some(l => l.stake < step)) return { error: 'stake cap too small for this surebet' };
  const staked = legs.reduce((a, l) => a + l.stake, 0);
  const worst = Math.min(...legs.map(l => l.stake * l.price)) - staked;
  if (worst <= 0) return { error: 'after stake caps and rounding the surebet no longer locks in a profit' };
  return { sb: { ...sb, legs, staked, worstProfit: Math.round(worst * 100) / 100 } };
}

// Last check before clicking Place: with the odds actually shown on each slip and the real stakes,
// is it still a surebet with enough margin?
function stillProfitable(settings, legs) {
  const staked = legs.reduce((a, l) => a + l.stake, 0);
  const worst = Math.min(...legs.map(l => l.stake * (l.slipPrice || l.price))) - staked;
  const pct = worst / staked * 100;
  return { ok: pct >= settings.autoMinProfitPct * 0.5, pct: Math.round(pct * 100) / 100 };
}

async function execute(settings, sb, { mode = settings.betMode, manual = false } = {}) {
  if (mode === 'off') return { status: 'skipped', detail: 'betMode off' };
  if (inFlight.has(sb.key)) return { status: 'skipped', detail: 'already running' };
  if (mode === 'auto' && !manual) {
    let why = autoAllowed(settings, sb);
    if (!why) {
      const capped = applyStakeCaps(settings, sb);
      if (capped.error) why = capped.error; else sb = capped.sb;
    }
    if (why) mode = 'fill', db.log('info', `auto -> fill for ${sb.home}-${sb.away}: ${why}`);
  }
  inFlight.add(sb.key);
  const betId = db.addBet(sb.key, mode, 'pending', '');
  const title = `${sb.home} - ${sb.away} (${marketLabel(sb)}, +${sb.profitPct}%)`;
  try {
    // Every leg in its own book's window, in parallel.
    const results = await Promise.allSettled(sb.legs.map(l => prepareLeg(settings, sb, { ...l })));
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errs = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    const notes = ok.map(p => `${p.leg.book}: ${p.note}`).concat(errs.map(e => `ERR ${e}`)).join(' | ');

    const allReady = errs.length === 0 && ok.every(p => p.ready);
    if (mode !== 'auto' || !allReady) {
      const status = errs.length ? 'failed' : 'filled';
      db.setBet(betId, status, notes);
      db.log(errs.length ? 'warn' : 'info', `[${mode}] ${title}: ${notes}`);
      notify.send(settings, `${status === 'filled' ? 'Ready, confirm in the windows' : 'Could not prepare'}: ${title}\n${notes}`).catch(() => { });
      return { status, detail: notes };
    }

    // Auto = all or nothing. Every leg must have a known balance that covers its stake,
    // and the odds on EVERY slip are re-read right before the clicks.
    const noBal = ok.filter(p => p.leg.balance == null).map(p => p.leg.book);
    if (noBal.length) {
      const detail = `cannot read the balance at ${noBal.join(', ')} (set the balance selector): not placed. ${notes}`;
      db.setBet(betId, 'failed', detail);
      notify.send(settings, `Not placed: ${title}\n${detail}`).catch(() => { });
      return { status: 'failed', detail };
    }
    await Promise.all(ok.map(async p => {
      const S = p.site.selectors;
      if (S.slipOdds) {
        const n = parsePrice(await p.page.$eval(S.slipOdds, el => el.innerText).catch(() => ''));
        p.leg.slipPrice = n || 0;
      }
    }));
    const chk = stillProfitable(settings, ok.map(p => p.leg));
    if (!chk.ok) {
      const detail = `odds changed on the slips, profit now ${chk.pct}%: not placed. ${notes}`;
      db.setBet(betId, 'failed', detail);
      db.log('warn', `[auto] ${title}: ${detail}`);
      notify.send(settings, `Not placed (odds changed): ${title}\n${detail}`).catch(() => { });
      return { status: 'failed', detail };
    }
    notify.send(settings, `Balances OK (${ok.map(p => `${p.leg.book} ${p.leg.balance}`).join(', ')}), odds hold, placing all legs now: ${title}`).catch(() => { });
    const placed = await Promise.allSettled(ok.map(placeLeg));
    const status = placedStatus(placed.map(r => (r.status === 'fulfilled' ? r.value : 'failed')));
    const detail = placed.map((r, i) => `${ok[i].leg.book}: ${r.status === 'fulfilled' ? (r.value === 'confirmed' ? 'PLACED' : 'CLICKED, NOT CONFIRMED') : 'FAILED ' + r.reason.message}`).join(' | ');
    db.setBet(betId, status, detail);
    db.log(status === 'placed' ? 'info' : 'error', `[auto] ${title}: ${detail}`);
    const head = {
      placed: 'Placed',
      partial: 'WARNING: only part of the bet was placed, you hold an open position!',
      unconfirmed: 'CHECK NOW: Place was clicked but not every leg is confirmed. Look at the bet history in each window.',
      failed: 'Failed',
    }[status];
    notify.send(settings, `${head}\n${title}\n${detail}`).catch(() => { });
    balances.refreshAll(settings).catch(() => { });
    return { status, detail };
  } catch (e) {
    db.setBet(betId, 'failed', e.message);
    db.log('error', `bet ${title}: ${e.message}`);
    return { status: 'failed', detail: e.message };
  } finally {
    inFlight.delete(sb.key);
  }
}

// Leg results ('confirmed' | 'unconfirmed' | 'failed') -> one status for the whole surebet.
function placedStatus(legs) {
  const n = k => legs.filter(x => x === k).length;
  if (n('confirmed') === legs.length) return 'placed';
  if (n('failed') === legs.length) return 'failed';
  if (n('failed') > 0) return 'partial';
  return 'unconfirmed';
}

module.exports = { execute, applyStakeCaps, stillProfitable, parseMoney, waitForDrop, placedStatus };
