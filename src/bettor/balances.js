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
const lowAlertAt = {};
const FRESH_MS = 15 * 60 * 1000;
const LOW_REPEAT_MS = 12 * 3600 * 1000;
let timer = null;

for (const r of db.lastBalances()) state[r.book] = { amount: r.amount, at: r.ts, stored: true };

async function readBook(settings, book) {
  const bk = settings.bookmakers[book];
  const site = sites.load()[book];
  const sel = site && site.selectors && site.selectors.balance;
  if (!sel) return { error: 'balance not calibrated' };
  if (!(await chrome.isUp(bk.port))) return { error: 'window not open' };
  const browser = await chrome.connect(bk.port);
  for (const p of await browser.pages()) {
    if (!site.domain.test(p.url())) continue;
    const text = await p.$eval(sel, el => el.textContent).catch(() => null); // also when the panel is collapsed
    const cur = site.currency || 'EUR';
    const local = text == null ? null : parseAmount(text, cur);
    // Kept in € (stake caps, low-balance alert, profit); books in another currency also keep their own amount.
    if (local != null && cur === 'EUR') return { amount: local };
    if (local != null) {
      const rate = Number((settings.fx || {})[cur]);
      if (!(rate > 0)) return { error: `no exchange rate for ${cur} (settings fx.${cur})` };
      return { amount: Math.round(local / rate * 100) / 100, local, currency: cur };
    }
    if (text && /\d/.test(text)) return { error: `balance not in ${cur === 'EUR' ? 'euros' : cur} ("${text.trim()}"): switch the site to ${cur === 'EUR' ? '€' : cur}` };
  }
  return { error: 'balance not on page (logged out?)' };
}

function record(settings, book, r, now = Date.now()) {
  const prev = state[book];
  if (r.amount == null) { state[book] = { ...(prev || {}), error: r.error, checkedAt: now }; return; }
  // History only when the amount moves, plus one row an hour.
  if (!prev || prev.amount !== r.amount || now - (prev.storedAt || prev.at || 0) > 3600e3) {
    db.addBalance(book, r.amount, now);
    state[book] = { amount: r.amount, at: now, storedAt: now };
  } else state[book] = { ...prev, at: now, error: null };
  if (r.currency) Object.assign(state[book], { local: r.local, currency: r.currency });
  const low = Number(settings.lowBalanceAlert) || 0;
  if (low > 0 && r.amount < low) {
    if (!lowAlertAt[book] || now - lowAlertAt[book] > LOW_REPEAT_MS) {
      lowAlertAt[book] = now;
      const name = settings.bookmakers[book].name || book;
      db.log('warn', `${name} balance ${r.amount} below ${low}`);
      notify.send(settings, `⚠️ ${name}: balance ${r.amount.toFixed(2)} € is below ${low} €. Top it up, or surebets with a leg there are skipped.`).catch(() => { });
    }
  } else delete lowAlertAt[book];
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

module.exports = { readBook, refreshAll, fresh, snapshot, start, record, state };
