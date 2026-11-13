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
const activeEvents = new Set(); // matches with a bet attempt running
const betEvents = new Set();    // matches where Place was clicked (placed, partial or unconfirmed)
const busyBooks = new Set();    // books whose betting tab is in use

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
  // Some boxes ignore select-all (Tipos' live slip keeps its "1,00"): select the input's own text,
  // then delete from the end until it is empty.
  const left = () => box.evaluate(el => String(el.value ?? el.innerText ?? '').trim());
  if (await left()) {
    await box.evaluate(el => { if (typeof el.select === 'function') el.select(); });
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 12 && (await left()); i++) { await page.keyboard.press('End'); await page.keyboard.press('Backspace'); }
  }
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
  // The site asks to accept changed odds: never accept, the surebet math no longer holds.
  if (S.acceptChanges && (await visible(page, S.acceptChanges))) throw new Error(`${leg.book}: the site asks to accept changed odds: not continuing`);
  const btn = await visible(page, S.placeButton);
  const label = btn ? await btn.evaluate(el => el.innerText).catch(() => '') : '';
  if (ACCEPT_RE.test(label)) throw new Error(`${leg.book}: Place button now says "${String(label).trim()}" (accept changes): not continuing`);
  if (!btn || !placeLabelIn(label, leg.currency)) throw new Error(`${leg.book}: Place button shows "${String(label).trim()}", not a stake in ${unitOf(leg)}: not continuing`);
  // The slip refuses this pick as a single bet (Niké lower leagues: "Zápasy na tikete vyžadujú počet
  // tipov najmenej 3"): Place would do nothing. Checked while filling, so no other leg is placed.
  const slipText = await btn.evaluate(el => {
    let n = el;
    for (let i = 0; i < 10 && n.parentElement && (n.innerText || '').length < 600; i++) n = n.parentElement;
    return n.innerText || '';
  }).catch(() => '');
  const block = SLIP_BLOCK_RE.exec(slipText);
  if (block) throw new Error(`${leg.book}: the slip refuses this bet ("${slipText.slice(Math.max(0, block.index - 40), block.index + 40).replace(/\s+/g, ' ').trim()}"): not continuing`);
}
// Slip messages that mean "this ticket cannot be placed as it is" (min. picks, combination rules).
const SLIP_BLOCK_RE = /najmenej \d|minim[aá]ln[eyi]+ \d+ tip|vy[zž]aduj[uú] po[cč]et|nemo[zž]no kombin|mindestens \d|at least \d (selection|pick)/i;
// "Änderungen annehmen" (bet365 DE), "Accept changes", "Prijať zmeny" / "Potvrdiť zmeny" (SK books)
const ACCEPT_RE = /annehmen|akzeptieren|accept|prija[tť]|potvrdi[tť] zmen/i;

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

// Finds and clicks the odds button showing leg.price. When the same price sits on several
// matches (bet365 coupon pages), the button inside the fixture naming this match wins.
async function priceButton(page, site, leg, names) {
  const S = site.selectors;
  await page.waitForSelector(S.oddsButton, { timeout: 15000 });
  // site.matchScope: the block that holds only this match's odds (Tipos / Synottip match pages also
  // list other live matches, and one of those once had the same price: the wrong match was clicked).
  const scope = site.matchScope && (await page.$(site.matchScope)) ? site.matchScope + ' ' : '';
  const texts = priceTexts(leg.price);
  const found = [];
  const offScreen = []; // matching price, but scrolled away in a carousel
  const onScreen = h => h.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
  for (const h of await page.$$(S.oddsButton.split(',').map(x => scope + x.trim()).join(', '))) {
    const t = (await h.evaluate(el => el.innerText || '')).trim();
    // The price ends the button's text ("1\n1.59"), not just its digits: "2\n11.59" is not 1.59.
    if (!texts.some(x => t === x || (t.endsWith(x) && !/[\d.,]/.test(t[t.length - x.length - 1])))) continue;
    // A handicap / total cell (its line label is filled in) is never the match result.
    if (site.oddsLine && (await h.evaluate((el, sel) => !!(el.parentElement && (el.parentElement.querySelector(sel)?.textContent || '').trim()), site.oddsLine))) continue;
    // Sites keep hidden copies of markets: only a button with a box on screen can be clicked.
    if (!(await h.boundingBox())) continue;
    // Carousels keep slides (and clones) far left/right of the page (Megawin's featured matches).
    if (!(await onScreen(h))) { offScreen.push(h); continue; }
    found.push(h);
  }
  // scrollCarousel: a slide that is scrolled away is brought into view, but only one whose row
  // names this match.
  if (!found.length && site.scrollCarousel) {
    for (const h of offScreen) {
      const row = await h.evaluate(el => { let n = el; for (let i = 0; i < 8 && n.parentElement && (n.innerText || '').length < 60; i++) n = n.parentElement; return n.innerText || ''; });
      if (!names.some(([hm, aw]) => sameMatch(row, hm, aw))) continue;
      await h.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await sleep(800);
      if (await onScreen(h)) { found.push(h); break; }
    }
  }
  if (!found.length) throw new Error(`${leg.book}: odds ${leg.price} not found on page (moved or wrong event)`);
  let target = found[0];
  if (found.length > 1) {
    for (const h of found) {
      // Blocks around the button up to about one fixture row: does one of them name this match?
      const around = await h.evaluate(el => {
        const out = [];
        for (let n = el.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
          const t = n.innerText || '';
          if (t.length > 400) break;
          out.push(t);
        }
        return out;
      });
      if (around.some(t => names.some(([hm, aw]) => sameMatch(t, hm, aw)))) { target = h; break; }
    }
  }
  return target;
}

