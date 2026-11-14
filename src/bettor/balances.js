// Reads each logged-in bookmaker's balance from its own Chrome window (the calibrated
// `balance` selector) every balanceEverySec. The live amount sizes stakes, triggers the
// low-balance alert and feeds the profit summary.
const chrome = require('./chrome');
const sites = require('./sites');
const config = require('../config');
const db = require('../db');
const notify = require('../notify');
const { parseAmount } = require('./parse');

const state = {}; // book -> { amount, at, error }
const LOW_FILE = require('path').join(config.DATA_DIR, 'low-balance-alerts.json');
const lowAlerted = (() => { try { return JSON.parse(require('fs').readFileSync(LOW_FILE, 'utf8')); } catch { return {}; } })(); // book -> ms told
const saveLowAlerted = () => { try { require('fs').writeFileSync(LOW_FILE, JSON.stringify(lowAlerted)); } catch { } };
const FRESH_MS = 15 * 60 * 1000;
let timer = null;

for (const r of db.lastBalances()) state[r.book] = { amount: r.amount, at: r.ts, stored: true };

// Fresh read: the book's home page is loaded in its betting tab (never while a bet uses that book),
// the logged-in marker is awaited, the balance read, and the tab goes back to a blank page. Scan tabs
// stay open for hours and keep the header they drew back then: all night on 2026-11-14 Tipos showed
// 38.25 EUR and "logged in" there while its session had expired (the real balance was 18.25 EUR after
// a bet), so they are trusted for neither. Books with site.passiveBalance (Bet365: reloads make it
// serve empty pages) are still read from their open tabs.
async function readFresh(settings, book, site) {
  const bk = settings.bookmakers[book];
  const S = site.selectors;
  const cur = site.currency || 'EUR';
  const once = async page => {
    await page.goto(site.sessionUrl || site.home, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!(await page.waitForSelector(S.loggedIn, { timeout: 20000 }).catch(() => null))) return { error: 'logged out: log in in its Chrome window', loggedOut: true };
    let text = null;
    for (let i = 0; i < 30; i++) {
      text = await page.$eval(S.balance, el => el.textContent).catch(() => null);
      if (text != null && parseAmount(text, cur) != null) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return { text };
  };
  const r = await require('./index').withBook(book, async () => {
    const page = await chrome.betPage(bk.port);
    try {
      let x = await once(page);
      if (x.loggedOut) x = await once(page); // a slow page is not a logout: look once more
      return x;
    } catch (e) {
      if (chrome.isTimeout(e)) await chrome.dropBetPage(bk.port);
      throw e;
    } finally {
      await page.goto('about:blank').catch(() => { });
      await chrome.showSite(bk.port, site.domain).catch(() => { });
    }
  });
  if (r === undefined) return { skipped: true }; // a bet is using this book right now
  return r.text !== undefined ? amountOf(settings, r.text, cur) : r;
}

function amountOf(settings, text, cur) {
  const local = text == null ? null : parseAmount(text, cur);
  // Kept in EUR (stake caps, low-balance alert, profit); books in another currency also keep their own amount.
  if (local != null && cur === 'EUR') return { amount: local };
  if (local != null) {
    const rate = Number((settings.fx || {})[cur]);
    if (!(rate > 0)) return { error: `no exchange rate for ${cur} (settings fx.${cur})` };
    return { amount: Math.round(local / rate * 100) / 100, local, currency: cur };
  }
  if (text && /\d/.test(text)) return { error: `balance not in ${cur === 'EUR' ? 'euros' : cur} ("${text.trim()}"): switch the site to ${cur === 'EUR' ? '€' : cur}` };
  return null;
}

async function readBook(settings, book) {
  const bk = settings.bookmakers[book];
  const site = sites.load()[book];
  const sel = site && site.selectors && site.selectors.balance;
  if (!sel) return { error: 'balance not calibrated' };
  if (!(await chrome.isUp(bk.port))) return { error: 'window not open' };
  if (site.selectors.loggedIn && !site.passiveBalance) return readFresh(settings, book, site);
  const browser = await chrome.connect(bk.port);
  for (const p of await browser.pages()) {
    if (!site.domain.test(p.url())) continue;
    const text = await p.$eval(sel, el => el.textContent).catch(() => null); // also when the panel is collapsed
    const r = amountOf(settings, text, site.currency || 'EUR');
    if (r) return r;
  }
  return { error: 'balance not on page (logged out?)', loggedOut: !!site.balanceRequired };
}

// Login watch: a book found logged out (here, or by a bet that stopped on it) is reported on Telegram
// at once and again every hour until it is logged in; logging back in is reported too. Auto bets with
// a leg there fail until then, so this message is never muted by alertsOnlyBets.
const session = {}; // book -> { since, alertedAt }
const LOGIN_REPEAT_MS = 3600e3;
function noteLogin(settings, book, loggedIn, now = Date.now()) {
  const bk = settings.bookmakers[book] || {};
  if (bk.dataOnly) return;
  const name = bk.name || book;
  const out = session[book];
  if (loggedIn) {
    if (out) {
      delete session[book];
      db.log('info', `${name}: logged in again`);
      if (out.alertedAt) notify.send(settings, `✅ ${name}: logged in again, auto bets there are back on.`).catch(() => { });
    }
    return;
  }
  const s = out || (session[book] = { since: now, alertedAt: 0 });
  // A saved login (Settings > Auto login): log in by itself first; you hear about it either way.
  if (!s.trying && !noteLogin.noAuto) {
    s.trying = true;
    require('./logins').auto(settings, book).then(r => {
      s.trying = false;
      if (r === 'ok') {
        delete session[book];
        notify.send(settings, `🔐 ${name} was logged out → ✅ logged back in automatically.`).catch(() => { });
        refreshAll(settings).catch(() => { });
      } else if (r === 'no-login' || r === 'blocked' || r === 'failed') alertOut(settings, book, name, s, Date.now());
      // 'busy': a bet or another login is using the window, the next check tries again
    }).catch(() => { s.trying = false; alertOut(settings, book, name, s, Date.now()); });
    return;
  }
  if (!s.trying) alertOut(settings, book, name, s, now);
}
function alertOut(settings, book, name, s, now = Date.now()) {
  if (now - s.alertedAt < LOGIN_REPEAT_MS) return;
  s.alertedAt = now;
  const mins = Math.round((now - s.since) / 60000);
  db.log('warn', `${name}: logged out${mins ? ` (for ${mins} min)` : ''}`);
  notify.send(settings, `🔐 ${name} is LOGGED OUT${mins ? ` (for ${mins} min)` : ''}. Log in in its Chrome window (Overview > Open window). Until then every surebet with a leg at ${name} is NOT bet.`).catch(() => { });
}
const loggedOut = () => Object.keys(session);

// A rise that matches no placed leg's payout (stake x price, within 2 cents) nor a ledger entry of that size today.
function unexplainedRise(settings, book, rise, now = Date.now()) {
  rise = Math.round(rise * 100) / 100;
  const payouts = [];
  for (const b of db.placedBets()) for (const l of (b.legs && b.legs.legs) || []) if (l.book === book && l.placed !== false) payouts.push(Math.round(l.stake * l.price * 100) / 100);
  if (payouts.some(p => Math.abs(p - rise) <= 0.02)) return;
  const day = now - 24 * 3600e3;
  if (db.ledger().some(e => e.book === book && e.type === 'deposit' && e.ts > day && Math.abs(e.amount - rise) <= 0.02)) return;
  const name = (settings.bookmakers[book] || {}).name || book;
  db.log('warn', `${name}: +${rise.toFixed(2)} EUR that is no bet's payout`);
  notify.send(settings, `💶 ${name}: +${rise.toFixed(2)} € came in and it is no bet's payout. If it is your deposit (or a bonus), add it in Overview > Money, else it is counted as profit.`).catch(() => { });
}

function record(settings, book, r, now = Date.now()) {
  const prev = state[book];
  if (r.skipped) return;
  if (r.loggedOut) noteLogin(settings, book, false, now);
  else if (r.amount != null) noteLogin(settings, book, true, now);
  if (r.amount == null) { state[book] = { ...(prev || {}), error: r.error, checkedAt: now }; return; }
  // Money that came in but is no bet's payout (a deposit, a bonus): it would count as profit unless it is in
  // the Money ledger. Told once per rise.
  if (prev && prev.amount != null && r.amount - prev.amount > 0.5) unexplainedRise(settings, book, r.amount - prev.amount, now);
  // History only when the amount moves, plus one row an hour.
  if (!prev || prev.amount !== r.amount || now - (prev.storedAt || prev.at || 0) > 3600e3) {
    db.addBalance(book, r.amount, now);
    state[book] = { amount: r.amount, at: now, storedAt: now };
  } else state[book] = { ...prev, at: now, error: null };
  if (r.currency) Object.assign(state[book], { local: r.local, currency: r.currency });
  // Low balance: told once, only when no bet with a leg at this book is still waiting for its result (a win
  // there would top it up), and not again (also after a restart) until the balance has been back above it.
  const low = Number(settings.lowBalanceAlert) || 0;
  if (low > 0 && r.amount < low) {
    if (!lowAlerted[book] && !pendingAt(book, now)) {
      lowAlerted[book] = now;
      saveLowAlerted();
      const name = settings.bookmakers[book].name || book;
      db.log('warn', `${name} balance ${r.amount} below ${low}`);
      notify.send(settings, `⚠️ ${name}: balance ${r.amount.toFixed(2)} € is below ${low} € and no bet there is waiting for a result. Top it up, or surebets with a leg there are skipped.`).catch(() => { });
    }
  } else if (lowAlerted[book]) { delete lowAlerted[book]; saveLowAlerted(); }
}

// Is a placed leg at this book still waiting for its result? (its match started less than 3 h ago, or later)
function pendingAt(book, now = Date.now()) {
  return db.placedBets().some(b => b.legs && b.legs.start && now < b.legs.start + 3 * 3600e3 && (b.legs.legs || []).some(l => l.book === book && l.placed !== false));
}

async function refreshAll(settings = config.load()) {
  const books = Object.entries(settings.bookmakers).filter(([, b]) => b.enabled).map(([k]) => k);
  await Promise.all(books.map(async k => {
    let r;
    try { r = await readBook(settings, k); } catch (e) { r = { error: e.message }; }
    record(settings, k, r);
  }));
  return snapshot();
}

// Balance read within the last 15 minutes, else null.
function fresh(book, now = Date.now()) {
  const b = state[book];
  return b && b.amount != null && now - b.at < FRESH_MS ? b.amount : null;
}

function snapshot() { return JSON.parse(JSON.stringify(state)); }

async function loop() {
  const s = config.load();
  await refreshAll(s).catch(e => db.log('warn', `balances: ${e.message}`));
  timer = setTimeout(loop, Math.max(60, Number(s.balanceEverySec) || 300) * 1000);
}
function start() { if (!timer) loop(); }

module.exports = { readBook, refreshAll, fresh, snapshot, start, record, state, noteLogin, loggedOut, amountOf };
