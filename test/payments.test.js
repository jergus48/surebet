const assert = require('assert');
const { stableToken, stableId, candidates } = require('../src/bettor/selectors');
const { summary } = require('../src/money');
const { waitForDrop, placedStatus } = require('../src/bettor');

// Hashed CSS-in-JS classes are never used, readable ones are.
for (const t of ['OpportunityButton-styled__Odd-sc-b8dd6735-3', 'iZFHKG', 'css-1x2y3z', 'sc-abc123', 'active', 'x7k2p9']) assert.strictEqual(stableToken(t), false, t);
for (const t of ['odd-button', 'betslip__stake', 'balance', 'btn-primary', 'header-balance']) assert.strictEqual(stableToken(t), true, t);
assert.strictEqual(stableId('user-balance'), true);
assert.strictEqual(stableId('event-12345'), false);

// Unique element: data attribute and id come first.
const bal = [
  { tag: 'span', id: '', classes: ['amount', 'sc-x9f8e7d6'], attrs: { 'data-testid': 'user-balance' } },
  { tag: 'div', id: 'header', classes: ['user-panel'], attrs: {} },
];
const c = candidates(bal);
assert.strictEqual(c[0], '[data-testid="user-balance"]');
assert.ok(c.includes('span.amount'));
assert.ok(c.includes('#header span.amount'));
assert.ok(!c.some(x => /sc-x9f8e7d6/.test(x)));

// Many elements (all odds): no per-item values, attribute presence instead.
const odd = [{ tag: 'button', id: 'odd-998877', classes: ['odd'], attrs: { 'data-odd-id': '998877', 'data-role': 'odd' } }];
const m = candidates(odd, { many: true });
assert.ok(m.includes('button[data-odd-id]'));
assert.ok(m.includes('button[data-role="odd"]'));
assert.ok(!m.some(x => x.includes('998877')));
console.log('selector tests passed');

// Profit and shares: A put in 60, B 40, the pot is now 110 in the books + 20 withdrawn by B.
{
  const entries = [
    { person: 'A', book: 'tipsport', type: 'deposit', amount: 30 }, { person: 'A', book: 'tipos', type: 'deposit', amount: 30 },
    { person: 'B', book: 'tipsport', type: 'deposit', amount: 40 }, { person: 'B', book: 'tipsport', type: 'withdrawal', amount: 20 },
  ];
  const s = summary(entries, { tipsport: 60, tipos: 50 });
  assert.strictEqual(s.held, 110);
  assert.strictEqual(s.profit, 30);
  assert.strictEqual(s.people.A.profit, 18);
  assert.strictEqual(s.people.B.profit, 12);
  assert.strictEqual(s.people.A.inBooks + s.people.B.inBooks, 110);
  const part = summary(entries, { tipsport: 60 });
  assert.deepStrictEqual(part.missingBalances, ['tipos']);
  assert.strictEqual(part.profit, null);
  assert.strictEqual(part.people.A.profit, null);
  console.log('money tests passed');
}

(async () => {
  // Bet confirmation: the balance must fall by the stake.
  let reads = [50, 50, 40];
  assert.strictEqual(await waitForDrop(async () => reads.shift() ?? 40, 50, 10, { timeoutMs: 500, everyMs: 10 }), true);
  reads = [50, 50, 50];
  assert.strictEqual(await waitForDrop(async () => reads.shift() ?? 50, 50, 10, { timeoutMs: 100, everyMs: 10 }), false);
  assert.strictEqual(placedStatus(['confirmed', 'confirmed']), 'placed');
  assert.strictEqual(placedStatus(['confirmed', 'failed']), 'partial');
  assert.strictEqual(placedStatus(['confirmed', 'unconfirmed']), 'unconfirmed');
  assert.strictEqual(placedStatus(['failed', 'failed']), 'failed');
  console.log('placement tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
