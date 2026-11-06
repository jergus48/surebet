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
`);

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
  betsSince: db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE created >= ? AND mode = 'auto' AND status IN ('placed','partial')`),
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
  autoBetsToday: () => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return q.betsSince.get(d.getTime()).n;
  },
};
