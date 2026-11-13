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
// the FULL minimum counts on the slips: 2.1 / 2.1 is +5%, fine at 3 %, not at 6 %
const even = [{ stake: 50, price: 2.1, slipPrice: 2.1 }, { stake: 50, price: 2.1, slipPrice: 2.1 }];
assert.strictEqual(stillProfitable({ autoMinProfitPct: 3 }, even).ok, true);
assert.strictEqual(stillProfitable({ autoMinProfitPct: 6 }, even).ok, false);
// a slip whose price could not be read never passes
assert.strictEqual(stillProfitable({ autoMinProfitPct: 3 }, [even[0], { ...even[1], slipPrice: 0 }]).ok, false);
// 4 EUR on 1.35 / 4.80 splits 3.1 / 0.9: over a 3 cap, re-split under it with the profit kept
{
  const { findSurebets } = require('../src/arb');
  const ev = { id: 'e', sport: 'hockey', home: 'A', away: 'B', drawPossible: false, odds: [
    { book: 'a', market: 'h2h', sel: '1', price: 1.35 }, { book: 'b', market: 'h2h', sel: '2', price: 4.8 }] };
  const [f] = findSurebets([ev], { minProfitPct: 2.2, bankroll: 4, step: 1 });
  const c = applyStakeCaps({ roundStakeTo: 1, bookmakers: { a: { maxStakePerBet: 3 }, b: { maxStakePerBet: 3 } } }, f);
  assert.ok(!c.error, c.error);
  assert.ok(c.sb.legs.every(l => l.stake <= 3 && l.stake >= 0.5));
  assert.ok(stillProfitable({ autoMinProfitPct: 2.2 }, c.sb.legs).ok, JSON.stringify(c.sb.legs));
}
console.log('bettor tests passed');

// which new surebets get a bet at all (fill and auto)
{
  const { betAllowed } = require('../src/bettor');
  const s = { autoMinProfitPct: 3, autoPrematchOnly: true };
  assert.strictEqual(betAllowed(s, { profitPct: 3.5, live: false }), null);
  assert.ok(/< 3%/.test(betAllowed(s, { profitPct: 2.9, live: false })));
  assert.ok(/pre-match/.test(betAllowed(s, { profitPct: 5, live: true })));
  assert.ok(/suspect/.test(betAllowed(s, { profitPct: 5, live: false, suspect: true })));
  assert.strictEqual(betAllowed({ ...s, autoBetSuspect: true }, { profitPct: 5, live: false, suspect: true }), null);
  // live: pre-match-only off, own minimum (default 4 %), also on the slip re-check
  const sl = { autoMinProfitPct: 3, autoPrematchOnly: false, autoLiveMinProfitPct: 4 };
  assert.ok(/< 4% \(live\)/.test(betAllowed(sl, { profitPct: 3.5, live: true })));
  assert.strictEqual(betAllowed(sl, { profitPct: 4.2, live: true }), null);
  assert.strictEqual(betAllowed(sl, { profitPct: 3.5, live: false }), null);
  assert.ok(/< 4%/.test(betAllowed({ autoMinProfitPct: 3 }, { profitPct: 3.9, live: true }))); // default 4
  const live45 = [{ stake: 50, price: 2.1, slipPrice: 2.1 }, { stake: 50, price: 2.1, slipPrice: 2.07 }]; // +3.5 %
  assert.strictEqual(stillProfitable(sl, live45, false).ok, true);
  assert.strictEqual(stillProfitable(sl, live45, true).ok, false);
  // live stakes: at most 2 per surebet, 0.10 steps, 0.50 min a leg, best locked profit
  const { liveStakes } = require('../src/bettor');
  const lsb = { live: true, staked: 4, legs: [{ book: 'a', price: 2.1, stake: 2 }, { book: 'b', price: 2.1, stake: 2 }] };
  let ls = liveStakes({}, lsb);
  assert.deepStrictEqual(ls.sb.legs.map(l => l.stake), [1, 1]);
  ls = liveStakes({}, { ...lsb, legs: [{ book: 'a', price: 1.35, stake: 3 }, { book: 'b', price: 4.8, stake: 1 }] });
  assert.ok(ls.sb.staked <= 2 && ls.sb.worstProfit > 0 && ls.sb.legs.every(l => l.stake >= 0.5));
  // 1.3 / 4.6 is only +1.3 %: with 0.50 min a leg nothing locks in -> refused
  assert.ok(liveStakes({}, { ...lsb, legs: [{ book: 'a', price: 1.1, stake: 3 }, { book: 'b', price: 11, stake: 1 }] }).error);
  // pre-match untouched
  assert.strictEqual(liveStakes({}, { ...lsb, live: false }).sb.staked, 4);
  console.log('bet filter tests passed');
}

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

