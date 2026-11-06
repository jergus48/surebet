// Live loop: a surebet is only reported after surviving N polls in a row,
// stale legs are rejected, and over-the-cap profits are dropped.
const assert = require('assert');
const config = require('../src/config');
const providers = require('../src/providers');
const db = require('../src/db');
const notify = require('../src/notify');

// Stub I/O so the test touches neither the real DB nor Telegram.
const alerts = [], stored = [];
db.upsertSurebet = sb => { stored.push(sb.key); return true; };
db.log = () => { };
notify.send = async (_s, text) => { alerts.push(text); return true; };
config.load = () => ({ provider: 'browser', includeLive: true, betMode: 'off', liveMinProfitPct: 1, liveMaxProfitPct: 10, liveMaxAgeSec: 20, liveConfirmPolls: 2, bankrollPerBet: 100, roundStakeTo: 1, minProfitPct: 1, telegramBotToken: '', bookmakers: {} });

let feed = [];
providers.get = () => ({ fetchLive: async () => feed });
const scanner = require('../src/scanner');

const mk = (a, b, ageMs = 1000) => [{
  id: 'e1', sport: 'tennis', sportTitle: 'Tenis', league: 'L', home: 'A', away: 'B', start: Date.now() - 600000, live: true, drawPossible: false, books: ['tipsport', 'tipos'],
  odds: [
    { book: 'tipsport', market: 'h2h', point: null, sel: '1', price: a, link: 'https://x/1', updated: Date.now() - ageMs },
    { book: 'tipos', market: 'h2h', point: null, sel: '2', price: b, link: 'https://x/2', updated: Date.now() - ageMs },
  ],
}];

(async () => {
  // 1) 2.1 / 2.1 = 5% arb: first poll is only a candidate
  feed = mk(2.1, 2.1);
  await scanner.livePollOnce();
  assert.strictEqual(alerts.length, 0, 'not reported after 1 poll');
  assert.strictEqual(scanner.state.live.candidates, 1);
  assert.strictEqual(scanner.state.live.active.length, 0);
  // second poll in a row -> confirmed + alerted once, with links
  await scanner.livePollOnce();
  assert.strictEqual(alerts.length, 1, 'reported after 2 polls');
  assert.ok(alerts[0].includes('https://x/1') && alerts[0].includes('https://x/2'), 'alert carries both bookmaker links');
  assert.strictEqual(scanner.state.live.active.length, 1);
  // third poll: still active, but no second alert
  await scanner.livePollOnce();
  assert.strictEqual(alerts.length, 1, 'no repeat alert');

  // 2) vanishes for one poll -> streak resets, must confirm again
  feed = [];
  await scanner.livePollOnce();
  feed = mk(2.1, 2.1);
  await scanner.livePollOnce();
  assert.strictEqual(scanner.state.live.active.length, 0, 'streak reset after a miss');

  // 3) stale price (60 s old) is rejected outright
  feed = mk(2.1, 2.1, 60000);
  await scanner.livePollOnce();
  await scanner.livePollOnce();
  assert.strictEqual(scanner.state.live.candidates, 0, 'stale legs rejected');

  // 4) 25% live arb is above the live cap -> dropped
  feed = mk(2.6, 2.6);
  await scanner.livePollOnce();
  assert.strictEqual(scanner.state.live.candidates, 0, 'over live max profit dropped');
  console.log('live tests passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
