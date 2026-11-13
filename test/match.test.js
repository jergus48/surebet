const assert = require('assert');
const { mergeBooks, sim } = require('../src/providers/browser/match');

assert.strictEqual(sim('B Shelton', 'Shelton B.'), 1);
assert.strictEqual(sim('FC Salzburg', 'Salzburg'), 1);
assert.strictEqual(sim("Borussia M'gladbach", 'Mönchengladbach'), 0);
assert.strictEqual(sim('Arménsko', 'Armenien'), 1);
assert.strictEqual(sim('Turecko', 'Türkei'), 1); // both Turkey (names.js)
// ported from the Python scanner: countries, Niké age teams, women / reserves spellings
assert.strictEqual(sim('Moldavsko', 'Moldova'), 1);
assert.strictEqual(sim('Island 21', 'Iceland U21'), 1);
assert.strictEqual(sim('Island 21', 'Iceland'), 0);      // U21 is not the senior team
assert.strictEqual(sim('Hannover 96', 'Hannover'), 1);   // a club number is not an age
assert.strictEqual(sim('Everton ž.', 'Everton (W)'), 1);
assert.strictEqual(sim('Everton ž.', 'Everton'), 0);
assert.strictEqual(sim('Boca Juniors rezervný tím', 'Boca Juniors Reserves'), 1);
assert.strictEqual(sim('Severné Macedónsko', 'North Macedonia'), 1);
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
  // Armenia - Cyprus in German: pairs now that names.js knows the German country names
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
assert.deepStrictEqual(Object.keys(by).sort(), ['Arménsko-Cyprus', 'Shelton B.-Paul T.', 'Turecko-Belgicko']);
assert.deepStrictEqual(by['Shelton B.-Paul T.'].books.sort(), ['bet365', 'nike', 'tipsport']);
assert.deepStrictEqual(by['Turecko-Belgicko'].books.sort(), ['bet365', 'nike', 'tipsport']);
assert.deepStrictEqual(by['Arménsko-Cyprus'].books.sort(), ['bet365', 'tipsport']); // the tennis "Armenien" stays out
console.log('match tests passed');

// Team numbers: "Japonsko 1" and "Japonsko 2" are different teams (a fake surebet was bet on that, 2026-11)
assert.strictEqual(sim('Japonsko 1', 'Japonsko 2'), 0);
assert.strictEqual(sim('Japonsko', 'Japonsko 2'), 0);
assert.strictEqual(sim('Japan 1', 'Japonsko 1'), 1);
assert.strictEqual(sim('Hannover 96', 'Hannover'), 1);
{
  const t1 = Date.parse('2026-11-14T12:00:00Z');
  const m2 = mergeBooks([
    [{ book: 'tipsport', sport: 'football', home: 'Rakúsko', away: 'Japonsko 1', start: t1, odds: [{ book: 'tipsport', market: 'h2h', sel: '1', price: 3 }] }],
    [{ book: 'fortuna', sport: 'football', home: 'Rakúsko', away: 'Japonsko 2', start: t1, odds: [{ book: 'fortuna', market: 'h2h', sel: '2', price: 3 }] }],
  ]);
  assert.strictEqual(m2.length, 0);
}
// second guard: books disagreeing who the favourite is never get a bet
{
  const { findSurebets } = require('../src/arb');
  const { betAllowed } = require('../src/bettor');
  const ev = { id: 'x', sport: 'tennis', home: 'A', away: 'B', drawPossible: false, start: 1, odds: [
    { book: 'tipsport', market: 'h2h', sel: '1', price: 1.4 }, { book: 'tipsport', market: 'h2h', sel: '2', price: 2.9 },
    { book: 'nike', market: 'h2h', sel: '1', price: 3.1 }, { book: 'nike', market: 'h2h', sel: '2', price: 1.35 }] };
  const [sb] = findSurebets([ev], { minProfitPct: 1, bankroll: 30, step: 1 });
  assert.ok(sb && sb.flipped);
  assert.ok(/favourite/.test(betAllowed({ autoMinProfitPct: 3, autoBetSuspect: true }, sb)));
  console.log('team number / flipped favourite tests passed');
}

// The same match listed the other way round: paired, and that book's picks turned to the group's sides
// (its "1" = Japan = the group's "2"). The surebet must never put Japan on both legs.
{
  const { findSurebets } = require('../src/arb');
  const t2 = Date.parse('2026-11-14T12:00:00Z');
  const q = (book, sel, price, extra = {}) => ({ book, market: 'h2h', sel, price, ...extra });
  const m3 = mergeBooks([
    [{ book: 'nike', sport: 'football', home: 'Rakúsko', away: 'Japonsko', start: t2, odds: [q('nike', '1', 2.0), q('nike', 'X', 3.4), q('nike', '2', 4.2)] }],
    [{ book: 'tipsport', sport: 'football', home: 'Japonsko', away: 'Rakúsko', start: t2, odds: [q('tipsport', '1', 4.4), q('tipsport', 'X', 3.5), q('tipsport', '2', 1.95),
      { book: 'tipsport', market: 'spreads', point: -0.5, sel: 'H', price: 4.3 }, { book: 'tipsport', market: 'home_totals', point: 0.5, sel: 'O', price: 1.5 }] }],
  ]);
  assert.strictEqual(m3.length, 1);
  const tp = m3[0].odds.filter(o => o.book === 'tipsport');
  const at = (mk, sel) => tp.find(o => o.market === mk && o.sel === sel);
  assert.strictEqual(at('h2h', '2').price, 4.4);   // Japan win = the group's away
  assert.strictEqual(at('h2h', '2').bookSel, '1'); // what Tipsport calls it
  assert.strictEqual(at('h2h', '1').price, 1.95);  // Austria win
  assert.deepStrictEqual([at('spreads', 'A').point, at('spreads', 'A').bookSel, at('spreads', 'A').bookPoint], [0.5, 'H', -0.5]);
  assert.ok(at('away_totals', 'O'));               // Japan's goals = the away team's goals
  const sbs = findSurebets([{ ...m3[0], drawPossible: true }], { minProfitPct: 0, bankroll: 30 });
  for (const sb of sbs) {
    const japanLegs = sb.legs.filter(l => (l.book === 'tipsport' ? l.bookSel === '1' : l.sel === '2'));
    assert.ok(japanLegs.length <= 1, 'Japan on both legs: ' + JSON.stringify(sb.legs));
    assert.ok(!sb.flipped);
  }
  // weak evidence never pairs swapped
  assert.strictEqual(mergeBooks([
    [{ book: 'nike', sport: 'football', home: 'Slavia', away: 'Sparta', start: t2, odds: [q('nike', '1', 2)] }],
    [{ book: 'tipsport', sport: 'football', home: 'Sparta B', away: 'Slavia', start: t2, odds: [q('tipsport', '1', 2)] }]]).length, 0);
  console.log('swapped sides tests passed');
}
