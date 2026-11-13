// Niké and Bet365 live readers (pure parts) and pairing live events that carry no kick-off time.
const assert = require('assert');
const b365 = require('../src/providers/browser/bet365-live');
const nike = require('../src/providers/browser/nike');
const { mergeBooks } = require('../src/providers/browser/match');

// Bet365 In-Play cells, as laid out on the page (table tennis: Sieger | Satz | Satz - Gesamtzahl)
let rows = b365.parseCells(['Tschechien - Liga Pro', 'Sieger', 'Satz', 'Satz - Gesamtzahl',
  'Martin Sobisek', 'Ales Bayer', '0', '0', '0', '0', '1.90', '1.80', '1.83', '1.83', 'Ü 18.5', '1.80', 'U 18.5', '1.90',
  'Michal Koral', 'Radomir Vavrecka', '0', '0', '0', '0', // suspended: no prices
  'Radovan Polasek', 'Ondrej Paril', '0', '0', '1.66', '2.10', '1.72', '2.00'], 2);
assert.deepStrictEqual(rows.map(r => [r.home, r.away, r.odds]), [['Martin Sobisek', 'Ales Bayer', [1.9, 1.8]], ['Radovan Polasek', 'Ondrej Paril', [1.66, 2.1]]]);
// basketball: Handicap | Gesamt | Sieg -> the line-less pair is the winner
rows = b365.parseCells(['Australien - NBL', 'Handicap', 'Gesamt', 'Sieg', 'Cairns Taipans', 'Sydney Kings', '53', '65',
  '+14.5', '1.87', '-14.5', '1.91', 'Ü  187.5', '1.89', 'U  187.5', '1.89', '11.00', '1.03', '3. V', '04:26'], 2);
assert.deepStrictEqual(rows[0].odds, [11, 1.03]);
// football: 1 X 2 and the clock
rows = b365.parseCells(['Algerien - U20-Liga', '1', 'X', '2', 'ASO Chlef U20', 'USM Blida U20', '0', '0', '3.25', '1.80', '4.50', '73:54'], 3);
assert.deepStrictEqual(rows[0], { home: 'ASO Chlef U20', away: 'USM Blida U20', odds: [3.25, 1.8, 4.5], clock: '73:54' });
const now = Date.UTC(2026, 10, 13, 12, 0);
assert.strictEqual(b365.footballStart('30:00', now), now - 30 * 60e3);
assert.strictEqual(b365.footballStart('73:54', now), now - 88 * 60e3); // + half-time
assert.strictEqual(b365.footballStart(null, now), null);

// Niké push snapshot of one overview market
const starts = new Map([['1', 1000], ['3', 3000]]);
const ev = nike.parseLive({ bets: [
  { matchId: '1', state: 'Running', header: { sk: 'Zápas - Víťaz' }, participants: [{ sk: 'A Player' }, { sk: 'B Player' }],
    selections: [{ code: 49, odds: 1.5, enabled: true }, { code: 50, odds: 2.6, enabled: true }] },
  { matchId: '2', state: 'Running', header: { sk: 'Zápas - Víťaz' }, participants: [{ sk: 'C' }, { sk: 'D' }], // no start known
    selections: [{ code: 49, odds: 1.5, enabled: true }, { code: 50, odds: 2.6, enabled: true }] },
  { matchId: '3', state: 'Running', header: { sk: '2. set - Víťaz' }, participants: [{ sk: 'E' }, { sk: 'F' }], // other market
    selections: [{ code: 49, odds: 1.5, enabled: true }, { code: 50, odds: 2.6, enabled: true }] },
] }, 'tennis', '/tenis', starts);
assert.strictEqual(ev.length, 1);
assert.deepStrictEqual(ev[0].odds.map(o => [o.sel, o.price]), [['1', 1.5], ['2', 2.6]]);
assert.strictEqual(ev[0].link, 'https://www.nike.sk/live-stavky/tenis/1');
assert.strictEqual(ev[0].live, true);
// locked selections are left out; football takes the 1X2 market
const fb = nike.parseLive({ bets: [{ matchId: '1', state: 'Running', header: { sk: 'Zápas - Výsledok' }, participants: [{ sk: 'X Team' }, { sk: 'Y Team' }],
  selections: [{ code: 49, odds: 2.1, enabled: true }, { code: 88, odds: 3.2, enabled: true, locked: true }, { code: 50, odds: 3.5, enabled: true }] }] }, 'football', '/futbal', starts);
assert.deepStrictEqual(fb[0].odds.map(o => o.sel), ['1', '2']);

// pairing: a live Bet365 event without start joins the live group of the same players
const t = Date.now();
const lists = [
  [{ book: 'tipsport', sport: 'tennis', home: 'Maestrelli F.', away: 'Nagal S.', start: t - 3600e3, live: true, odds: [{ book: 'tipsport', market: 'h2h', sel: '1', price: 1.6 }] }],
  [{ book: 'bet365', sport: 'tennis', home: 'F Maestrelli', away: 'S Nagal', start: null, live: true, odds: [{ book: 'bet365', market: 'h2h', sel: '2', price: 2.2 }] },
   { book: 'bet365', sport: 'tennis', home: 'Other One', away: 'Someone Else', start: null, live: true, odds: [] }],
];
const merged = mergeBooks(lists);
assert.strictEqual(merged.length, 1);
assert.deepStrictEqual(merged[0].books.sort(), ['bet365', 'tipsport']);
assert.strictEqual(merged[0].start, t - 3600e3);
// ...but never a pre-match group
const pre = mergeBooks([[{ ...lists[0][0], live: false }], [lists[1][0]]]);
assert.strictEqual(pre.length, 0);
// Bet365 feed watch: only frames from the last 30 s count
{
  const { feedRate } = require('../src/providers/browser/bet365');
  const n0 = 1e9;
  const f = { frames: [n0 - 40000, n0 - 31000, n0 - 20000, n0 - 1000] };
  assert.strictEqual(feedRate(f, n0), 2);
  assert.strictEqual(f.frames.length, 2);
}
console.log('live book reader tests passed');

// Niké pre-match: a match that needs an accumulator (validationRules.minMultiple > 1) is left out
{
  const nk = require('../src/providers/browser/nike');
  const bet = (id, minMultiple) => ({ betId: id, sportEventId: id, header: 'Zápas', bettingState: 'RUNNING', participants: ['Šaľa', 'Nové Zámky'],
    expirationTime: '2026-11-14T13:00:00+01:00', validationRules: { minMultiple },
    selectionGrid: [[{ type: 'selection', tip: 49, odds: 4.05, enabled: true }, { type: 'selection', tip: 88, odds: 3.9, enabled: true }, { type: 'selection', tip: 50, odds: 1.63, enabled: true }]] });
  const out = nk.parse({ boxes: [], sportEvents: {}, bets: { a: bet('a', 3), b: bet('b', 0) } }, 'football');
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].link.endsWith('/b'));
  console.log('nike single-bet filter tests passed');
}
