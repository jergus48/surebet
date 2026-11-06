// Long-run study of WHICH bookmaker combinations produce surebets, so books that never
// take part can be dropped. Runs alongside the normal scanner with its own low threshold
// (STUDY_MIN %) so near-misses count too, and logs how much each book contributes at all.
//
//   combo_obs : one row per distinct surebet seen (key = event + market + books/selections)
//   book_cov  : per book and day: polls, events read, events also present at another book
const { db } = require('./db');
const { findSurebets } = require('./arb');

const STUDY_MIN = 0.5;
const STUDY_DAYS = 7;

db.exec(`
  CREATE TABLE IF NOT EXISTS combo_obs (
    key TEXT PRIMARY KEY, combo TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1, max_profit REAL NOT NULL, sport TEXT, live INTEGER, market TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_combo_first ON combo_obs(first_seen);
  CREATE TABLE IF NOT EXISTS study_meta (k TEXT PRIMARY KEY, v INTEGER);
  CREATE TABLE IF NOT EXISTS book_cov (
    book TEXT NOT NULL, day TEXT NOT NULL, polls INTEGER NOT NULL DEFAULT 0,
    events INTEGER NOT NULL DEFAULT 0, shared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (book, day)
  );
`);

const q = {
  get: db.prepare('SELECT key FROM combo_obs WHERE key = ?'),
  ins: db.prepare('INSERT INTO combo_obs (key, combo, first_seen, last_seen, max_profit, sport, live, market) VALUES (?,?,?,?,?,?,?,?)'),
  upd: db.prepare('UPDATE combo_obs SET last_seen = ?, seen = seen + 1, max_profit = MAX(max_profit, ?) WHERE key = ?'),
  cov: db.prepare(`INSERT INTO book_cov (book, day, polls, events, shared) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(book, day) DO UPDATE SET polls = polls + 1, events = events + excluded.events, shared = shared + excluded.shared`),
  all: db.prepare('SELECT * FROM combo_obs'),
  covAll: db.prepare('SELECT book, SUM(polls) AS polls, SUM(events) AS events, SUM(shared) AS shared FROM book_cov GROUP BY book'),
  start: db.prepare("INSERT OR IGNORE INTO study_meta (k, v) VALUES ('start', ?)"),
  getStart: db.prepare("SELECT v FROM study_meta WHERE k = 'start'"),
};

// Test runs share the real database: they must not feed the study (analytics.test passes force).
const IN_TEST = /[\\/]test[\\/]/.test(process.argv[1] || '');

const comboOf = sb => [...new Set(sb.legs.map(l => l.book))].sort().join(' + ');

// Call after every scan with the events of that scan.
function record(events, { live = false, books = null, maxAgeMs = 0, maxProfitPct = 25, now = Date.now(), force = false } = {}) {
  if (IN_TEST && !force) return;
  try {
    q.start.run(now);
    const day = new Date(now).toISOString().slice(0, 10);
    const perBook = new Map();
    for (const ev of events) {
      const present = new Set(ev.odds.filter(o => !books || books.has(o.book)).map(o => o.book));
      for (const b of present) {
        const c = perBook.get(b) || { events: 0, shared: 0 };
        c.events += 1;
        if (present.size > 1) c.shared += 1;
        perBook.set(b, c);
      }
    }
    for (const [b, c] of perBook) q.cov.run(b, day, c.events, c.shared);

    const found = findSurebets(events, { minProfitPct: STUDY_MIN, maxProfitPct, books, bankroll: 100, includeLive: live, maxAgeMs, now });
    for (const sb of found) {
      if (q.get.get(sb.key)) q.upd.run(now, sb.profitPct, sb.key);
      else q.ins.run(sb.key, comboOf(sb), now, now, sb.profitPct, sb.sport, sb.live ? 1 : 0, sb.market);
    }
  } catch (e) {
    // analytics must never break scanning
    console.error('analytics:', e.message);
  }
}

// enabledBooks: keys of books that are currently enabled (a book with zero combos is only "never used" if it ran).
function report(enabledBooks = [], now = Date.now()) {
  const rows = q.all.all();
  const cov = new Map(q.covAll.all().map(r => [r.book, r]));
  const t0 = q.getStart.get()?.v ?? now;
  const days = Math.max(0, (now - t0) / 86400000);

  const combos = new Map();
  const perBook = new Map();
  const bump = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
  for (const r of rows) {
    const c = bump(combos, r.combo, () => ({ combo: r.combo, n: 0, n1: 0, n2: 0, live: 0, best: 0, sports: {} }));
    c.n += 1; if (r.max_profit >= 1) c.n1 += 1; if (r.max_profit >= 2) c.n2 += 1;
    if (r.live) c.live += 1;
    c.best = Math.max(c.best, r.max_profit);
    c.sports[r.sport] = (c.sports[r.sport] || 0) + 1;
    for (const b of r.combo.split(' + ')) {
      const p = bump(perBook, b, () => ({ n: 0, n1: 0, n2: 0, live: 0, partners: {} }));
      p.n += 1; if (r.max_profit >= 1) p.n1 += 1; if (r.max_profit >= 2) p.n2 += 1; if (r.live) p.live += 1;
      for (const o of r.combo.split(' + ')) if (o !== b) p.partners[o] = (p.partners[o] || 0) + 1;
    }
  }
  const allBooks = [...new Set([...enabledBooks, ...perBook.keys(), ...cov.keys()])].sort();
  const ready = days >= STUDY_DAYS;
  const books = allBooks.map(b => {
    const p = perBook.get(b) || { n: 0, n1: 0, n2: 0, live: 0, partners: {} };
    const c = cov.get(b);
    let verdict;
    if (!ready) verdict = `collecting (${days.toFixed(1)} of ${STUDY_DAYS} days)`;
    else if (!c || !c.events) verdict = 'no data: book never returned events (check it is enabled and readable)';
    else if (p.n === 0) verdict = 'REMOVE: never part of a surebet';
    else if (p.n2 === 0) verdict = `weak: only below 2% (${p.n} cases)`;
    else verdict = 'keep';
    return {
      book: b, enabled: enabledBooks.includes(b), surebets: p.n, over1: p.n1, over2: p.n2, live: p.live,
      avgEventsPerPoll: c && c.polls ? Math.round(c.events / c.polls) : 0,
      sharedPct: c && c.events ? Math.round(c.shared / c.events * 100) : 0,
      topPartners: Object.entries(p.partners).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} (${v})`),
      verdict,
    };
  }).sort((a, b) => b.surebets - a.surebets);
  return {
    days: Math.round(days * 10) / 10, studyDays: STUDY_DAYS, ready, studyMinPct: STUDY_MIN, observations: rows.length,
    books,
    combos: [...combos.values()].sort((a, b) => b.n - a.n).slice(0, 40),
  };
}

module.exports = { record, report, comboOf, STUDY_MIN, STUDY_DAYS };
