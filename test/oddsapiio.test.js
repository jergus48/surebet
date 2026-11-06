const assert = require('assert');
const { parseEvent } = require('../src/providers/oddsapiio');

// Shape from docs.odds-api.io (/v3/odds example).
const ev = {
  id: 123456, home: 'Manchester United', away: 'Liverpool', date: '2026-11-15T15:00:00Z', status: 'pending',
  sport: { name: 'Football', slug: 'football' }, league: { name: 'England - Premier League', slug: 'england-premier-league' },
  urls: { Bet365: 'https://bet365.com/x', 'Tipsport.cz': 'N/A' },
  bookmakers: {
    Bet365: [
      { name: 'ML', updatedAt: '2026-11-06T10:00:00Z', odds: [{ home: '2.10', draw: '3.40', away: '3.20' }] },
      { name: 'Spread', odds: [{ hdp: -0.5, home: '1.95', away: '1.85' }] },
      { name: 'Totals', odds: [{ hdp: 2.5, over: '1.90', under: '1.90' }] },
    ],
    'Tipsport.cz': [{ name: 'ML', odds: [{ home: '2.2', draw: '3.3', away: '3.1' }] }],
    Unibet: [{ name: 'ML', odds: [{ home: '2.0', draw: '3.5', away: '3.3' }] }],
  },
};
const r = parseEvent(ev, 'football', { Bet365: 'bet365', 'Tipsport.cz': 'tipsport' });
assert.deepStrictEqual(Object.keys(r).sort(), ['bet365', 'tipsport']); // Unibet not ours
assert.deepStrictEqual(r.bet365.odds.filter(o => o.market === 'h2h').map(o => `${o.sel}@${o.price}`), ['1@2.1', 'X@3.4', '2@3.2']);
assert.deepStrictEqual(r.bet365.odds.filter(o => o.market === 'totals').map(o => `${o.sel}${o.point}@${o.price}`), ['O2.5@1.9', 'U2.5@1.9']);
assert.strictEqual(r.bet365.link, 'https://bet365.com/x');
assert.strictEqual(r.tipsport.link, null);
assert.strictEqual(r.bet365.start, Date.parse('2026-11-15T15:00:00Z'));
// Tennis: no totals, 2-way ML
const t = parseEvent({ ...ev, bookmakers: { Bet365: [{ name: 'ML', odds: [{ home: '1.5', away: '2.6' }] }, { name: 'Totals', odds: [{ hdp: 22.5, over: '1.9', under: '1.9' }] }] } }, 'tennis', { Bet365: 'bet365' });
assert.deepStrictEqual(t.bet365.odds.map(o => o.sel), ['1', '2']);
console.log('oddsapiio tests passed');
