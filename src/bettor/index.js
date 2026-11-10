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
const { parseMoney, parsePrice, parseAmount, placeLabelIn, localStake } = require('./parse');
const balances = require('./balances');

function legUrl(site, sb, leg) {
  if (leg.link) return leg.link;
  if (site.search) return site.search.replace('{q}', encodeURIComponent(`${sb.home} ${sb.away}`));
  return site.home;
}

// The stake box usually holds a default ("1,00", "0,50"): select all and delete it, type the
// stake in the box's own decimal style, then read it back. A box that does not show exactly
// the stake aborts the leg; typing into a default once turned 1 into "10,50".
function stakeText(stake, current) {
  const t = String(Math.round(stake * 100) / 100);
  return /,/.test(current || '') ? t.replace('.', ',') : t;
}
function stakeMatches(shown, stake) {
  const n = parseMoney(shown);
  return n != null && Math.abs(n - stake) < 0.005;
}
// Pages keep hidden copies of slips and inputs: always act on the first one that is on screen.
async function visible(page, sel) {
  for (const h of await page.$$(sel)) if (await h.boundingBox()) return h;
  return null;
}

// Amount for this leg in the site's own currency (leg.local, set by prepareLeg), else the € stake.
const amountOf = leg => leg.local ?? leg.stake;
const unitOf = leg => (!leg.currency || leg.currency === 'EUR' ? '€' : leg.currency);

// Stake boxes that are not inputs (Megawin): clicking opens an on-screen pad with keys 0-9, ".",
// backspace and confirm (the two icon keys, in that order). Clear, press the digits, confirm.
async function keypadStake(page, box, text) {
  await box.click();
  await sleep(600);
  const keys = await page.evaluateHandle(() => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const label = e => (e.children.length === 1 && e.children[0].tagName === 'SPAN' ? e.textContent.trim() : null);
    let pad = null; // smallest visible block holding every key
    for (const el of document.querySelectorAll('div')) {
      if (!vis(el)) continue;
      const have = new Set([...el.querySelectorAll('div')].map(label).filter(Boolean));
      if ('0123456789.'.split('').every(k => have.has(k)) && (!pad || pad.contains(el))) pad = el;
    }
    if (!pad) return null;
    const out = {}, icons = [];
    for (const e of pad.querySelectorAll('div')) {
      if (!vis(e) || e.children.length > 1) continue;
      const t = e.textContent.trim();
      if (/^[0-9.]$/.test(t) && label(e)) out[t] = e;
      else if (!t && e.children.length === 1 && e.children[0].tagName.toLowerCase() === 'svg') icons.push(e);
    }
    if (icons.length < 2) return null;
    out.back = icons[0]; out.ok = icons[1];
    return out;
  });
  if (!(await keys.evaluate(k => !!k).catch(() => false))) throw new Error('no number pad opened on the stake box');
  const press = async k => {
    const h = (await keys.getProperty(k)).asElement();
    if (!h) throw new Error(`number pad has no "${k}" key`);
    await h.click();
    await sleep(120);
  };
  for (let i = 0; i < 12 && /\d/.test(await box.evaluate(el => el.innerText)); i++) await press('back');
  for (const ch of text) await press(ch);
  await press('ok');
  await sleep(500);
}

async function typeStake(page, sel, leg, { keypad = false } = {}) {
  const box = await visible(page, sel);
  if (!box) throw new Error(`${leg.book}: no visible stake box on the slip`);
  const amount = amountOf(leg);
  if (keypad) {
    await keypadStake(page, box, String(amount)).catch(e => { throw new Error(`${leg.book}: ${e.message}`); });
    const shown = await box.evaluate(el => el.innerText);
    if (!stakeMatches(shown, amount)) throw new Error(`${leg.book}: stake box shows "${shown}", not ${amount}: not continuing`);
    return;
  }
  const current = await box.evaluate(el => el.value ?? el.innerText);
  await box.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.keyboard.press('KeyA');
  await page.keyboard.up(mod);
  await page.keyboard.press('Backspace');
  await page.keyboard.type(stakeText(amount, current), { delay: 40 });
  const shown = await box.evaluate(el => el.value ?? el.innerText);
  if (!stakeMatches(shown, amount)) throw new Error(`${leg.book}: stake box shows "${shown}", not ${amount}: not continuing`);
}

