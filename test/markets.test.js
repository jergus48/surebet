// Extra markets: the Tipos/Synottip mapper, surebets on the new markets, and which markets auto may bet.
const assert = require('assert');
const { marketsOf } = require('../src/providers/browser/platformMarkets');
const { findSurebets, marketLabel } = require('../src/arb');
const { betAllowed } = require('../src/bettor');

const games = [
  { name: 'Zápas', rows: [[{ name: '1', price: 2.61 }, { name: 'X', price: 3.05 }, { name: '2', price: 3.14 }]] },
  { name: 'Dvojtip', rows: [[{ name: '10', price: 1.39 }, { name: '12', price: 1.33 }, { name: '02', price: 1.53 }]] },
  { name: 'Stávka bez remízy', rows: [[{ name: '1', price: 1.73 }, { name: '2', price: 2.07 }]] },
  { name: 'Celkový počet gólov', rows: [
    [{ name: 'Pod (2.5)', price: 1.58 }, { name: 'Nad (2.5)', price: 2.4 }],
    [{ name: 'Pod (2.75)', price: 1.4 }, { name: 'Nad (2.75)', price: 2.9 }], // quarter line: push risk, left out
    [{ name: 'Pod (3.5)', price: 1.21 }]], // incomplete row
  },
  { name: 'Obaja dajú gól', rows: [[{ name: 'Áno', price: 1.94 }, { name: 'Nie', price: 1.74 }]] },
  { name: 'Handicap', rows: [[{ name: 'Tím 1 (-0.5)', price: 2.5 }, { name: 'Tím 2 (+0.5)', price: 1.54 }], [{ name: 'Tím 1 (-1)', price: 3 }, { name: 'Tím 2 (+1)', price: 1.4 }]] },
  { name: 'Tím1 celkový počet gólov', rows: [[{ name: 'Pod (0.5)', price: 2.92 }, { name: 'Nad (0.5)', price: 1.36 }]] },
  { name: 'Kazachstan celkový počet gólov', rows: [[{ name: 'Pod (0.5)', price: 2.6 }, { name: 'Nad (0.5)', price: 1.44 }]] },
  { name: 'Presný výsledok', rows: [[{ name: '1:0', price: 6 }]] }, // not a market we use
];
const out = marketsOf('football', 'Moldavsko', 'Kazachstan', games);
const k = o => `${o.market}|${o.point ?? ''}|${o.sel}|${o.price}`;
assert.deepStrictEqual(out.map(k).sort(), [
  'away_totals|0.5|O|1.44', 'away_totals|0.5|U|2.6',
  'btts||N|1.74', 'btts||Y|1.94',
  'dnb||1|1.73', 'dnb||2|2.07',
  'h2h||1|2.61', 'h2h||12|1.33', 'h2h||1X|1.39', 'h2h||2|3.14', 'h2h||X|3.05', 'h2h||X2|1.53',
  'home_totals|0.5|O|1.36', 'home_totals|0.5|U|2.92',
  'spreads|-0.5|A|1.54', 'spreads|-0.5|H|2.5',
  'totals|2.5|O|2.4', 'totals|2.5|U|1.58',
].sort());
// hockey: regular time vs overtime-inclusive stay apart
const hk = marketsOf('hockey', 'A', 'B', [
  { name: 'Celkový počet gólov', rows: [[{ name: 'Pod (5.5)', price: 1.8 }, { name: 'Nad (5.5)', price: 1.9 }]] },
  { name: 'Počet gólov (vrátane predĺženia a nájazdov)', rows: [[{ name: 'Pod (5.5)', price: 1.7 }, { name: 'Nad (5.5)', price: 2.0 }]] },
  { name: 'Víťaz (vrátane predĺženia a nájazdov)', rows: [[{ name: '1', price: 1.6 }, { name: '2', price: 2.3 }]] },
]);
assert.deepStrictEqual([...new Set(hk.map(o => o.market))].sort(), ['ot_h2h', 'ot_totals', 'totals']);