// Markets other than 1X2 / double chance are clicked by market and label, never by price alone (a
// match page lists dozens of markets and a price repeats). site.marketUI says where they are:
//   { tabs, game, button }: market tabs, one block per market (its first line is the market name),
//   the odds buttons inside it ("Nad (2.5) 1,76"). Tipos and Synottip share this page layout.
const sgn = x => `${x > 0 ? '+' : ''}${x}`;
const MARKET_UI = {
  dnb: (sb, l) => ({ game: ['Stávka bez remízy'], label: l.sel }),
  totals: (sb, l) => ({ game: ['Celkový počet gólov', 'Celkový počet bodov'], label: `${l.sel === 'O' ? 'Nad' : 'Pod'} (${sb.point})` }),
  '1h_totals': (sb, l) => ({ game: ['1. polčas - Počet gólov'], label: `${l.sel === 'O' ? 'Nad' : 'Pod'} (${sb.point})` }),
  ot_totals: (sb, l) => ({ game: ['Počet gólov (vrátane predĺženia a nájazdov)'], label: `${l.sel === 'O' ? 'Nad' : 'Pod'} (${sb.point})` }),
  btts: (sb, l) => ({ game: ['Obaja dajú gól'], label: l.sel === 'Y' ? 'Áno' : 'Nie' }),
  // team goals: Tipos names the block after the team ("Moldavsko celkový počet gólov"), Synottip "Tím1 ..."
  home_totals: (sb, l) => ({ game: [`${l.home} celkový počet gólov`, 'Tím1 celkový počet gólov'], label: `${l.sel === 'O' ? 'Nad' : 'Pod'} (${sb.point})` }),
  away_totals: (sb, l) => ({ game: [`${l.away} celkový počet gólov`, 'Tím2 celkový počet gólov'], label: `${l.sel === 'O' ? 'Nad' : 'Pod'} (${sb.point})` }),
  spreads: (sb, l) => ({ game: ['Handicap'], label: l.sel === 'H' ? `Tím 1 (${sgn(sb.point)})` : `Tím 2 (${sgn(-sb.point)})` }),
  ot_spreads: (sb, l) => ({ game: ['Handicap (vrátane predĺženia a nájazdov)'], label: l.sel === 'H' ? `Tím 1 (${sgn(sb.point)})` : `Tím 2 (${sgn(-sb.point)})` }),
};

// The pick as the book itself names it (a match listed the other way round at this book has its
// sides swapped in the surebet: its own "Tím 2" is the surebet's "H").
const bookView = (sb, leg) => (leg.swapped ? [{ ...sb, point: leg.bookPoint, market: sb.market.replace(/^(home|away)_/, m => (m === 'home_' ? 'away_' : 'home_')) }, { ...leg, sel: leg.bookSel }] : [sb, leg]);

async function marketButton(page, site, sbIn, legIn) {
  const ui = site.marketUI;
  const [sb, leg] = bookView(sbIn, legIn);
  const spec = ui && MARKET_UI[sb.market] && MARKET_UI[sb.market](sb, leg);
  if (!spec) throw new Error(`${leg.book}: betting the ${sb.market} market is not set up for this site`);
  await page.waitForSelector(ui.game, { timeout: 15000 });
  const texts = priceTexts(leg.price);
  const find = () => page.evaluateHandle((ui, spec) => {
    for (const g of document.querySelectorAll(ui.game)) {
      if (!(g.getBoundingClientRect().width > 0)) continue;
      if (!spec.game.includes((g.innerText || '').split('\n')[0].trim())) continue;
      for (const b of g.querySelectorAll(ui.button)) {
        const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
        if (t === spec.label || t.startsWith(spec.label + ' ')) return b;
      }
    }
    return null;
  }, ui, spec);
  let h = await find();
  // Not on the first tab: open the market tabs one by one (view only).
  if (!(await h.evaluate(x => !!x)) && ui.tabs) {
    for (const tab of await page.$$(ui.tabs)) {
      await tab.click().catch(() => { });
      await sleep(1200);
      h = await find();
      if (await h.evaluate(x => !!x)) break;
    }
  }
  if (!(await h.evaluate(x => !!x))) throw new Error(`${leg.book}: market "${spec.game[0]}" / "${spec.label}" not found on the match page`);
  const btn = h.asElement();
  const t = (await btn.evaluate(el => el.innerText || '')).replace(/\s+/g, ' ').trim();
  if (!texts.some(x => t.endsWith(' ' + x))) throw new Error(`${leg.book}: "${spec.label}" shows "${t}", not ${leg.price} (odds moved)`);
  return btn;
}

