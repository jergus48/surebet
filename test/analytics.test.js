const assert = require('assert');
const { record, report } = require('../src/analytics');
const { db: rdb } = require('../src/db');
const realStart = (() => { try { return rdb.prepare("SELECT v FROM study_meta WHERE k = 'start'").get(); } catch { return null; } })();
const now = Date.now();
const ev = (id, odds) => ({ id, sport: 'football', sportTitle: 'Football', league: 'L', home: 'H' + id, away: 'A' + id, start: now + 3600e3, live: false, drawPossible: false, odds });
const o = (book, sel, price) => ({ book, market: 'h2h', point: null, sel, price, updated: now });
// 1 and 2 only: a+b gives a 1.2% surebet, c is present but never useful
const cleanup = () => {
  // the test shares the real DB: remove its rows, even when an assertion fails
  rdb.exec("DELETE FROM combo_obs WHERE combo = 'a + b'; DELETE FROM book_cov WHERE book IN ('a','b','c','d'); DELETE FROM study_meta;");
  if (realStart) rdb.prepare("INSERT OR REPLACE INTO study_meta (k, v) VALUES ('start', ?)").run(realStart.v); // keep a running study's start date
};
try {
record([ev('t' + now, [o('a', '1', 2.1), o('b', '2', 2.05), o('c', '1', 1.5), o('c', '2', 1.5)])], { now, force: true });
const r = report(['a', 'b', 'c', 'd'], now);
// report() lists the top 40 combos only; a running study has more, so look in the table
assert.ok(rdb.prepare("SELECT 1 FROM combo_obs WHERE combo = 'a + b'").get());
const by = Object.fromEntries(r.books.map(b => [b.book, b]));
assert.ok(by.a.surebets >= 1 && by.b.surebets >= 1);
assert.strictEqual(by.c.surebets, 0);
assert.ok(/collecting/.test(by.c.verdict));
// after a week of data the unused book is flagged
const later = report(['a', 'b', 'c'], now + 8 * 86400000);
assert.ok(/REMOVE/.test(later.books.find(b => b.book === 'c').verdict));
assert.strictEqual(later.books.find(b => b.book === 'a').verdict, 'keep');
console.log('analytics tests passed');
} finally {
  cleanup();
}