// surebets on the new markets: over 2.5 at one book, under at another
const ev = { id: 'e', sport: 'football', home: 'A', away: 'B', drawPossible: true, start: 1, odds: [
  { book: 'tipos', market: 'totals', point: 2.5, sel: 'O', price: 2.2 }, { book: 'tipos', market: 'totals', point: 2.5, sel: 'U', price: 1.6 },
  { book: 'synottip', market: 'totals', point: 2.5, sel: 'U', price: 1.95 }, { book: 'synottip', market: 'totals', point: 2.5, sel: 'O', price: 1.8 },
  { book: 'tipos', market: 'btts', point: null, sel: 'Y', price: 2.1 }, { book: 'synottip', market: 'btts', point: null, sel: 'N', price: 2.05 },
  { book: 'tipos', market: 'totals', point: 3.5, sel: 'O', price: 3 }, { book: 'synottip', market: 'totals', point: 2.5, sel: 'X', price: 9 }] };
const sbs = findSurebets([ev], { minProfitPct: 1, bankroll: 30, step: 1 });
const totals = sbs.find(x => x.market === 'totals');
assert.ok(totals && totals.point === 2.5 && totals.legs.map(l => l.book + l.sel).sort().join() === 'synottipU,tiposO');
assert.strictEqual(marketLabel(totals), 'Over 2.5 vs Under 2.5');
assert.ok(sbs.find(x => x.market === 'btts'));
assert.ok(!sbs.some(x => x.market === 'totals' && x.point === 3.5)); // no under 3.5 anywhere

// auto bets: a new market only where clicking it is set up (sites.betMarkets)
const s = { autoMinProfitPct: 3, autoPrematchOnly: false, autoBetSuspect: true }; // test prices make it look suspect
assert.strictEqual(betAllowed(s, { ...totals, profitPct: 5 }), null); // tipos + synottip: set up
assert.ok(/not set up: totals at nike/.test(betAllowed(s, { ...totals, profitPct: 5, legs: [totals.legs[0], { ...totals.legs[1], book: 'nike' }] })));
assert.ok(/not set up/.test(betAllowed(s, { ...totals, market: 'ot_totals', profitPct: 5 })));
console.log('market tests passed');

// stale-odds filters
{
  const { dropStale } = require('../src/arb');
  const q = (book, sel, price) => ({ book, market: 'h2h', point: null, sel, price });
  // DOXX 1X2 2.0 / 3.4 / 4.0 implies 1X ~1.26; a 1X at 1.40 is stale and goes, 1.30 stays
  let o = dropStale([q('doxxbet', '1', 2.0), q('doxxbet', 'X', 3.4), q('doxxbet', '2', 4.0), q('doxxbet', '1X', 1.4), q('nike', '1X', 1.3)]);
  assert.ok(!o.some(x => x.book === 'doxxbet' && x.sel === '1X') && o.some(x => x.book === 'nike'));
  o = dropStale([q('doxxbet', '1', 2.0), q('doxxbet', 'X', 3.4), q('doxxbet', '2', 4.0), q('doxxbet', '1X', 1.3)]);
  assert.ok(o.some(x => x.sel === '1X'));
  // flipped favourite: tipos has home as favourite, three books have away
  o = dropStale([q('tipos', '1', 1.5), q('tipos', '2', 2.6), q('nike', '1', 2.5), q('nike', '2', 1.55), q('doxxbet', '1', 2.6), q('doxxbet', '2', 1.5), q('tipsport', '1', 2.4), q('tipsport', '2', 1.6)]);
  assert.ok(!o.some(x => x.book === 'tipos') && o.filter(x => x.book !== 'tipos').length === 6);
  // two books disagreeing is not enough to call either one stale
  o = dropStale([q('tipos', '1', 1.9), q('tipos', '2', 1.95), q('nike', '1', 1.95), q('nike', '2', 1.9)]);
  assert.strictEqual(o.length, 4);
  console.log('stale filter tests passed');
}

