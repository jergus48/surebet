const assert = require('assert');
const { findSurebets, stakes } = require('../src/arb');

const ev = (odds, extra = {}) => ({ id: 'e1', sport: 's', sportTitle: 'Tenis', league: 'L', home: 'A', away: 'B', start: 0, live: false, drawPossible: false, odds, ...extra });
const o = (book, sel, price, market = 'h2h', point = null) => ({ book, sel, price, market, point });

// 2-way arb across two books: 1/2.1 + 1/2.1 = 0.952 -> 5.0%
let r = findSurebets([ev([o('tipsport', '1', 2.1), o('tipsport', '2', 1.7), o('bet365', '1', 1.7), o('bet365', '2', 2.1)])]);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].profitPct, 5);
assert.deepStrictEqual(r[0].legs.map(l => l.book), ['tipsport', 'bet365']);

// A book's own team spelling (bet365 is German) rides along on its leg for the slip check.
{
  const named = { ...o('bet365', '2', 2.1), home: 'Slowakei', away: 'Färöer' };
  const s = findSurebets([ev([o('tipsport', '1', 2.1), named])])[0];
  assert.deepStrictEqual([s.legs[1].home, s.legs[1].away], ['Slowakei', 'Färöer']);
  assert.strictEqual(s.legs[0].home, undefined);
}

// No arb when margins overlap
r = findSurebets([ev([o('tipsport', '1', 1.9), o('tipsport', '2', 1.9), o('bet365', '1', 1.85), o('bet365', '2', 1.95)])]);
assert.strictEqual(r.length, 0);

// Single-book "arb" is ignored
r = findSurebets([ev([o('tipsport', '1', 2.2), o('tipsport', '2', 2.2)])]);
assert.strictEqual(r.length, 0);

// Soccer without a draw price is never treated as 2-way
r = findSurebets([ev([o('tipsport', '1', 2.5), o('bet365', '2', 2.5)], { drawPossible: true })]);
assert.strictEqual(r.length, 0);

// 3-way: 1/3.2 + 1/3.8 + 1/3.3 = 0.8787 -> 13.81%
r = findSurebets([ev([o('a', '1', 3.2), o('b', 'X', 3.8), o('c', '2', 3.3)], { drawPossible: true })]);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].legs.length, 3);
assert.strictEqual(r[0].profitPct, 13.81);

// Double chance: 1 @ 2.3 (bet365) vs X2 @ 1.9 (tipsport): 0.4348 + 0.5263 = 0.9611 -> 4.05%
r = findSurebets([ev([o('bet365', '1', 2.3), o('bet365', 'X', 3.2), o('bet365', '2', 3.0), o('tipsport', 'X2', 1.9), o('tipsport', '1', 2.1)], { drawPossible: true })]);
assert.strictEqual(r.length, 1);
assert.deepStrictEqual(r[0].legs.map(l => `${l.book}:${l.sel}`), ['bet365:1', 'tipsport:X2']);
assert.strictEqual(r[0].profitPct, 4.05);

// Totals only pair the same line
r = findSurebets([ev([o('a', 'O', 2.1, 'totals', 2.5), o('b', 'U', 2.1, 'totals', 3.5)])]);
assert.strictEqual(r.length, 0);
r = findSurebets([ev([o('a', 'O', 2.1, 'totals', 2.5), o('b', 'U', 2.1, 'totals', 2.5)])]);
assert.strictEqual(r.length, 1);

// Book filter
r = findSurebets([ev([o('tipsport', '1', 2.1), o('pinnacle', '2', 2.1), o('bet365', '2', 1.5)])], { books: new Set(['tipsport', 'bet365']) });
assert.strictEqual(r.length, 0);

// Stakes equalize payout and stay profitable after rounding
const st = stakes([2.1, 2.1], 100, 1);
assert.deepStrictEqual(st.stakes, [50, 50]);
assert.ok(st.worstProfit > 0);

console.log('arb tests passed');

// outlier flag: one book far above the others is marked
{
  const { findSurebets } = require('../src/arb');
  const ev = { id: 'o1', sport: 'football', sportTitle: 'Football', league: 'x', home: 'A', away: 'B', start: Date.now() + 3600e3, live: false, drawPossible: true, odds: [
    { book: 'fortuna', market: 'h2h', point: null, sel: '2', price: 2.3 }, { book: 'synottip', market: 'h2h', point: null, sel: '2', price: 1.67 }, { book: 'tipsport', market: 'h2h', point: null, sel: '2', price: 1.65 },
    { book: 'synottip', market: 'h2h', point: null, sel: '1X', price: 1.88 }] };
  const r = findSurebets([ev], { minProfitPct: 2 });
  const f = r.find(s => s.legs.some(l => l.book === 'fortuna'));
  if (!f || !f.legs.find(l => l.book === 'fortuna').outlier) throw new Error('outlier flag missing');
  if (f.legs.find(l => l.book === 'synottip').outlier) throw new Error('false outlier');
  if (!f.suspect) throw new Error('suspect flag missing');
  const calm = findSurebets([{ ...ev, drawPossible: false, odds: [
    { book: 'a', market: 'h2h', point: null, sel: '1', price: 2.2, linkGeneric: true }, { book: 'b', market: 'h2h', point: null, sel: '2', price: 2.2 }] }], { minProfitPct: 2, });
  if (!calm.length || calm[0].suspect) throw new Error('false suspect');
  if (!calm[0].legs.find(l => l.book === 'a').linkGeneric) throw new Error('linkGeneric not passed through');
  console.log('outlier tests passed');
}