// Stake box still shows exactly the stake and the Place button is in the site's currency (€, or
// МКД on Megawin). Run after filling and again right before clicking Place.
async function verifySlip(page, S, leg) {
  const box = await visible(page, S.stakeInput);
  const shown = box ? await box.evaluate(el => el.value ?? el.innerText) : null;
  if (!stakeMatches(shown, amountOf(leg))) throw new Error(`${leg.book}: stake box now shows "${shown}", not ${amountOf(leg)}: not continuing`);
  const btn = await visible(page, S.placeButton);
  const label = btn ? await btn.evaluate(el => el.innerText).catch(() => '') : '';
  if (!btn || !placeLabelIn(label, leg.currency)) throw new Error(`${leg.book}: Place button shows "${String(label).trim()}", not a stake in ${unitOf(leg)}: not continuing`);
}

// Banners that cover the page on every load (Megawin's cookie notice): click their close (X)
// button, never an accept button. site.closePopups lists the close buttons' selectors. They can
// slide in seconds after the page loads, so this runs again before each click on the slip.
async function closePopups(page, site, waitMs = 0) {
  for (const sel of site.closePopups || []) {
    const x = waitMs ? await page.waitForSelector(sel, { visible: true, timeout: waitMs }).catch(() => null) : await visible(page, sel);
    if (x) { await x.click().catch(() => null); await sleep(600); }
  }
}

// Slips that collapse to a bar at the bottom of the page (Megawin): expand it when the stake box
// is not on screen. Not clicked when the slip is already open (the bar would collapse it).
async function openSlip(page, S) {
  if (!S.slipOpen) return;
  const onScreen = sel => page.$$eval(sel, els => els.some(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
  })).catch(() => false);
  // The bar slides in a moment after the pick: give it up to 4 s.
  for (let i = 0; i < 20; i++) {
    if (await onScreen(S.stakeInput)) return;
    if (await onScreen(S.slipOpen)) {
      const bar = await visible(page, S.slipOpen);
      if (bar) { await bar.click(); await sleep(1000); return; }
    }
    await sleep(200);
  }
}

// Slips with a unit switch (Chance "€ / G"): always click the part that reads "€" (a no-op when
// € is already on). The label is not read first: right after the slip opens it has no amount
// yet and looks like €. The euro check on the Place label after typing stays the guard.
async function ensureEuro(page, S) {
  await sleep(800);
  const toggle = await visible(page, S.euroToggle);
  if (!toggle) return;
  const eur = await toggle.evaluateHandle(t => [...t.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === '€') || null);
  if (eur.asElement() && (await eur.asElement().boundingBox())) {
    await eur.asElement().click();
    await sleep(800);
  }
}

// Sites draw the balance element first and fill in the amount a moment later: wait for a number.
// textContent, because some keep the balance in a collapsed panel where innerText is empty.
async function readBalance(page, sel, timeoutMs = 10000, cur = 'EUR') {
  const t0 = Date.now();
  for (;;) {
    const n = parseAmount(await page.$eval(sel, el => el.textContent).catch(() => ''), cur);
    if (n != null || Date.now() - t0 > timeoutMs) return n;
    await sleep(300);
  }
}

// Does the slip text name this match? Any word of 4+ letters from either team counts
// (books spell names a little differently: "Taliansko vs. Francúzsko" / "Taliansko - Francúzsko").
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function sameMatch(slipText, home, away) {
  const text = fold(slipText);
  const words = `${home} ${away}`.split(/[^A-Za-zÀ-ž0-9]+/).map(fold).filter(w => w.length >= 4 && !/^(team|klub|club|fc|united|city)$/.test(w));
  return words.length === 0 || words.some(w => text.includes(w));
}