// DOXXbet match detail -> extra markets
{
  const { parseDetail } = require('../src/providers/browser/doxxbet');
  const ect = (id, ct, name) => ({ EventChanceTypeID: id, ChanceTypeID: ct, ChanceTypeName: name, EventChanceTypeStatus: 'active' });
  const odd = (id, tip, rate, st = 'active') => ({ EventChanceTypeID: id, TipType: tip, OddsRate: rate, Status: st });
  const j = {
    EventChanceTypes: { a: ect(1, 'uf:18', 'Počet gólov 2.5'), b: ect(2, 'uf:18', 'Počet gólov 2'), c: ect(3, 'uf:16', 'Handicap góly +0.5/-0.5'),
      d: ect(4, 'uf:29', 'Oba tímy dajú gól'), e: ect(5, 'uf:11', 'Výsledok bez remízy'), f: ect(6, 'uf:19', 'Počet gólov Moldavsko 1.5'), g: ect(7, 'uf:18', 'Počet gólov 3.5') },
    Odds: { 1: odd(1, '1', 2.4), 2: odd(1, '2', 1.57), 3: odd(2, '1', 1.3), 4: odd(2, '2', 3.4), 5: odd(3, '1', 1.4), 6: odd(3, '2', 2.95),
      7: odd(4, '1', 1.95), 8: odd(4, '2', 1.87), 9: odd(5, '1', 1.7), 10: odd(5, '2', 2.03), 11: odd(6, '1', 2.7), 12: odd(6, '2', 1.47),
      13: odd(7, '1', 4.2), 14: odd(7, '2', 1.2, 'suspended') },
  };
  const o = parseDetail(j, 'L', 5).map(x => `${x.market}|${x.point ?? ''}|${x.sel}|${x.price}`).sort();
  assert.deepStrictEqual(o, ['btts||N|1.87', 'btts||Y|1.95', 'dnb||1|1.7', 'dnb||2|2.03', 'home_totals|1.5|O|2.7', 'home_totals|1.5|U|1.47',
    'spreads|0.5|A|2.95', 'spreads|0.5|H|1.4', 'totals|2.5|O|2.4', 'totals|2.5|U|1.57'].sort()); // whole line 2 and the half-suspended 3.5 left out
  console.log('doxxbet detail tests passed');
}

// Niké match detail -> extra markets
{
  const { parseDetail } = require('../src/providers/browser/nike');
  const cell = (name, odds, extra = {}) => ({ type: 'selection', name, odds, enabled: true, ...extra });
  const j = {
    sportEvents: [{ sportId: '1', participants: ['Moldavsko', 'Kazachstan'] }],
    markets: [{ marketId: 1, name: 'Počet gólov v zápase' }, { marketId: 2, name: 'Handicap' }, { marketId: 3, name: 'Obaja dajú gól' }, { marketId: 4, name: 'Stávka bez remízy' }, { marketId: 5, name: 'Počet gólov dom.' }],
    bets: [
      { marketId: 1, selectionGrid: [[cell('menej ako 2.5', 1.54), cell('viac ako 2.5', 2.39)]] },
      { marketId: 1, selectionGrid: [[cell('menej ako 2.0', 1.98), cell('viac ako 2.0', 1.77)]] }, // whole line: out
      { marketId: 2, selectionGrid: [[cell('Moldavsko -1.5', 5), cell('Kazachstan +1.5', 1.15)]] },
      { marketId: 3, selectionGrid: [[cell('áno', 1.96), cell('nie', 1.75)]] },
      { marketId: 4, selectionGrid: [[cell('Moldavsko', 1.74), cell('Kazachstan', 2.06)]] },
      { marketId: 5, selectionGrid: [[cell('menej ako 1.5', 1.41), cell('viac ako 1.5', 2.8, { locked: true })]] }, // locked: out
      { marketId: 3, validationRules: { minMultiple: 3 }, selectionGrid: [[cell('áno', 9), cell('nie', 9)]] },
    ],
  };
  const o = parseDetail(j, 'L', 1).map(x => `${x.market}|${x.point ?? ''}|${x.sel}|${x.price}`).sort();
  assert.deepStrictEqual(o, ['btts||N|1.75', 'btts||Y|1.96', 'dnb||1|1.74', 'dnb||2|2.06', 'spreads|-1.5|A|1.15', 'spreads|-1.5|H|5', 'totals|2.5|O|2.39', 'totals|2.5|U|1.54'].sort());
  console.log('nike detail tests passed');
}

