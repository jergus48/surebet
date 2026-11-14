// SQLite via Node's built-in node:sqlite (Node >= 22.13), no native deps.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

const db = new DatabaseSync(path.join(DATA_DIR, 'surebet.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS surebets (
    key TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    max_profit REAL NOT NULL,
    sport TEXT, sport_title TEXT, league TEXT, home TEXT, away TEXT,
    start INTEGER, live INTEGER, market TEXT, point REAL,
    profit REAL, json TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ix_sb_first ON surebets(first_seen);
  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surebet_key TEXT NOT NULL,
    created INTEGER NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,        -- pending | filled | placed | partial | failed
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS balances (
    book TEXT NOT NULL, ts INTEGER NOT NULL, amount REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_bal ON balances(book, ts);
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    person TEXT NOT NULL,
    book TEXT NOT NULL,
    type TEXT NOT NULL,          -- deposit | withdrawal
    amount REAL NOT NULL,
    note TEXT
  );
`);
// bets.legs: JSON { home, away, start, market, point, legs: [{ book, sel, price, stake, placed }] } of a
// placed bet (added 2026-11-13; older rows have none).
try { db.exec('ALTER TABLE bets ADD COLUMN legs TEXT'); } catch { /* already there */ }

const q = {
  get: db.prepare('SELECT key FROM surebets WHERE key = ?'),
  insert: db.prepare(`INSERT INTO surebets
    (key, first_seen, last_seen, max_profit, sport, sport_title, league, home, away, start, live, market, point, profit, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  touch: db.prepare(`UPDATE surebets SET last_seen = ?, seen_count = seen_count + 1,
    max_profit = MAX(max_profit, ?), profit = ?, json = ? WHERE key = ?`),
  markNotified: db.prepare('UPDATE surebets SET notified = 1 WHERE key = ?'),
  history: db.prepare('SELECT * FROM surebets ORDER BY first_seen DESC LIMIT ?'),
  byKey: db.prepare('SELECT * FROM surebets WHERE key = ?'),
  stats: db.prepare(`SELECT sport_title AS sport, COUNT(*) AS n,
      SUM(CASE WHEN live = 0 THEN 1 ELSE 0 END) AS prematch,
      SUM(CASE WHEN live = 1 THEN 1 ELSE 0 END) AS live,
      AVG(max_profit) AS avg_profit
    FROM surebets GROUP BY sport_title ORDER BY n DESC`),
  firstTs: db.prepare('SELECT MIN(first_seen) AS t, COUNT(*) AS n FROM surebets'),
  allJson: db.prepare('SELECT json FROM surebets'),
  addLog: db.prepare('INSERT INTO log (ts, level, msg) VALUES (?, ?, ?)'),
  logTail: db.prepare('SELECT * FROM log ORDER BY id DESC LIMIT ?'),
  logTrim: db.prepare('DELETE FROM log WHERE id < (SELECT MAX(id) - 5000 FROM log)'),
  addBet: db.prepare('INSERT INTO bets (surebet_key, created, mode, status, detail) VALUES (?, ?, ?, ?, ?)'),
  setBet: db.prepare('UPDATE bets SET status = ?, detail = ? WHERE id = ?'),
  bets: db.prepare('SELECT * FROM bets ORDER BY id DESC LIMIT ?'),
  betsSince: db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE created >= ? AND mode = 'auto' AND status IN ('placed','partial','unconfirmed')`),
  addBalance: db.prepare('INSERT INTO balances (book, ts, amount) VALUES (?, ?, ?)'),
  lastBalances: db.prepare('SELECT b.book, b.ts, b.amount FROM balances b JOIN (SELECT book, MAX(ts) AS ts FROM balances GROUP BY book) m ON m.book = b.book AND m.ts = b.ts'),
  addLedger: db.prepare('INSERT INTO ledger (ts, person, book, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)'),
  ledger: db.prepare('SELECT * FROM ledger ORDER BY ts DESC, id DESC'),
  delLedger: db.prepare('DELETE FROM ledger WHERE id = ?'),
};

// Returns true when the surebet is new.
function upsertSurebet(sb, now = Date.now()) {
  const json = JSON.stringify(sb);
  if (q.get.get(sb.key)) {
    q.touch.run(now, sb.profitPct, sb.profitPct, json, sb.key);
    return false;
  }
  q.insert.run(sb.key, now, now, sb.profitPct, sb.sport, sb.sportTitle, sb.league, sb.home, sb.away,
    sb.start, sb.live ? 1 : 0, sb.market, sb.point, sb.profitPct, json);
  return true;
}

function bookStats() {
  const counts = new Map();
  for (const { json } of q.allJson.all()) {
    const books = [...new Set(JSON.parse(json).legs.map(l => l.book))].sort().join(' + ');
    counts.set(books, (counts.get(books) || 0) + 1);
  }
  return [...counts].map(([books, n]) => ({ books, n })).sort((a, b) => b.n - a.n);
}

let logListeners = [];
function log(level, msg) {
  const ts = Date.now();
  q.addLog.run(ts, level, String(msg));
  if (Math.random() < 0.01) q.logTrim.run();
  const line = `[${new Date(ts).toISOString()}] ${level.toUpperCase()} ${msg}`;
  (level === 'error' ? console.error : console.log)(line);
  for (const fn of logListeners) fn({ ts, level, msg });
}

module.exports = {
  db, upsertSurebet, bookStats, log,
  markNotified: k => q.markNotified.run(k),
  history: (n = 300) => q.history.all(n),
  byKey: k => q.byKey.get(k),
  stats: () => ({ ...q.firstTs.get(), sports: q.stats.all(), books: bookStats() }),
  logTail: (n = 300) => q.logTail.all(n),
  addBet: (key, mode, status, detail) => Number(q.addBet.run(key, Date.now(), mode, status, detail || '').lastInsertRowid),
  setBet: (id, status, detail) => q.setBet.run(status, detail || '', id),
  bets: (n = 200) => q.bets.all(n),
  setBetLegs: (id, info) => db.prepare('UPDATE bets SET legs = ? WHERE id = ?').run(JSON.stringify(info), id),
  // Bets where Place was clicked (placed, partial or unconfirmed), newest first, with their legs.
  placedBets: () => db.prepare("SELECT * FROM bets WHERE status IN ('placed','partial','unconfirmed') ORDER BY id DESC").all()
    .map(b => ({ ...b, legs: b.legs ? JSON.parse(b.legs) : null })),
  // Last balance read before a moment (the starting point of a book: before its first bet).
  balanceBefore: (book, ts) => db.prepare('SELECT amount, ts FROM balances WHERE book = ? AND ts < ? ORDER BY ts DESC LIMIT 1').get(book, ts) || null,
  // First balance ever read per book (the starting point for profit) and the latest one.
  firstBalances: () => db.prepare('SELECT b.book, b.amount, b.ts FROM balances b JOIN (SELECT book, MIN(ts) t FROM balances GROUP BY book) f ON f.book = b.book AND f.t = b.ts').all(),
  // Bet attempts on one match (surebet keys start with the event id): { n, last, all, placed }
  eventBets: eventId => {
    const rows = db.prepare("SELECT created, status, mode FROM bets WHERE substr(surebet_key, 1, ?) = ?").all(eventId.length + 1, eventId + '|');
    // n / last: the bot's own (auto) attempts; an "Open" (fill) you clicked does not use up its retries
    const auto = rows.filter(r => r.mode === 'auto');
    return { n: auto.length, last: Math.max(0, ...auto.map(r => r.created)), all: rows.length, placed: rows.some(r => /^(placed|partial|unconfirmed|pending)$/.test(r.status)) };
  },
  // Today's bets (Place clicked) per bookmaker, e.g. { chance: 3, nike: 1 }: a bet counts once for every
  // book where a leg was placed.
  betsTodayByBook: () => {
    const out = {};
    for (const [combo, n] of Object.entries(module.exports.betsTodayByCombo())) for (const b of combo.split('+')) out[b] = (out[b] || 0) + n;
    return out;
  },
  // Today's bets (Place clicked) per bookmaker combination, e.g. { 'chance+synottip': 2 }. A bet's books
  // come from its stored legs, or from its detail ("tipsport: PLACED | doxxbet: PLACED") for older rows.
  betsTodayByCombo: () => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const out = {};
    for (const b of db.prepare("SELECT legs, detail FROM bets WHERE created >= ? AND status IN ('placed','partial','unconfirmed')").all(d.getTime())) {
      let books = [];
      try { books = (JSON.parse(b.legs || 'null') || { legs: [] }).legs.filter(l => l.placed !== false).map(l => l.book); } catch { }
      if (!books.length) books = [...String(b.detail || '').matchAll(/(?:^|\| )([a-z0-9]+): /g)].map(m => m[1]);
      const key = [...new Set(books)].sort().join('+');
      if (key) out[key] = (out[key] || 0) + 1;
    }
    return out;
  },
  autoBetsToday: () => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return q.betsSince.get(d.getTime()).n;
  },
  addBalance: (book, amount, ts = Date.now()) => q.addBalance.run(book, ts, amount),
  lastBalances: () => q.lastBalances.all(),
  addLedger: (e) => Number(q.addLedger.run(e.ts || Date.now(), e.person, e.book, e.type, e.amount, e.note || '').lastInsertRowid),
  ledger: () => q.ledger.all(),
  delLedger: id => q.delLedger.run(id).changes,
};
