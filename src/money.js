// Profit from what is actually in the accounts: (balances now + withdrawn) - deposited.
// Each person owns a share of the pot in proportion to what they deposited.
// Money staked on unsettled bets is not in any balance, so profit dips until those settle.

// entries: [{ person, book, type: 'deposit'|'withdrawal', amount }]
// balances: { book: amount } (latest read per book)
function summary(entries, balances) {
  const books = [...new Set(entries.map(e => e.book))];
  const missing = books.filter(b => balances[b] == null);
  const held = books.reduce((s, b) => s + (balances[b] || 0), 0);
  const people = {};
  for (const e of entries) {
    const p = people[e.person] || (people[e.person] = { deposited: 0, withdrawn: 0 });
    if (e.type === 'deposit') p.deposited += e.amount; else p.withdrawn += e.amount;
  }
  const deposited = Object.values(people).reduce((s, p) => s + p.deposited, 0);
  const withdrawn = Object.values(people).reduce((s, p) => s + p.withdrawn, 0);
  const pot = held + withdrawn; // everything the pot produced, inside and outside the books
  const r2 = n => Math.round(n * 100) / 100;
  // A book without a balance read would look like money lost: report profit as unknown instead.
  const known = !missing.length;
  const out = {};
  for (const [name, p] of Object.entries(people)) {
    const share = deposited > 0 ? p.deposited / deposited : 0;
    const stake = pot * share; // this person's part of everything, incl. what they already took out
    out[name] = { deposited: r2(p.deposited), withdrawn: r2(p.withdrawn), sharePct: r2(share * 100), inBooks: known ? r2(stake - p.withdrawn) : null, profit: known ? r2(stake - p.deposited) : null };
  }
  return { deposited: r2(deposited), withdrawn: r2(withdrawn), held: known ? r2(held) : null, profit: known ? r2(pot - deposited) : null, people: out, missingBalances: missing };
}

module.exports = { summary };