// Tipsport / Chance match detail -> extra markets
{
  const { parseDetail } = require('../src/providers/browser/tipsportDetail');
  const c = (name, oppNumber, odd, active = true) => ({ name, oppNumber, odd, active });
  const j = { match: { nameFull: 'Moldavsko - Kazachstan', eventTables: [
    { name: 'Počet gólov v zápase', boxes: [{ cells: [c('Menej ako 2.5', 1, 1.59), c('Viac ako 2.5', 2, 2.39)] }, { cells: [c('Menej ako 1.25 (1.0, 1.5)', 3, 3.5), c('Viac ako 1.25 (1.0, 1.5)', 4, 1.3)] }] },
    { name: 'Výsledok zápasu bez remízy', boxes: [{ cells: [c('Moldavsko', 11, 1.75), c('Kazachstan', 15, 2.11)] }] },
    { name: 'Handicap v zápase', boxes: [{ cells: [c('Moldavsko -1.5', 8006, 5.8), c('Kazachstan +1.5', 8106, 1.14)] }] },
    { name: 'Každý tím dá v zápase', boxes: [{ name: '1 a viac gólov', cells: [c('Áno', 301, 1.9), c('Nie', 326, 1.81)] }, { name: '2 a viac gólov', cells: [c('Áno', 302, 7.4), c('Nie', 327, 1.08)] }] },
    { name: 'Počet gólov tímu v zápase', boxes: [{ name: 'Moldavsko', cells: [c('Menej ako 0.5', 1601, 3.05), c('Viac ako 0.5', 1701, 1.32)] }, { name: 'Kazachstan', cells: [c('Menej ako 0.5', 1801, 2.7), c('Viac ako 0.5', 1901, 1.4, false)] }] },
  ] } };
  const o = parseDetail(j, 'chance', 'L', 1).map(x => `${x.market}|${x.point ?? ''}|${x.sel}|${x.price}`).sort();
  assert.deepStrictEqual(o, ['btts||N|1.81', 'btts||Y|1.9', 'dnb||1|1.75', 'dnb||2|2.11', 'home_totals|0.5|O|1.32', 'home_totals|0.5|U|3.05',
    'spreads|-1.5|A|1.14', 'spreads|-1.5|H|5.8', 'totals|2.5|O|2.39', 'totals|2.5|U|1.59'].sort());
  console.log('tipsport detail tests passed');
}

// legs that know their exact button (pick) may be bet on any book; legs without one only where set up
{
  const { betAllowed } = require('../src/bettor');
  const s = { autoMinProfitPct: 3, autoPrematchOnly: false, autoBetSuspect: true };
  const sb = { market: 'totals', point: 2.5, profitPct: 5, live: false, legs: [
    { book: 'nike', sel: 'O', price: 2.2, pick: { css: '[title^="Číslo zápasu: 1 |"] a', label: 'viac ako 2.5' } },
    { book: 'doxxbet', sel: 'U', price: 1.95, pick: { css: '.Odd_1' } }] };
  assert.strictEqual(betAllowed(s, sb), null);
  assert.ok(/not set up: totals at doxxbet/.test(betAllowed(s, { ...sb, legs: [sb.legs[0], { ...sb.legs[1], pick: undefined }] })));
  console.log('pick gate tests passed');
}