// a stopped leg takes its pick back off the slip; auto never falls back to fill
(async () => {
  const { unpick, execute } = require('../src/bettor');
  const fakePage = slip => ({ $$eval: async () => slip.picked ? ['2.10'] : [] });
  const toggle = slip => ({ boundingBox: async () => ({ x: 1 }), click: async () => { slip.picked = !slip.picked; } });
  let slip = { picked: true };
  assert.strictEqual(await unpick(fakePage(slip), { slipOdds: '.x' }, toggle(slip), 'a'), true);
  assert.strictEqual(slip.picked, false);
  slip = { picked: true }; // the button is gone: cannot clear, says so
  assert.strictEqual(await unpick(fakePage(slip), { slipOdds: '.x' }, null, 'a'), false);
  slip = { picked: false }; // already empty: nothing to click
  assert.strictEqual(await unpick(fakePage(slip), { slipOdds: '.x' }, null, 'a'), true);
  const r = await execute({ betMode: 'auto', autoMinProfitPct: 3, autoPrematchOnly: true, bookmakers: {} },
    { key: 'test-skip', profitPct: 2, live: false, legs: [] });
  assert.strictEqual(r.status, 'skipped');
  console.log('unpick / auto skip tests passed');
})().catch(e => { console.error(e); process.exit(1); });

// one match, one bet: a sibling surebet that starts while the first runs is skipped
(async () => {
  const { execute } = require('../src/bettor');
  const s = { betMode: 'fill', bookmakers: {}, alertsOnlyBets: true };
  const sb = k => ({ key: `ev-lock|h2h||${k}`, eventId: 'ev-lock', home: 'A', away: 'B', market: 'h2h', profitPct: 5, live: false, legs: [{ book: 'zz', sel: '1', price: 2.1, stake: 1 }] });
  const [a, b] = await Promise.all([execute(s, sb('x')), execute(s, sb('y'))]);
  assert.strictEqual(a.status, 'failed'); // book zz not enabled: fails before any browser work
  assert.deepStrictEqual(b, { status: 'skipped', detail: 'another bet on this match is running' });
  require('../src/db').db.prepare("DELETE FROM bets WHERE surebet_key LIKE 'ev-lock|%'").run();
  console.log('match lock tests passed');
})().catch(e => { console.error(e); process.exit(1); });

// bet attempts per match, read from the bets table (retries and "already bet")
{
  const db = require('../src/db');
  const id = db.addBet('ev-retry-test|h2h||a:1|b:2', 'auto', 'failed', '');
  let e = db.eventBets('ev-retry-test');
  assert.strictEqual(e.n, 1); assert.strictEqual(e.placed, false);
  db.setBet(id, 'placed', '');
  assert.strictEqual(db.eventBets('ev-retry-test').placed, true);
  assert.strictEqual(db.eventBets('ev-retry').n, 0); // prefix must end at the event id
  db.db.prepare("DELETE FROM bets WHERE surebet_key LIKE 'ev-retry-test|%' OR surebet_key LIKE 'ev-lock|%' OR surebet_key = 'test-skip'").run();
  console.log('event bets tests passed');
}

// open positions: slip messages that block a single bet, the worst outcome, and the cover plan
{
  const { SLIP_BLOCK_RE, worstPct, coverPlan } = require('../src/bettor');
  assert.ok(SLIP_BLOCK_RE.test('Zápasy na tikete vyžadujú počet tipov najmenej 3.'));
  assert.ok(!SLIP_BLOCK_RE.test('Počet tipov: 1 SYSTÉM Zlín U19 - Dukla Praha U19'));
  assert.ok(!SLIP_BLOCK_RE.test('Kurz 2.01 Ev. výhra 32.16 € Staviť 16.00 €'));
  assert.strictEqual(worstPct([{ stake: 13, price: 2.47 }, { stake: 16, price: 2.01, slipPrice: 2.01 }]), 10.72);
  // Šaľa case: Tipos 2 held, Niké 1X refused -> best 1X elsewhere (DOXXbet 1.90), Niké avoided
  require('../src/scanner').state.events = [{ id: 'football:Šaľa:Nové Zámky:1', odds: [
    { book: 'nike', market: 'h2h', point: null, sel: '1X', price: 2.01 },
    { book: 'doxxbet', market: 'h2h', point: null, sel: '1X', price: 1.9, link: 'https://dox/x' },
    { book: 'tipos', market: 'h2h', point: null, sel: '2', price: 2.47 }] }];
  const c = coverPlan({ eventId: 'football:Šaľa:Nové Zámky:1', market: 'h2h', point: null },
    [{ book: 'tipos', sel: '2', stake: 13, price: 2.47 }], [{ book: 'nike', sel: '1X', stake: 16, price: 2.01 }], ['nike']);
  assert.ok(/doxxbet 1X @ 1.9, stake 17 €/.test(c.text), c.text);
  assert.strictEqual(c.profit, 2.11);
  console.log('open position tests passed');
}
