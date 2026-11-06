const assert = require('assert');
const { mergeBooks, sim } = require('../src/providers/browser/match');

assert.strictEqual(sim('B Shelton', 'Shelton B.'), 1);
assert.strictEqual(sim('FC Salzburg', 'Salzburg'), 1);
assert.strictEqual(sim("Borussia M'gladbach", 'Mönchengladbach'), 0);
assert.strictEqual(sim('Arménsko', 'Armenien'), 1);
assert.strictEqual(sim('Turecko', 'Türkei'), 0);
// Regressions from the live scan: generic words and age markers are not evidence
assert.strictEqual(sim('Al Jazeera Amman', 'Al Talaba'), 0);
assert.strictEqual(sim('Al Ramtha', 'Ghaz Al-Shamal SC'), 0);
assert.strictEqual(sim('Merthyr Town', 'Bracknell Town'), 0);
assert.strictEqual(sim('Pardubice U19', 'Karlsruhe U19'), 0);
assert.strictEqual(sim('Pardubice U19', 'Pardubice'), 0);
assert.strictEqual(sim('Karlsruhe U19', 'Karlsruher SC U19'), 1);
assert.strictEqual(sim('Sparta Praha II', 'Sparta Praha'), 0);
assert.strictEqual(sim('Komárno B', 'Komárno'), 0);
assert.strictEqual(sim('Komárno B', 'KFC Komárno B'), 1);
assert.strictEqual(sim('Shelton B.', 'Ben Shelton'), 1);
assert.strictEqual(sim('Real Madrid', 'Real Sociedad'), 0);
assert.strictEqual(sim('OFI Kreta', 'OFI'), 1);
assert.strictEqual(sim('Ol. Lyon', 'Lyon'), 1);
assert.strictEqual(sim('Lilleström SK', 'Lillestrom'), 1);
assert.strictEqual(sim('RWD Molenbeek rez.', 'Swansea City rez.'), 0);
assert.strictEqual(sim('KV Kortrijk rez.', 'Kortrijk rez.'), 1);
assert.strictEqual(sim('Xin.Jiang/H.Wong', 'Wong C.L.C.'), 0);
assert.strictEqual(sim('Shelton, Ben', 'Shelton B.'), 1);
assert.strictEqual(sim('Hap.Ramat HaSharon', 'Hapoel Ramat Gan'), 0.5); // "ramat" only; away team must also match
assert.strictEqual(sim('Hapoel Herzliya FC', 'Hapoel Tel Aviv'), 0);

const t0 = Date.parse('2026-11-12T18:00:00+01:00');
const o = (book, price) => [{ book, sel: '1', price, market: 'h2h' }];
const ts = [
  { book: 'tipsport', sport: 'football', home: 'Arménsko', away: 'Cyprus', start: t0, odds: o('tipsport', 2.2) },
  { book: 'tipsport', sport: 'football', home: 'Turecko', away: 'Belgicko', start: t0, odds: o('tipsport', 3.4) },
  { book: 'tipsport', sport: 'tennis', home: 'Shelton B.', away: 'Paul T.', start: t0, odds: o('tipsport', 1.9) },
];
const b3 = [
  // Armenia: only home matches -> must NOT pair
  { book: 'bet365', sport: 'football', home: 'Armenien', away: 'Zypern', start: t0 + 5 * 60e3, odds: o('bet365', 2.3) },
  { book: 'bet365', sport: 'football', home: 'Türkei', away: 'Belgien', start: t0, odds: o('bet365', 3.5) },
  { book: 'bet365', sport: 'tennis', home: 'B Shelton', away: 'T Paul', start: t0, odds: o('bet365', 1.97) },
  { book: 'bet365', sport: 'tennis', home: 'Armenien', away: 'Cyprus', start: t0, odds: [] },
];
const nike = [
  // Pairs with tipsport via the group, and joins the same group as bet365
  { book: 'nike', sport: 'tennis', home: 'Shelton Ben', away: 'Paul Tommy', start: t0, odds: o('nike', 2.0) },
  // Two non-tipsport books can also form a group
  { book: 'nike', sport: 'football', home: 'Türkei', away: 'Belgien', start: t0, odds: o('nike', 3.6) },
  // same book twice never lands in one group
  { book: 'nike', sport: 'tennis', home: 'Shelton B', away: 'Paul T', start: t0, odds: o('nike', 2.1) },
];
const m = mergeBooks([ts, b3, nike]);
const by = Object.fromEntries(m.map(e => [`${e.home}-${e.away}`, e]));
assert.deepStrictEqual(Object.keys(by).sort(), ['Shelton B.-Paul T.', 'Türkei-Belgien']);
assert.deepStrictEqual(by['Shelton B.-Paul T.'].books.sort(), ['bet365', 'nike', 'tipsport']);
assert.deepStrictEqual(by['Türkei-Belgien'].books.sort(), ['bet365', 'nike']);
console.log('match tests passed');