// side check: a book's handicap / DNB sides must agree with its own 1X2 favourite (turned sides dropped)
{
  const { dropStale, findSurebets } = require('../src/arb');
  const q = (book, market, sel, price, point = null) => ({ book, market, point, sel, price });
  // Brazil clear favourite at DOXXbet (1.5 vs 6), but its handicap says Japan +0.5 is cheap: turned -> dropped
  const odds = [q('doxxbet', 'h2h', '1', 1.5), q('doxxbet', 'h2h', 'X', 4.2), q('doxxbet', 'h2h', '2', 6),
    q('doxxbet', 'spreads', 'H', 3.25, 0.5), q('doxxbet', 'spreads', 'A', 1.3, 0.5), q('doxxbet', 'dnb', '1', 4.5), q('doxxbet', 'dnb', '2', 1.15),
    q('tipos', 'h2h', '1', 1.5), q('tipos', 'h2h', 'X', 4.3), q('tipos', 'h2h', '2', 6.2), q('tipos', 'spreads', 'H', 1.25, 0.5), q('tipos', 'spreads', 'A', 3.6, 0.5)];
  const kept = dropStale(odds);
  assert.ok(!kept.some(o => o.book === 'doxxbet' && /spreads|dnb/.test(o.market)));
  assert.ok(kept.some(o => o.book === 'tipos' && o.market === 'spreads'));
  const ev = { id: 'bj', sport: 'football', home: 'Brazília', away: 'Japonsko', drawPossible: true, start: 1, odds };
  assert.ok(!findSurebets([ev], { minProfitPct: 1, bankroll: 30, step: 1 }).some(sb => sb.market === 'spreads' || sb.market === 'dnb'));
  console.log('side check tests passed');
}

// cross-market surebets: DNB 1 + X2, hockey OT winner 1 + regular-time X2
{
  const { findSurebets, marketLabel } = require('../src/arb');
  const q = (book, market, sel, price) => ({ book, market, point: null, sel, price });
  const ev = { id: 'cx', sport: 'football', home: 'A', away: 'B', drawPossible: true, start: 1, odds: [
    // realistic, consistent book markets (each over 100 %; away favoured at Tipos in 1X2 and in DNB alike)
    q('nike', 'h2h', '1', 2.6), q('nike', 'h2h', 'X', 3.3), q('nike', 'h2h', '2', 2.7), q('nike', 'h2h', 'X2', 1.55),
    q('tipos', 'dnb', '1', 2.9), q('tipos', 'dnb', '2', 1.4), q('tipos', 'h2h', '1', 3.6), q('tipos', 'h2h', 'X', 3.3), q('tipos', 'h2h', '2', 2.05)] };
  const sb = findSurebets([ev], { minProfitPct: 0, bankroll: 30 }).find(x => x.market === 'x_dnb1_X2');
  assert.ok(sb, 'DNB 1 (2.90) vs X2 (1.55): 1/2.9 + 1/1.55 = 0.99 < 1');
  assert.deepStrictEqual(sb.legs.map(l => `${l.book} ${l.market} ${l.sel}`).sort(), ['nike h2h X2', 'tipos dnb 1']);
  assert.strictEqual(marketLabel(sb), 'Draw no bet 1 vs X2');
  console.log('cross-market tests passed');
}

// Chance basketball: the list row is the regular-time 1/1X/X/X2/2 market, never read as the winner incl. overtime
{
  const assert = require('assert');
  const chance = require('../src/providers/browser/chance');
  const m = (rows) => ({ offerSuperSports: [{ tabs: [{ offerCompetitionAnnuals: [{ name: 'NBA', matches: [{ participantHome: 'Cleveland', participantVisiting: 'Dallas', url: '/x/1', dateClosed: '2026-11-14T18:00:00Z', oppRows: rows }] }] }] }] });
  const op = (type, odd) => ({ type, odd, bettingEnabled: true, id: type });
  const threeWay = [{ oppsTab: [op('1', 2.24), op('1x', 1.97), op('x', 14), op('x2', 1.64), op('2', 1.83)] }];
  assert.strictEqual(chance.parse(m(threeWay), 'basketball').length, 0);
  const twoWay = [{ oppsTab: [op('1', 1.6), op('2', 2.3)] }];
  assert.deepStrictEqual(chance.parse(m(twoWay), 'basketball')[0].odds.map(o => `${o.sel}@${o.price}`), ['1@1.6', '2@2.3']);
  assert.strictEqual(chance.parse(m(threeWay), 'football')[0].odds.length, 5); // football keeps 1/X/2 and double chance
  console.log('chance 3-way basketball tests passed');
}