// A price read from a match detail knows its own button (leg.pick = { css, label? }): Niké's market
// row + label, DOXXbet's .Odd_<id>, Tipsport/Chance's [data-id=<id>]. That exact button is clicked,
// after checking it is visible, shows the label and ends with the price. Its label (button text without
// the price) is kept in leg.pickText: the slip must show it too.
async function pickButton(page, site, leg) {
  const { css, label } = leg.pick;
  await page.waitForSelector(css, { timeout: 15000 }).catch(() => null);
  const texts = priceTexts(leg.price);
  const norm = t => String(t || '').replace(/\s+/g, ' ').trim();
  for (const h of await page.$$(css)) {
    const t = norm(await h.evaluate(el => el.innerText || ''));
    if (label && !t.toLowerCase().includes(label.toLowerCase())) continue;
    await h.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => { });
    if (!(await h.boundingBox())) continue;
    const price = texts.find(x => t === x || t.endsWith(' ' + x) || t.startsWith(x + ' '));
    if (!price) throw new Error(`${leg.book}: the button shows "${t}", not ${leg.price} (odds moved)`);
    leg.pickText = norm(t.replace(price, '')) || label || null;
    return h;
  }
  throw new Error(`${leg.book}: the market button for this pick is not on the match page (${label || css})`);
}

async function clickOdds(page, site, leg, names, sb) {
  const S = site.selectors;
  const target = leg.pick ? await pickButton(page, site, leg)
    : sb && sb.market && sb.market !== 'h2h' ? await marketButton(page, site, sb, leg) : await priceButton(page, site, leg, names);
  // A banner or popup over the button (Megawin's cookie notice) takes the click instead.
  await closePopups(page, site);
  await target.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  // What sits on top of the button: null (nothing), or { text, header } where header = it belongs to
  // a fixed/sticky bar (the site's own top menu), not a popup.
  const coverOf = () => target.evaluate(el => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || el.contains(top) || top.contains(el)) return null;
    let header = false;
    for (let n = top; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') { header = n.getBoundingClientRect().top <= 5; break; }
    }
    return { text: (top.innerText || top.tagName).replace(/\s+/g, ' ').slice(0, 60), header };
  });
  let cover = await coverOf();
  // A row right at the top of a short page stays under the site's fixed top menu (DOXXbet live):
  // scroll a bit more, and if the menu still covers it, click the button itself.
  if (cover && cover.header) {
    await page.evaluate(() => window.scrollBy(0, -200));
    await sleep(300);
    cover = await coverOf();
  }
  if (cover && !cover.header) throw new Error(`${leg.book}: something covers the odds button ("${cover.text}"): close that banner or popup in its window`);
  if (cover) await target.evaluate(el => el.click());
  else await target.click();
  await sleep(site.slipError ? 2000 : 500);
  await closePopups(page, site);
  await openSlip(page, S);
  return target;
}

// Take a pick back off the slip by clicking its odds button again (sites toggle a picked price).
// Returns true when the slip is empty afterwards; logs when it is not, so it can be cleared by hand.
async function unpick(page, S, target, book) {
  try {
    if (!S.slipOdds || !(await slipPrices(page, S.slipOdds)).length) return true;
    if (target && (await target.boundingBox())) {
      await target.click();
      await sleep(1500);
      if (!(await slipPrices(page, S.slipOdds)).length) return true;
    }
  } catch { }
  db.log('warn', `${book}: could not clear the bet slip, clear it by hand in that window`);
  return false;
}

