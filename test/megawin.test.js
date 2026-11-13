// Megawin (Sportinno featured feed) parser.
const assert = require('assert');
const { parse } = require('../src/providers/browser/megawin');

const sel = (name, odds, open = true) => ({ name, odds, isActive: open, status: open ? 1 : -1 });
const now = Date.parse('2026-11-10T12:00:00Z');
const feed = {
  sports: [
    {
      identifier: 'football',
      categories: [{
        name: 'Spain',
        tournaments: [{
          name: 'Copa del Rey',
          sportEvents: [
            { // full 1X2 + a half-line total + a whole line (dropped)
              name: 'Anaitasuna vs Alaves', startTime: '2026-11-10T18:00:00Z', isLive: false,
              teams: [{ name: 'Anaitasuna' }, { name: 'Alaves' }],
              marketTypes: [
                { id: 23, markets: [{ status: 1, selections: [sel('1', 27), sel('X', 16), sel('2', 1.03)] }] },
                { id: 24, markets: [
                  { status: 1, line: '4.5', selections: [sel('Над 4.5', 1.96), sel('Под 4.5', 1.81)] },
                  { status: 1, line: '4', selections: [sel('Над 4', 1.5), sel('Под 4', 2.4)] },
                ] },
              ],
            },
            { // 1X2 with a closed leg: no h2h at all
              name: 'Tavernes vs Valencia', startTime: '2026-11-10T20:00:00Z', isLive: false,
              teams: [{ name: 'Tavernes' }, { name: 'Valencia' }],
              marketTypes: [{ id: 23, markets: [{ status: 1, selections: [sel('1', 50), sel('X', 50), sel('2', 1.01, false)] }] }],
            },
            { // live: only in the live read
              name: 'A vs B', startTime: '2026-11-10T11:00:00Z', isLive: true,
              teams: [{ name: 'A' }, { name: 'B' }],
              marketTypes: [{ id: 23, markets: [{ status: 1, selections: [sel('1', 2), sel('X', 3), sel('2', 4)] }] }],
            },
          ],
        }],
      }],
    },
    {
      identifier: 'tennis',
      categories: [{
        name: 'ATP',
        tournaments: [{
          name: 'Stockholm',
          sportEvents: [{
            name: 'Holger Rune vs Zizou Bergs', startTime: '2026-11-10T17:00:00Z', isLive: false,
            teams: [{ name: 'Holger Rune' }, { name: 'Zizou Bergs' }],
            marketTypes: [
              { id: 16, markets: [{ status: 1, selections: [sel('1', 1.57), sel('2', 2.28)] }] },
              { id: 14, markets: [{ status: 1, selections: [sel('1', 1.64), sel('2', 2.12)] }] }, // set winner: ignored
            ],
          }],
        }],
      }],
    },
  ],
};

const fb = parse(feed, 'football', now);
assert.strictEqual(fb.length, 1, 'closed 1X2 leg and live match are dropped');
const a = fb[0];
assert.strictEqual(a.home, 'Anaitasuna');
assert.strictEqual(a.away, 'Alaves');
assert.strictEqual(a.start, Date.parse('2026-11-10T18:00:00Z'));
assert.strictEqual(a.league, 'Spain - Copa del Rey');
assert.deepStrictEqual(a.odds.map(o => `${o.market}:${o.point ?? ''}:${o.sel}:${o.price}`),
  ['h2h::1:27', 'h2h::X:16', 'h2h::2:1.03', 'totals:4.5:O:1.96', 'totals:4.5:U:1.81']);
assert.ok(a.odds.every(o => o.book === 'megawin' && o.link === 'https://megawin.mk/'));

const tn = parse(feed, 'tennis', now);
assert.strictEqual(tn.length, 1);
assert.deepStrictEqual(tn[0].odds.map(o => `${o.sel}:${o.price}`), ['1:1.57', '2:2.28']);

assert.deepStrictEqual(parse(feed, 'hockey', now), [], 'sport not in the feed');
// live reader: only the featured matches that are live
const lv = parse(feed, 'football', now, { liveOnly: true });
assert.deepStrictEqual(lv.map(e => [e.home, e.live, e.odds.map(o => o.price).join('/')]), [['A', true, '2/3/4']]);
console.log('megawin tests passed');
