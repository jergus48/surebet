const assert = require('assert');
const { findSurebets, stakes } = require('../src/arb');

const ev = (odds, extra = {}) => ({ id: 'e1', sport: 's', sportTitle: 'Tenis', league: 'L', home: 'A', away: 'B', start: 0, live: false, drawPossible: false, odds, ...extra });
const o = (book, sel, price, market = 'h2h', point = null) => ({ book, sel, price, market, point });

// 2-way arb across two books: 1/2.1 + 1/2.1 = 0.952 -> 5.0%
let r = findSurebets([ev([o('tipsport', '1', 2.1), o('tipsport', '2', 1.7), o('bet365', '1', 1.7), o('bet365', '2', 2.1)])]);
assert.strictEqual(r.length, 1);
assert.strictEqual(r[0].profitPct, 5);
assert.deepStrictEqual(r[0].legs.map(l => l.book), ['tipsport', 'bet365']);

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