// Prepare one leg up to (not including) the Place click.
async function prepareLeg(settings, sb, leg) {
  // Cross-market surebet: each leg has its own market (DNB, double chance, OT winner).
  if (leg.market) sb = { ...sb, market: leg.market, point: leg.point ?? null };
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
    // Bet365 keeps its balance box in the slip even when logged out: no amount means no session.
    if (leg.balance == null && site.balanceRequired) throw new Error(`${leg.book}: no balance shown, log in in its Chrome window`);
    if (leg.balance != null && leg.balance < leg.local) {
      throw new Error(`${leg.book}: balance ${leg.balance} ${unitOf(leg)} is below the stake ${leg.local} ${unitOf(leg)}, top it up`);
    }
  }

  // A leftover selection would be bet together with this leg: the slip must start empty.
  if (S.slipOdds && (await slipPrices(page, S.slipOdds)).length) {
    throw new Error(`${leg.book}: the bet slip already holds a selection, clear it in that window first`);
  }

  // From the first click on, a leg that stops must not leave its pick on the slip: the next
  // surebet at this book would refuse to start ("already holds a selection").
  const names = [[sb.home, sb.away], [leg.home, leg.away]].filter(([h, a]) => h && a);
  let target = null;
  try {
    // Click the odds cell whose text is the scanned price.
    target = await clickOdds(page, site, leg, names, sb);
    // Bet365 sometimes answers a pick with "Entschuldigung, es ist ein Fehler aufgetreten" and keeps
    // the slip empty; a hard refresh (cache bypassed) fixes it. One refresh and one more click.
    if (site.slipError && (await visible(page, site.slipError))) {
      if (S.slipOdds && (await slipPrices(page, S.slipOdds)).length) throw new Error(`${leg.book}: the site showed an error after the pick, check the slip in that window`);
      const cdp = await page.target().createCDPSession();
      await cdp.send('Page.reload', { ignoreCache: true });
      await cdp.detach().catch(() => { });
      await sleep(8000);
      await closePopups(page, site);
      target = await clickOdds(page, site, leg, names, sb);
      if (await visible(page, site.slipError)) throw new Error(`${leg.book}: the site rejected the pick twice ("${(await (await visible(page, site.slipError)).evaluate(el => el.innerText)).trim().slice(0, 60)}")`);
    }

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
      // Read around the slip line that holds the price: live pages (Tipsport, Chance) reuse the slip's
      // class for labels like "Kurzy nie sú aktuálne", and the first match can be one of those.
      const slipText = await page.$$eval(S.slipOdds, els => {
        const line = els.find(e => e.getBoundingClientRect().width > 0 && /^\s*\d{1,3}[.,]\d{1,3}\s*$/.test(e.innerText || '')) || els.find(e => e.getBoundingClientRect().width > 0);
        let n = line;
        for (let i = 0; n && i < 6 && n.parentElement && (n.innerText || '').length < 40; i++) n = n.parentElement;
        return (n && n.innerText) || '';
      });
      if (!names.some(([h, a]) => sameMatch(slipText, h, a))) throw new Error(`${leg.book}: the slip shows "${slipText.replace(/\s+/g, ' ').slice(0, 60)}", not ${sb.home} - ${sb.away}`);
      // Other markets: the slip must also name the market and the pick ("Celkový počet gólov Tip: Nad (2.5)").
      if (leg.pick && leg.pickText) {
        const flat = slipText.replace(/\s+/g, ' ').toLowerCase();
        // Slips word picks their own way (DOXXbet: button "Menej ako 0.5", slip "Počet gólov 0.5 ... Menej"):
        // the whole label, or its first word plus every number in it, must be on the slip.
        const lbl = leg.pickText.toLowerCase();
        const nums = lbl.match(/\d+(?:[.,]\d+)?/g) || [];
        const ok = flat.includes(lbl) || (flat.includes(lbl.split(' ')[0]) && nums.every(n => flat.includes(n) || flat.includes(n.replace('.', ','))));
        if (!ok) throw new Error(`${leg.book}: the slip shows "${slipText.replace(/\s+/g, ' ').slice(0, 80)}", not "${leg.pickText}"`);
      } else if (sb.market && sb.market !== 'h2h' && MARKET_UI[sb.market]) {
        const [bsb, bleg] = bookView(sb, leg);
        const spec = MARKET_UI[bsb.market](bsb, bleg);
        const flat = slipText.replace(/\s+/g, ' ');
        if (!spec.game.some(g => flat.includes(g)) || !flat.includes(spec.label)) throw new Error(`${leg.book}: the slip shows "${flat.slice(0, 80)}", not ${spec.game[0]} / ${spec.label}`);
      }
    }
    // Slips can re-render after typing (Chance's € switch reset 1 to its 10 € default): settle, re-check.
    await sleep(1500);
    await verifySlip(page, S, leg);
    const shownStake = leg.currency === 'EUR' ? `${leg.stake}` : `${leg.local} ${unitOf(leg)} (${leg.stake} €)`;
    return { leg, page, site, target, ready: true, note: `stake ${shownStake} on slip @ ${leg.slipPrice || leg.price}` };
  } catch (e) {
    await unpick(page, S, target, leg.book);
    throw e;
  }
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
async function placeLeg(p, { verified = false } = {}) {
  const S = p.site.selectors;
  if (!verified) await verifySlip(p.page, S, p.leg); // last look: stake and currency label unchanged since filling
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

// Minimum profit for a bet: live odds move within seconds, so live surebets need more margin.
const minPct = (settings, live) => (live ? Number(settings.autoLiveMinProfitPct ?? 4) : Number(settings.autoMinProfitPct));

// Is a new surebet worth betting at all, in fill or auto mode? (null = yes)
function betAllowed(settings, sb) {
  const min = minPct(settings, sb.live);
  if (sb.profitPct < min) return `profit ${sb.profitPct}% < ${min}%${sb.live ? ' (live)' : ''}`;
  // Markets other than 1X2 / double chance: only where clicking that market is set up and tested.
  {
    const all = sites.load();
    const mk = l => l.market || sb.market;
    const no = (sb.legs || []).filter(l => mk(l) && mk(l) !== 'h2h' && !l.pick && !((all[l.book] && all[l.book].betMarkets) || []).includes(mk(l))).map(l => `${mk(l)} at ${l.book}`);
    if (no.length) return `betting not set up: ${[...new Set(no)].join(', ')}`;
  }
  // Suspect = one price far above the other books. With autoBetSuspect it is still bet: the price
  // actually shown on every slip is re-checked against the minimum before Place.
  if (sb.flipped) return 'the books disagree who the favourite is (likely two different teams): never bet';
  // Two legs at one bookmaker (Tipsport 1 + Tipsport X) are one ticket on its slip, not two bets,
  // and they fight over the same betting tab: never auto-bet (2026-11-13, a timed-out attempt).
  if (sb.legs && new Set(sb.legs.map(l => l.book)).size < sb.legs.length) return 'two legs at the same bookmaker (one ticket, not separate bets)';
  if (sb.suspect && !settings.autoBetSuspect) return 'suspect: a price is far above the other books (likely stale)';
  if (settings.autoPrematchOnly && sb.live) return 'live: pre-match only';
  return null;
}

function autoAllowed(settings, sb) {
  const why = betAllowed(settings, sb);
  if (why) return why;
  if (sb.staked > settings.autoMaxStakeTotal) return `stake ${sb.staked} > max ${settings.autoMaxStakeTotal}`;
  if (db.autoBetsToday() >= settings.autoDailyMaxBets) return 'daily auto-bet limit reached';
  return null;
}

// Live auto bets use their own, smaller total: at most autoLiveMaxStakeTotal (default 2) per surebet,
// in 0.10 steps (0.50 min a leg), so a few euros prove the live path before it gets more money (best split, see arb).
function liveStakes(settings, sb) {
  if (!sb.live) return { sb };
  const total = Number(settings.autoLiveMaxStakeTotal ?? 2);
  if (!(total > 0) || sb.staked <= total) return { sb };
  const arb = require('../arb');
  const st = arb.bestSplit(sb.legs.map(l => l.price), total, arb.SMALL_STEP, arb.SMALL_MIN_LEG);
  if (!(st.worstProfit > 1e-9)) return { error: `live max ${total} per surebet: no split locks in a profit at these prices` };
  const legs = sb.legs.map((l, j) => ({ ...l, stake: st.stakes[j] }));
  return { sb: { ...sb, legs, staked: st.staked, worstProfit: Math.round(st.worstProfit * 100) / 100 } };
}

// Per-bookmaker cap on ONE bet (settings.bookmakers.<book>.maxStakePerBet, in your currency).
// If any leg is above its book's cap, ALL legs are scaled down by the same factor so the
// surebet stays balanced. Returns the (possibly scaled) surebet, or { error }.
function capOf(settings, book) {
  const bk = settings.bookmakers[book] || {};
  // Percentage of the bankroll you keep at this book wins; else the fixed per-bet cap.
  // The live balance (read from the logged-in window) replaces the typed-in bankroll.
  const bankroll = balances.fresh(book) ?? Number(bk.bankroll);
  const pct = bankroll > 0 && Number(bk.stakePercent) > 0 ? bankroll * Number(bk.stakePercent) / 100 : 0;
  const cap = pct || Number(bk.maxStakePerBet);
  // Never more than the book holds right now (live balance): the surebet is re-split smaller instead
  // of one leg stopping with "balance below the stake" (DOXXbet 18.90 EUR vs a 20 EUR leg, 2026-11-13).
  const live = balances.fresh(book);
  return live != null && live > 0 && cap > 0 ? Math.min(cap, Math.floor(live * 10) / 10) : cap;
}

function applyStakeCaps(settings, sb) {
  let factor = 1;
  for (const l of sb.legs) {
    const cap = capOf(settings, l.book);
    if (!(cap > 0)) return { error: `${l.book}: set bankroll + stake % (or a max stake per bet) for auto` };
    factor = Math.min(factor, cap / l.stake);
  }
  if (factor >= 1) return { sb };
  // Re-split a smaller total (best split, see arb) until every leg fits its book's cap.
  const arb = require('../arb');
  const caps = sb.legs.map(l => capOf(settings, l.book));
  const prices = sb.legs.map(l => l.price);
  const small = sb.staked * factor < 30;
  const step = small ? arb.SMALL_STEP : (settings.roundStakeTo || 1);
  for (let total = Math.floor(sb.staked * factor / step + 1e-9) * step; total > 0; total = Math.round((total - step) * 100) / 100) {
    const st = small ? arb.bestSplit(prices, total, step, arb.SMALL_MIN_LEG) : arb.bestSplit(prices, total, step);
    if (!(st.worstProfit > 1e-9)) continue;
    if (st.stakes.some((x, i) => x > caps[i] + 1e-9)) continue;
    const legs = sb.legs.map((l, i) => ({ ...l, stake: st.stakes[i] }));
    return { sb: { ...sb, legs, staked: st.staked, worstProfit: Math.round(st.worstProfit * 100) / 100 } };
  }
  return { error: 'after stake caps and rounding the surebet no longer locks in a profit' };
}

// Last check before clicking Place: with the odds actually shown on each slip and the real stakes,
// is it still a surebet with the full minimum profit (autoMinProfitPct, live: autoLiveMinProfitPct)?
function stillProfitable(settings, legs, live = false) {
  if (legs.some(l => l.slipPrice === 0)) return { ok: false, pct: 0 }; // a slip price could not be read
  const staked = legs.reduce((a, l) => a + l.stake, 0);
  const worst = Math.min(...legs.map(l => l.stake * (l.slipPrice || l.price))) - staked;
  const pct = worst / staked * 100;
  return { ok: pct >= minPct(settings, live), pct: Math.round(pct * 100) / 100 };
}

// Re-read the price on every filled slip (exactly one priced line, else 0 = unreadable).
async function readSlips(ok) {
  await Promise.all(ok.map(async p => {
    const S = p.site.selectors;
    if (S.slipOdds) {
      // Same reading as when filling: visible slip lines that hold a price (Megawin's first line
      // is the market name), and exactly one of them.
      const prices = await slipPrices(p.page, S.slipOdds);
      p.leg.slipPrice = prices.length === 1 ? prices[0] : 0;
    }
  }));
}

const legLine = p => `${p.leg.book}: ${p.leg.sel} @ ${p.leg.slipPrice || p.leg.price}${p.leg.slipPrice && p.leg.slipPrice !== p.leg.price ? ` (scan ${p.leg.price})` : ''}, stake ${p.leg.stake} ${unitOf(p.leg)}`;

async function execute(settings, sb, { mode = settings.betMode, manual = false } = {}) {
  if (mode === 'off') return { status: 'skipped', detail: 'betMode off' };
  if (inFlight.has(sb.key)) return { status: 'skipped', detail: 'already running' };
  if (mode === 'auto' && !manual) {
    let why = autoAllowed(settings, sb);
    if (!why) {
      const small = liveStakes(settings, sb);
      const capped = small.error ? small : applyStakeCaps(settings, small.sb);
      if (capped.error) why = capped.error; else sb = capped.sb;
    }
    // No fallback to fill: nobody is waiting to click Place, and a filled slip left behind would
    // block the next surebet at that book.
    if (why) {
      db.log('info', `auto skipped ${sb.home}-${sb.away}: ${why}`);
      return { status: 'skipped', detail: why };
    }
  }
  // One match, one bet: a sibling surebet of a match that is being bet (or was bet) is skipped:
  // it would double the exposure on that match and fight over the same betting tabs.
  const ev = sb.eventId || sb.key.split('|')[0];
  if (activeEvents.has(ev)) return { status: 'skipped', detail: 'another bet on this match is running' };
  // also for the dashboard's Open button: a match already bet is never filled again (it doubles the position)
  if (betEvents.has(ev) || db.eventBets(ev).placed) return { status: 'skipped', detail: 'this match was already bet: not filled again (that would double the position)' };
  activeEvents.add(ev);
  // Every book has one betting tab: a leg waits (up to 90 s) until no other bet uses that book.
  const books = [...new Set(sb.legs.map(l => l.book))];
  for (const t0 = Date.now(); books.some(b => busyBooks.has(b)); ) {
    if (Date.now() - t0 > 90000) { activeEvents.delete(ev); return { status: 'skipped', detail: 'bookmaker busy with another bet' }; }
    await sleep(500);
  }
  books.forEach(b => busyBooks.add(b));
  inFlight.add(sb.key);
  const betId = db.addBet(sb.key, mode, 'pending', '');
  const title = `${sb.home} - ${sb.away} (${marketLabel(sb)}, +${sb.profitPct}%)`;
  try {
    // Every leg in its own book's window, in parallel.
    const results = await Promise.allSettled(sb.legs.map(l => prepareLeg(settings, sb, { ...l })));
    const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errs = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    const notes = ok.map(p => `${p.leg.book}: ${p.note}`).concat(errs.map(e => `ERR ${e}`)).join(' | ');

    // An auto attempt that stops after filling takes every pick back off its slip; whatever cannot
    // be cleared is reported, because it blocks the next bet at that book.
    const clearAll = async () => {
      if (mode !== 'auto') return;
      const stuck = [];
      for (const p of ok) if (!(await unpick(p.page, p.site.selectors, p.target, p.leg.book))) stuck.push(p.leg.book);
      if (stuck.length) notify.send(settings, `Clear the bet slip by hand at ${stuck.join(', ')} (an auto bet stopped before Place: ${title})`).catch(() => { });
    };
    // alertsOnlyBets: Telegram gets only bets you can place now and bets that were placed.
    const quiet = settings.alertsOnlyBets;
    const allReady = errs.length === 0 && ok.every(p => p.ready);
    if (!allReady) {
      const status = errs.length ? 'failed' : 'filled';
      db.setBet(betId, status, notes);
      db.log(errs.length ? 'warn' : 'info', `[${mode}] ${title}: ${notes}`);
      if (!quiet) notify.send(settings, `${status === 'filled' ? 'Ready, confirm in the windows' : 'Could not prepare'}: ${title}\n${notes}`).catch(() => { });
      await clearAll();
      return { status, detail: notes };
    }

    // Every slip is filled: re-read the odds on EVERY slip and recompute the profit with the real
    // stakes. Below autoMinProfitPct nothing is placed (auto) or you are told not to place (fill).
    await readSlips(ok);
    const chk = stillProfitable(settings, ok.map(p => p.leg), !!sb.live);
    const legs = ok.map(legLine).join('\n');
    if (!chk.ok) {
      const detail = `odds changed on the slips, profit now ${chk.pct}% < ${minPct(settings, sb.live)}%: not placed. ${notes}`;
      db.setBet(betId, 'failed', detail);
      db.log('warn', `[${mode}] ${title}: ${detail}`);
      // In fill mode the slips sit in the windows, so say so even when quiet.
      if (mode !== 'auto') notify.send(settings, `DO NOT PLACE (odds changed, profit now ${chk.pct}%): ${title}\n${legs}`).catch(() => { });
      else if (!quiet) notify.send(settings, `Not placed (odds changed): ${title}\n${detail}`).catch(() => { });
      await clearAll();
      return { status: 'failed', detail };
    }
    if (mode !== 'auto') {
      db.setBet(betId, 'filled', `rechecked ${chk.pct}% | ${notes}`);
      db.log('info', `[${mode}] ${title}: rechecked ${chk.pct}% | ${notes}`);
      notify.send(settings, `Ready to place, rechecked +${chk.pct}%: ${title}\n${legs}\nCheck each slip and click Place in every window.`).catch(() => { });
      return { status: 'filled', detail: notes };
    }

    // Auto = all or nothing. Every leg must have a known balance that covers its stake.
    const noBal = ok.filter(p => p.leg.balance == null).map(p => p.leg.book);
    if (noBal.length) {
      const detail = `cannot read the balance at ${noBal.join(', ')} (set the balance selector): not placed. ${notes}`;
      db.setBet(betId, 'failed', detail);
      if (!quiet) notify.send(settings, `Not placed: ${title}\n${detail}`).catch(() => { });
      await clearAll();
      return { status: 'failed', detail };
    }
    if (!quiet) notify.send(settings, `Balances OK (${ok.map(p => `${p.leg.book} ${p.leg.balance} ${unitOf(p.leg)}`).join(', ')}), odds hold (+${chk.pct}%), placing all legs now: ${title}`).catch(() => { });
    // One leg at a time, the least proven book first: if a leg is not confirmed, the rest are NOT
    // placed (their picks are taken off), so a site that refuses a bet costs nothing when it goes
    // first. Before each next leg its slip is read again; it is placed only if the whole surebet
    // still loses at most COMPLETE_MAX_LOSS_PCT (completing beats holding an open position).
    const order = [...ok].sort((a, b) => provenCount(a.leg.book) - provenCount(b.leg.book));
    const legResult = new Map(); // p -> 'confirmed' | 'unconfirmed' | Error | 'skipped'
    // LIVE: odds move in seconds, so one leg after another leaves half bets. Every slip is read again
    // at the same moment and checked in the same moment (stake, currency, no "accept changes"); only
    // if the surebet still makes the live minimum on those slip prices are ALL Place buttons clicked
    // together. Otherwise nothing is placed and every pick comes off.
    if (sb.live) {
      await readSlips(ok);
      const last = stillProfitable(settings, ok.map(p => p.leg), true);
      const checks = await Promise.allSettled(ok.map(p => verifySlip(p.page, p.site.selectors, p.leg)));
      const bad = checks.map((r, i) => (r.status === 'rejected' ? `${ok[i].leg.book}: ${r.reason.message}` : null)).filter(Boolean);
      if (!last.ok || bad.length) {
        const detail = `live, last joint check failed (${!last.ok ? `profit on the slips ${last.pct}% < ${minPct(settings, true)}%` : bad.join(' | ')}): nothing placed. ${ok.map(legLine).join(' | ')}`;
        db.setBet(betId, 'failed', detail);
        db.log('warn', `[auto] ${title}: ${detail}`);
        await clearAll();
        return { status: 'failed', detail };
      }
      const clicks = await Promise.allSettled(ok.map(p => placeLeg(p, { verified: true })));
      ok.forEach((p, i) => legResult.set(p, clicks[i].status === 'fulfilled' ? clicks[i].value : clicks[i].reason));
    }
    for (const p of sb.live ? [] : order) {
      const done = order.filter(q => legResult.get(q) === 'confirmed');
      if (done.length) {
        await readSlips([p]);
        const legsNow = order.map(q => q.leg);
        const pct = worstPct(legsNow);
        if (!(p.leg.slipPrice > 0) || pct < -COMPLETE_MAX_LOSS_PCT) { legResult.set(p, new Error(`odds on its slip moved too far (${p.leg.slipPrice || '?'}, surebet now ${pct}%)`)); break; }
      }
      try { legResult.set(p, await placeLeg(p)); } catch (e) { legResult.set(p, e); }
      if (legResult.get(p) !== 'confirmed') break;
    }
    for (const p of order) if (!legResult.has(p)) {
      legResult.set(p, 'skipped');
      await unpick(p.page, p.site.selectors, p.target, p.leg.book);
    }
    const res = ok.map(p => legResult.get(p));
    const anyClicked = res.some(r => r === 'confirmed' || r === 'unconfirmed');
    const status = anyClicked ? placedStatus(res.map(r => (r === 'confirmed' || r === 'unconfirmed' ? r : 'failed'))) : 'failed';
    if (anyClicked) betEvents.add(ev); // Place was clicked on this match: no second bet on it
    // What was bet, for the overview (open bets, their payout and locked profit).
    if (anyClicked) db.setBetLegs(betId, { home: sb.home, away: sb.away, start: sb.start, market: sb.market, point: sb.point ?? null, live: !!sb.live,
      legs: ok.map((p, i) => ({ book: p.leg.book, sel: p.leg.sel, price: p.leg.slipPrice || p.leg.price, stake: p.leg.stake, placed: res[i] === 'confirmed' })) });
    const detail = ok.map((p, i) => `${p.leg.book}: ${res[i] === 'confirmed' ? 'PLACED' : res[i] === 'unconfirmed' ? 'CLICKED, NOT CONFIRMED' : res[i] === 'skipped' ? 'not placed (an earlier leg failed)' : 'FAILED ' + res[i].message}`).join(' | ');
    db.setBet(betId, status, detail);
    db.log(status === 'placed' ? 'info' : 'error', `[auto] ${title}: ${detail}`);
    const head = {
      placed: 'Placed',
      partial: 'WARNING: only part of the bet was placed, you hold an open position!',
      unconfirmed: 'CHECK NOW: Place was clicked but not every leg is confirmed. Look at the bet history in each window.',
      failed: 'Not placed (nothing was bet)',
    }[status];
    // An open position: work out how to cover it from the latest scan (best price elsewhere).
    let cover = '';
    if (status === 'partial' || status === 'unconfirmed') {
      const held = ok.filter((p, i) => res[i] === 'confirmed').map(p => p.leg);
      const missing = ok.filter((p, i) => res[i] !== 'confirmed').map(p => p.leg);
      const c = coverPlan(sb, held, missing, ok.filter((p, i) => res[i] !== 'confirmed').map(p => p.leg.book));
      cover = c ? `\nTO COVER IT: ${c.text}` : '\nNo cover found in the latest scan: check the other books by hand.';
      db.log('warn', `cover ${title}: ${cover.trim()}`);
    }
    if (status !== 'failed' || !quiet) notify.send(settings, `${head}\n${title}\n${legs}\n${detail}${cover}`).catch(() => { });
    balances.refreshAll(settings).catch(() => { });
    return { status, detail };
  } catch (e) {
    db.setBet(betId, 'failed', e.message);
    db.log('error', `bet ${title}: ${e.message}`);
    return { status: 'failed', detail: e.message };
  } finally {
    inFlight.delete(sb.key);
    activeEvents.delete(ev);
    // A match page (live ones above all) keeps growing in memory: the betting tab goes back to a
    // blank page once the attempt is over. Slips are kept by the site, not by the page.
    for (const b of books) {
      const port = settings.bookmakers[b] && settings.bookmakers[b].port;
      if (port) await chrome.betPage(port).then(pg => pg.goto('about:blank')).catch(() => { });
    }
    books.forEach(b => busyBooks.delete(b));
  }
}

// Once a leg is placed, the rest are placed even at a small loss: an open position is far worse than a
// sure small loss (live Poprad - Bystrica stopped at -3.4 % and left a half bet open, 2026-11-13).
const COMPLETE_MAX_LOSS_PCT = 10;
// Worst outcome of a set of legs, in % of the total stake (slip price when read, else scanned).
function worstPct(legs) {
  const staked = legs.reduce((a, l) => a + l.stake, 0);
  const worst = Math.min(...legs.map(l => l.stake * (l.slipPrice || l.price))) - staked;
  return Math.round(worst / staked * 10000) / 100;
}
// How many bets a book has confirmed so far (from the bets table): least proven goes first.
function provenCount(book) {
  try {
    return db.db.prepare("SELECT count(*) n FROM bets WHERE status IN ('placed','partial','unconfirmed') AND detail LIKE ?").get(`%${book}: PLACED%`).n;
  } catch { return 0; }
}
// Cover for an open position: for each missing selection the best price at another book in the
// latest scan, staked so it pays what the held legs pay. -> { text, profit } or null.
function coverPlan(sb, held, missing, avoidBooks) {
  let events = [];
  try { const st = require('../scanner').state; events = [...(st.events || []), ...(st.liveEvents || [])]; } catch { }
  const ev = events.find(e => e.id === sb.eventId);
  if (!ev || !held.length) return null;
  const pay = Math.min(...held.map(l => l.stake * (l.slipPrice || l.price)));
  const legs = [];
  for (const m of missing) {
    const offers = ev.odds.filter(o => o.market === sb.market && (o.point ?? null) === (sb.point ?? null) && o.sel === m.sel && !avoidBooks.includes(o.book));
    if (!offers.length) return null;
    const best = offers.reduce((a, b) => (b.price > a.price ? b : a));
    legs.push({ book: best.book, sel: m.sel, price: best.price, stake: Math.ceil(pay / best.price), link: best.link });
  }
  const staked = held.reduce((a, l) => a + l.stake, 0) + legs.reduce((a, l) => a + l.stake, 0);
  const worst = Math.min(pay, ...legs.map(l => l.stake * l.price)) - staked;
  return { profit: Math.round(worst * 100) / 100, text: legs.map(l => `${l.book} ${l.sel} @ ${l.price}, stake ${l.stake} € ${l.link || ''}`).join(' + ') + ` -> ${worst >= 0 ? '+' : ''}${Math.round(worst * 100) / 100} € whatever happens` };
}

// Leg results ('confirmed' | 'unconfirmed' | 'failed') -> one status for the whole surebet.
function placedStatus(legs) {
  const n = k => legs.filter(x => x === k).length;
  if (n('confirmed') === legs.length) return 'placed';
  if (n('failed') === legs.length) return 'failed';
  if (n('failed') > 0) return 'partial';
  return 'unconfirmed';
}

const busy = () => inFlight.size > 0;

module.exports = { execute, busy, betAllowed, liveStakes, worstPct, coverPlan, SLIP_BLOCK_RE, MARKET_UI, unpick, prepareLeg, applyStakeCaps, stillProfitable, parseMoney, waitForDrop, placedStatus, stakeText, stakeMatches, checkSlip, sameMatch };