async function slipPrices(page, sel) {
  const texts = await page.$$eval(sel, els => els.filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText)).catch(() => []);
  return texts.map(parsePrice).filter(n => n != null);
}

// The slip must hold exactly this one selection at (about) the scanned price. A price far
// ABOVE the scanned one means a different selection is on the slip, not a lucky move.
function checkSlip(prices, price, maxDropPct = 0) {
  if (!prices.length) return 'no selection on the bet slip after clicking the odds';
  if (prices.length > 1) return `the bet slip holds ${prices.length} selections, expected only this one`;
  const now = prices[0];
  if (now < price * (1 - (maxDropPct || 0) / 100)) return `slip odds ${now} below scanned ${price}`;
  if (now > price * 1.05) return `slip shows ${now}, not ${price}: a different selection is on the slip`;
  return null;
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
  // Stakes are planned in €; a book in another currency (Megawin: denars) gets the converted amount.
  leg.currency = site.currency || 'EUR';
  leg.local = localStake(leg.stake, leg.currency, settings.fx);
  // Sites render the header after domcontentloaded: wait for the marker before calling it logged out.
  if (S.loggedIn && !(await page.waitForSelector(S.loggedIn, { timeout: 15000 }).catch(() => null))) {
    throw new Error(`${leg.book}: not logged in in its Chrome window`);
  }
  if (!sites.calibrated(site)) {
    return { leg, page, site, ready: false, note: `opened ${url}; type stake ${leg.stake} on ${leg.sel} @ ${leg.price} yourself (site not calibrated)` };
  }
  await closePopups(page, site, 3000);

  // Balance check: this book must be able to cover its stake.
  leg.balance = null;
  if (S.balance) {
    leg.balance = await readBalance(page, S.balance, 10000, leg.currency);
    if (leg.balance != null && leg.balance < leg.local) {
      throw new Error(`${leg.book}: balance ${leg.balance} ${unitOf(leg)} is below the stake ${leg.local} ${unitOf(leg)}, top it up`);
    }
  }

  // A leftover selection would be bet together with this leg: the slip must start empty.
  if (S.slipOdds && (await slipPrices(page, S.slipOdds)).length) {
    throw new Error(`${leg.book}: the bet slip already holds a selection, clear it in that window first`);
  }

  // Click the odds cell whose text is the scanned price.
  await page.waitForSelector(S.oddsButton, { timeout: 15000 });
  const texts = priceTexts(leg.price);
  const handles = await page.$$(S.oddsButton);
  let target = null;
  for (const h of handles) {
    const t = (await h.evaluate(el => el.innerText || '')).trim();
    // Carousels keep clones far left/right of the page (Megawin's featured matches): skip those.
    if (!(await h.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }))) continue;
    // Sites keep hidden copies of markets: only a button with a box on screen can be clicked.
    // The price ends the button's text ("1\n1.59"), not just its digits: "2\n11.59" is not 1.59.
    if (texts.some(x => t === x || (t.endsWith(x) && !/[\d.,]/.test(t[t.length - x.length - 1]))) && (await h.boundingBox())) { target = h; break; }
  }
  if (!target) throw new Error(`${leg.book}: odds ${leg.price} not found on page (moved or wrong event)`);
  // A banner or popup over the button (Megawin's cookie notice) takes the click instead.
  await closePopups(page, site);
  await target.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  const cover = await target.evaluate(el => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !top || el.contains(top) || top.contains(el) ? null : (top.innerText || top.tagName).replace(/\s+/g, ' ').slice(0, 60);
  });
  if (cover) throw new Error(`${leg.book}: something covers the odds button ("${cover}"): close that banner or popup in its window`);
  await target.click();
  await sleep(500);
  await closePopups(page, site);
  await openSlip(page, S);

  // Hidden copies of the stake box exist before the slip opens: wait for a visible one.
  // Some sites ignore a click made before their slip has loaded (Megawin right after opening):
  // click once more, but only while the slip is still empty (a second click on a picked price
  // would remove it again).
  let box = await page.waitForSelector(S.stakeInput, { visible: true, timeout: 5000 }).catch(() => null);
  if (!box && S.slipOdds && !(await slipPrices(page, S.slipOdds)).length && (await target.boundingBox())) {
    await sleep(2000);
    await target.click();
    await sleep(500);
    await closePopups(page, site);
    await openSlip(page, S);
  }
  if (!box) await page.waitForSelector(S.stakeInput, { visible: true, timeout: 8000 });
  if (S.euroToggle) await ensureEuro(page, S);
  await closePopups(page, site);
  await typeStake(page, S.stakeInput, leg, { keypad: !!site.stakeKeypad });
  // Some slips switch units (Chance "€ / G" coins): "Staviť 1 G" would not bet euros.
  const placeBtn = await visible(page, S.placeButton);
  if (!placeBtn) throw new Error(`${leg.book}: no visible Place button on the slip`);
  const label = await placeBtn.evaluate(el => el.innerText).catch(() => '');
  if (!placeLabelIn(label, leg.currency)) throw new Error(`${leg.book}: the slip is not in ${unitOf(leg)} ("${label.trim()}"), switch it in that window`);

  if (S.slipOdds) {
    const prices = await slipPrices(page, S.slipOdds);
    const why = checkSlip(prices, leg.price, settings.maxOddsDropPct);
    if (why) throw new Error(`${leg.book}: ${why}`);
    leg.slipPrice = prices[0];
    // League pages list many matches and the same price can repeat: the slip must name this match.
    const slipText = await (await visible(page, S.slipOdds)).evaluate(el => {
      let n = el;
      for (let i = 0; i < 6 && n.parentElement && (n.innerText || '').length < 40; i++) n = n.parentElement;
      return n.innerText || '';
    });
    if (!sameMatch(slipText, sb.home, sb.away)) throw new Error(`${leg.book}: the slip shows "${slipText.replace(/\s+/g, ' ').slice(0, 60)}", not ${sb.home} - ${sb.away}`);
  }
  // Slips can re-render after typing (Chance's € switch reset 1 to its 10 € default): settle, re-check.
  await sleep(1500);
  await verifySlip(page, S, leg);
  const shownStake = leg.currency === 'EUR' ? `${leg.stake}` : `${leg.local} ${unitOf(leg)} (${leg.stake} €)`;
  return { leg, page, site, ready: true, note: `stake ${shownStake} on slip @ ${leg.slipPrice || leg.price}` };
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
  await verifySlip(p.page, S, p.leg); // last look: stake and currency label unchanged since filling
  const btn = await visible(p.page, S.placeButton);
  if (!btn) throw new Error(`${p.leg.book}: no visible Place button`);
  await btn.click();
  if (S.placedConfirm) {
    await p.page.waitForSelector(S.placedConfirm, { timeout: 20000 });
    return 'confirmed';
  }
  if (S.balance && p.leg.balance != null) {
    const read = async () => parseAmount(await p.page.$eval(S.balance, el => el.textContent), p.leg.currency);
    return (await waitForDrop(read, p.leg.balance, amountOf(p.leg))) ? 'confirmed' : 'unconfirmed';
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
        // Same reading as when filling: visible slip lines that hold a price (Megawin's first line
        // is the market name), and exactly one of them.
        const prices = await slipPrices(p.page, S.slipOdds);
        p.leg.slipPrice = prices.length === 1 ? prices[0] : 0;
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
    notify.send(settings, `Balances OK (${ok.map(p => `${p.leg.book} ${p.leg.balance} ${unitOf(p.leg)}`).join(', ')}), odds hold, placing all legs now: ${title}`).catch(() => { });
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

module.exports = { execute, prepareLeg, applyStakeCaps, stillProfitable, parseMoney, waitForDrop, placedStatus, stakeText, stakeMatches, checkSlip, sameMatch };
