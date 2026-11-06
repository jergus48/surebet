const assert = require('assert');
const { applyStakeCaps, stillProfitable } = require('../src/bettor');
const settings = { roundStakeTo: 1, autoMinProfitPct: 2, bookmakers: { a: { maxStakePerBet: 20 }, b: { maxStakePerBet: 100 }, c: {} } };
const sb = { legs: [{ book: 'a', sel: '1', price: 2.2, stake: 50 }, { book: 'b', sel: '2', price: 2.2, stake: 50 }], staked: 100, worstProfit: 10 };
// cap 20 on book a: both legs scale down by 0.4 -> 20 / 20, still balanced
let r = applyStakeCaps(settings, sb);
assert.deepStrictEqual(r.sb.legs.map(l => l.stake), [20, 20]);
assert.strictEqual(r.sb.staked, 40);
assert.ok(r.sb.worstProfit > 0);
// a book without a cap blocks auto
r = applyStakeCaps(settings, { ...sb, legs: [sb.legs[0], { ...sb.legs[1], book: 'c' }] });
assert.ok(r.error && /bankroll/.test(r.error));
// under all caps: unchanged
r = applyStakeCaps({ ...settings, bookmakers: { a: { maxStakePerBet: 500 }, b: { maxStakePerBet: 500 } } }, sb);
assert.strictEqual(r.sb, sb);
// slip re-check: odds dropped on one slip so it is no longer profitable
const legs = [{ stake: 50, price: 2.2, slipPrice: 2.2 }, { stake: 50, price: 2.2, slipPrice: 1.95 }];
assert.strictEqual(stillProfitable(settings, legs).ok, false);
assert.strictEqual(stillProfitable(settings, [{ stake: 50, price: 2.2 }, { stake: 50, price: 2.2 }]).ok, true);
console.log('bettor tests passed');

// percentage cap: bankroll 400 at 5% = 20 per bet on book a
{
  const s = { roundStakeTo: 1, autoMinProfitPct: 2, bookmakers: { a: { bankroll: 400, stakePercent: 5 }, b: { maxStakePerBet: 100 } } };
  const sb = { legs: [{ book: 'a', sel: '1', price: 2.2, stake: 50 }, { book: 'b', sel: '2', price: 2.2, stake: 50 }], staked: 100, worstProfit: 10 };
  const r = applyStakeCaps(s, sb);
  assert.deepStrictEqual(r.sb.legs.map(l => l.stake), [20, 20]);
  console.log('percent cap tests passed');
}

{
  const { parseMoney } = require('../src/bettor');
  assert.strictEqual(parseMoney('1 234,56 €'), 1234.56);
  assert.strictEqual(parseMoney('€1,234.56'), 1234.56);
  assert.strictEqual(parseMoney('12.5'), 12.5);
  assert.strictEqual(parseMoney('abc'), null);
  console.log('money parse tests passed');
}