// stake tiers: bigger profit -> bigger total stake
{
  const { findSurebets } = require('../src/arb');
  const mk = (p1, p2) => [{ id: 't', sport: 'tennis', sportTitle: 'Tennis', league: 'x', home: 'A', away: 'B', start: Date.now() + 3600e3, live: false, drawPossible: false, odds: [
    { book: 'a', market: 'h2h', point: null, sel: '1', price: p1 }, { book: 'b', market: 'h2h', point: null, sel: '2', price: p2 }] }];
  const tiers = [{ minProfitPct: 2, stake: 10 }, { minProfitPct: 5, stake: 20 }];
  const lo = findSurebets(mk(2.06, 2.06), { minProfitPct: 2, stakeTiers: tiers })[0];   // ~3.0%
  const hi = findSurebets(mk(2.2, 2.2), { minProfitPct: 2, stakeTiers: tiers })[0];     // ~10%
  if (Math.abs(lo.staked - 10) > 1 || Math.abs(hi.staked - 20) > 1) throw new Error(`tier stakes wrong: ${lo.staked} / ${hi.staked}`);
  console.log('tier tests passed');
}

// small uneven surebets keep their profit: 4 EUR on 1.35 / 4.80 (+5.3 %)
{
  const { bestSplit, findSurebets } = require('../src/arb');
  const half = bestSplit([1.35, 4.8], 4, 0.5);
  assert.ok(half.worstProfit / half.staked < 0.015); // 0.50 steps: ~1.25 %, too little
  const st = bestSplit([1.35, 4.8], 4, 0.1, 0.5);
  assert.ok(st.worstProfit / st.staked > 0.04, JSON.stringify(st)); // 0.10 steps: > 4 %
  assert.ok(st.staked <= 4 && st.stakes.every(x => x >= 0.5));
  const ev = { id: 'e', sport: 'hockey', home: 'A', away: 'B', drawPossible: false, odds: [
    { book: 'nike', market: 'h2h', sel: '1', price: 1.35 }, { book: 'doxxbet', market: 'h2h', sel: '2', price: 4.8 },
    { book: 'tipos', market: 'h2h', sel: '1', price: 1.3 }, { book: 'tipos', market: 'h2h', sel: '2', price: 4.4 }] };
  const found = findSurebets([ev], { minProfitPct: 2.2, bankroll: 4, step: 1 });
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].staked <= 4 && found[0].worstProfit / found[0].staked > 0.04);
  // big totals stay on the ideal split
  assert.deepStrictEqual(bestSplit([2.1, 2.1], 100, 1).stakes, [50, 50]);
  console.log('small-stake split tests passed');
}

// flipped favourite: never bet, except live with the very same names at every book (a lagging live line)
{
  const assert = require('assert');
  const { findSurebets } = require('../src/arb');
  const mk = (live, n2) => ({ id: 't', sport: 'tabletennis', home: 'Filbrandt Tomasz', away: 'Chrzescian Radoslaw', start: 1, live, drawPossible: false,
    names: { tipsport: 'Filbrandt Tomasz - Chrzescian Radoslaw (TT Elite Series)', doxxbet: n2 },
    odds: [{ book: 'tipsport', market: 'h2h', sel: '1', price: 2.15 }, { book: 'tipsport', market: 'h2h', sel: '2', price: 1.6 },
      { book: 'doxxbet', market: 'h2h', sel: '1', price: 1.55 }, { book: 'doxxbet', market: 'h2h', sel: '2', price: 2.25 }] });
  const fl = ev => findSurebets([ev], { minProfitPct: 1, maxProfitPct: 20, bankroll: 30, step: 1, includeLive: true })[0].flipped;
  assert.strictEqual(fl(mk(true, 'Filbrandt Tomasz - Chrzescian Radoslaw (Elite Series)')), false);
  assert.strictEqual(fl(mk(false, 'Filbrandt Tomasz - Chrzescian Radoslaw')), true); // pre-match: still never
  assert.strictEqual(fl(mk(true, 'Filbrandt T. - Chrzescian R.')), true);              // names differ: still never
  // the other way round at DOXXbet, its prices turned by the matcher: same two players, certain
  const rev = mk(true, 'Chrzescian Radoslaw - Filbrandt Tomasz');
  rev.odds = rev.odds.map(o => (o.book === 'doxxbet' ? { ...o, swapped: true } : o));
  assert.strictEqual(fl(rev), false);
  // listed the other way round but NOT turned: the prices would be on the wrong sides, never
  assert.strictEqual(fl(mk(true, 'Chrzescian Radoslaw - Filbrandt Tomasz')), true);
  console.log('flipped live exception tests passed');
}

// far from kick-off: prices up to 10 min old still count; near kick-off and live: maxOddsAgeSec
{
  const assert = require('assert');
  const { findSurebets } = require('../src/arb');
  const now = 1e12;
  const ev = (startIn, live = false) => ({ id: 'f', sport: 'tennis', home: 'A', away: 'B', start: now + startIn, live, drawPossible: false,
    odds: [{ book: 'a', market: 'h2h', sel: '1', price: 2.2, updated: now - 5 * 60e3 }, { book: 'b', market: 'h2h', sel: '2', price: 2.2, updated: now }] });
  const n = e => findSurebets([e], { minProfitPct: 1, bankroll: 30, step: 1, maxAgeMs: 180e3, now }).length;
  assert.strictEqual(n(ev(24 * 3600e3)), 1);   // tomorrow: a 5-min-old price counts
  assert.strictEqual(n(ev(2 * 3600e3)), 0);    // in 2 hours: too old
  assert.strictEqual(n(ev(24 * 3600e3, true)), 0); // live: too old
  const { ttlFor } = require('../src/providers/browser/detailQueue');
  assert.strictEqual(ttlFor(Date.now() + 24 * 3600e3, 170000), 590000);
  assert.strictEqual(ttlFor(Date.now() + 3600e3, 170000), 170000);
  console.log('far kick-off age tests passed');
}
