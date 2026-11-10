const assert = require('assert');
const { stableToken, stableId, candidates } = require('../src/bettor/selectors');
const { summary } = require('../src/money');
const { waitForDrop, placedStatus, stakeText, stakeMatches } = require('../src/bettor');

// Stake typing: the box's decimal style is kept, and a mangled box is caught.
assert.strictEqual(stakeText(1, '1,00'), '1');
assert.strictEqual(stakeText(7.5, '0,50'), '7,5');
assert.strictEqual(stakeText(7.5, ''), '7.5');
assert.strictEqual(stakeMatches('1', 1), true);
assert.strictEqual(stakeMatches('7,50', 7.5), true);
assert.strictEqual(stakeMatches('1,010', 1), false); // typed into the default
assert.strictEqual(stakeMatches('10,50', 1), false);
assert.strictEqual(stakeMatches('', 1), false);

// Euros only: Chance's coin mode and Niké points must not read as euro balances or stakes.
{
  const { parseEuro, placeLabelInEuro } = require('../src/bettor/parse');
  assert.strictEqual(parseEuro('10,00 €'), 10);
  assert.strictEqual(parseEuro('€0'), 0);
  assert.strictEqual(parseEuro('0,00'), 0);
  assert.strictEqual(parseEuro('1 234,50 EUR'), 1234.5);
  assert.strictEqual(parseEuro('2 000 G'), null);
  assert.strictEqual(parseEuro('0.00 NIK'), null);
  assert.strictEqual(placeLabelInEuro('Staviť 1 €'), true);
  assert.strictEqual(placeLabelInEuro('Staviť 1.00 €'), true);
  assert.strictEqual(placeLabelInEuro('PODAŤ'), true);
  assert.strictEqual(placeLabelInEuro('STAVIŤ TIKET'), true);
  assert.strictEqual(placeLabelInEuro('Staviť 1 G'), false);
}

// Megawin is in denars: balances and Place labels in МКД, € stakes converted to whole denars.
{
  const { parseAmount, placeLabelIn, placeLabelInEuro, localStake } = require('../src/bettor/parse');
  assert.strictEqual(parseAmount('0,00 МКД', 'MKD'), 0);
  assert.strictEqual(parseAmount('1.234,50 МКД', 'MKD'), 1234.5);
  assert.strictEqual(parseAmount('5 €', 'MKD'), null);
  assert.strictEqual(parseAmount('500 МКД', 'EUR'), null);
  assert.strictEqual(placeLabelIn('УПЛАТИ 50.00 МКД', 'MKD'), true);
  assert.strictEqual(placeLabelIn('УПЛАТИ', 'MKD'), true);
  assert.strictEqual(placeLabelInEuro('УПЛАТИ 50.00 МКД'), false);
  assert.strictEqual(placeLabelIn('Staviť 1 €', 'MKD'), false);
  assert.strictEqual(localStake(10, 'MKD', { MKD: 61.5 }), 615);
  assert.strictEqual(localStake(10, 'EUR', {}), 10);
  assert.throws(() => localStake(10, 'MKD', {}), /exchange rate/);
}

// The slip must name the intended match (league pages repeat prices across matches).
{
  const { sameMatch } = require('../src/bettor');
  assert.strictEqual(sameMatch('Taliansko vs. Francúzsko Zápas - Výsledok Taliansko 4.30', 'Taliansko', 'Francúzsko'), true);
  assert.strictEqual(sameMatch('Andorra vs. Gibraltár Zápas - Výsledok Gibraltár 4.30', 'Taliansko', 'Francúzsko'), false);
  assert.strictEqual(sameMatch('Arménsko - Cyprus Výsledok zápasu: Arménsko 2.32', 'Armensko', 'Cyprus'), true); // accents differ
  assert.strictEqual(sameMatch('Paris St.G. ž. vs Bayern München ž. 1.86', 'Paris St.G. ž.', 'Bayern München ž.'), true);
}

// Slip check: exactly one selection near the scanned price.
const { checkSlip } = require('../src/bettor');
assert.strictEqual(checkSlip([1.85], 1.85), null);
assert.strictEqual(checkSlip([1.9], 1.85), null); // small rise is fine
assert.ok(/different selection/.test(checkSlip([2.32], 1.85))); // the leftover Arménsko selection
assert.ok(/2 selections/.test(checkSlip([1.85, 2.32], 1.85)));
assert.ok(/below/.test(checkSlip([1.8], 1.85)));
assert.strictEqual(checkSlip([1.8], 1.85, 5), null);
assert.ok(/no selection/.test(checkSlip([], 1.85)));

// Hashed CSS-in-JS classes are never used, readable ones are.
for (const t of ['OpportunityButton-styled__Odd-sc-b8dd6735-3', 'iZFHKG', 'css-1x2y3z', 'sc-abc123', 'active', 'x7k2p9']) assert.strictEqual(stableToken(t), false, t);
for (const t of ['odd-button', 'betslip__stake', 'balance', 'btn-primary', 'header-balance']) assert.strictEqual(stableToken(t), true, t);
assert.strictEqual(stableToken('t-doubleBlink-exited-active'), false);
assert.strictEqual(stableToken('fade-enter-done'), false);
assert.strictEqual(stableId('user-balance'), true);
// styled-components: keep the component name, drop the hash
{
  const bal = [{ tag: 'span', id: '', classes: ['ClientMenu-styled__AccountState-sc-25b23cbb-4', 'gfOJTl'], attrs: {} },
    { tag: 'div', id: '', classes: ['t-doubleBlink-exited-active'], attrs: {} },
    { tag: 'header', id: '', classes: ['HeaderGlobal-styled__Header-sc-623ac7c4-1', 'klUrrc'], attrs: {} }];
  const c = candidates(bal);
  assert.ok(c.includes('span[class*="ClientMenu-styled__AccountState-sc-"]'), c.join('\n'));
  assert.ok(c.includes('header span[class*="ClientMenu-styled__AccountState-sc-"]'));
  assert.ok(!c.some(x => /doubleBlink|25b23cbb|gfOJTl/.test(x)), c.join('\n'));
}
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
// Click on the price text inside a Tipsport match-page button: the button itself is found.
{
  const chain = [
    { tag: 'span', id: '', classes: [], attrs: {} },
    { tag: 'div', id: '', classes: ['BasicComponents-styled__GridLayout-sc-7f2eb570-0', 'bPjJEz'], attrs: {} },
    { tag: 'div', id: '', classes: ['px-4'], attrs: {} },
    { tag: 'div', id: '', classes: ['BetButton-styled__BetButton-sc-6e89a8b6-12', 'kemXPj'], attrs: { 'data-atid': 'oddButton-2737395469' } },
  ];
  const c = candidates(chain, { many: true });
  assert.ok(c.indexOf('div[data-atid^="oddButton-"]') > -1 && c.indexOf('div[data-atid^="oddButton-"]') < c.indexOf('.px-4 span'), c.join('\n'));
  assert.ok(c.includes('div[class*="BetButton-styled__BetButton-sc-"]'));
}
// Space-separated data values (Synottip/Tipos): one word of the list, most specific first.
{
  const c = candidates([{ tag: 'span', id: '', classes: ['value'], attrs: { 'data-test-role': 'player-account__balance player-account__balance--money' } }]);
  assert.ok(c.indexOf('span[data-test-role~="player-account__balance--money"]') > -1, c.join('\n'));
  assert.ok(c.indexOf('span[data-test-role~="player-account__balance--money"]') < c.indexOf('span[data-test-role]'));
}
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
