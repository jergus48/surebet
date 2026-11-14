// login watch, reader watch and the "not bet automatically" alert (Telegram stubbed)
const assert = require('assert');
const notify = require('../src/notify');
const sent = [];
notify.send = async (s, text) => { sent.push(text); return true; };
const db = require('../src/db');
db.addBalance = () => { }; // never write test balances into the real database
db.log = () => { };

const tick = () => new Promise(r => setTimeout(r, 20));
const logins = require('../src/bettor/logins');
let autoResult = 'no-login', autoCalls = 0;
logins.auto = async () => { autoCalls++; return autoResult; };

(async () => {
  const balances = require('../src/bettor/balances');
  const s = { bookmakers: { tipos: { name: 'Tipos' }, stake: { name: 'Stake', dataOnly: true } } };
  const t = 1e12;
  // logged out: told at once, not again within the hour, again after it, and when logged in again
  balances.record(s, 'tipos', { error: 'logged out', loggedOut: true }, t);
  await tick();
  assert.strictEqual(sent.length, 1);
  assert.ok(/Tipos is LOGGED OUT/.test(sent[0]));
  balances.noteLogin(s, 'tipos', false, t + 10 * 60e3); // a bet stopped on it: no second message yet
  await tick();
  assert.strictEqual(sent.length, 1);
  sent.length = 0;
  balances.record(s, 'tipos', { amount: 18.25 }, t + 62 * 60e3);
  assert.ok(/Tipos: logged in again/.test(sent[0]));
  assert.deepStrictEqual(balances.loggedOut(), []);
  // a skipped read (bet running) changes nothing; data-only books are never reported
  balances.record(s, 'tipos', { skipped: true }, t + 63 * 60e3);
  balances.noteLogin(s, 'stake', false, t);
  await tick();
  assert.strictEqual(sent.length, 1);
  // with a saved login: logged back in by itself, one message, no "LOGGED OUT" alert
  sent.length = 0; autoResult = 'ok';
  balances.record(s, 'tipos', { error: 'logged out', loggedOut: true }, t + 70 * 60e3);
  await tick();
  assert.deepStrictEqual(sent.length, 1);
  assert.ok(/Tipos was logged out → ✅ logged back in automatically/.test(sent[0]), sent[0]);
  assert.deepStrictEqual(balances.loggedOut(), []);
  // a window busy with a bet: nothing said, the next check tries again
  sent.length = 0; autoResult = 'busy';
  balances.record(s, 'tipos', { error: 'logged out', loggedOut: true }, t + 80 * 60e3);
  await tick();
  assert.strictEqual(sent.length, 0);
  // money in that is no payout (a deposit) is reported; a leg's payout is not
  sent.length = 0; autoResult = 'ok';
  db.placedBets = () => [{ legs: { legs: [{ book: 'tipos', stake: 13, price: 2.47, placed: true }] } }];
  db.ledger = () => [];
  balances.record(s, 'tipos', { amount: 0.25 }, t + 90 * 60e3);
  balances.record(s, 'tipos', { amount: 32.36 }, t + 91 * 60e3); // +32.11 = 13 x 2.47
  assert.strictEqual(sent.length, 0);
  balances.record(s, 'tipos', { amount: 52.36 }, t + 92 * 60e3); // +20 deposit
  assert.ok(/Tipos: \+20\.00 € came in/.test(sent[0]), sent[0]);
  db.ledger = () => [{ book: 'tipos', type: 'deposit', amount: 20, ts: t + 92 * 60e3 }];
  balances.record(s, 'tipos', { amount: 32.36 }, t + 93 * 60e3);
  balances.record(s, 'tipos', { amount: 52.36 }, t + 94 * 60e3); // in the ledger: quiet
  assert.strictEqual(sent.length, 1);
  // low balance: quiet while a bet with a leg at that book waits for its result
  sent.length = 0;
  const sl = { ...s, lowBalanceAlert: 2 };
  db.placedBets = () => [{ legs: { start: Date.now() - 3600e3, legs: [{ book: 'tipos', stake: 13, price: 2.42, placed: true }] } }];
  balances.record(sl, 'tipos', { amount: 1.9 }, Date.now());
  assert.ok(!sent.some(m => /below 2/.test(m)), sent.join(' | '));
  // balance text -> amount
  assert.deepStrictEqual(balances.amountOf({}, '18,25 € ', 'EUR'), { amount: 18.25 });
  assert.strictEqual(balances.amountOf({}, null, 'EUR'), null);

  // reader watch: quiet for 10 min, then one alert an hour, and one when it reads again
  sent.length = 0;
  const { trackHealth } = require('../src/providers/browser');
  const r = { bookmakers: { tipos: { name: 'Tipos', port: 1 } } };
  await trackHealth(r, 'tipos', false, 'HTTP 500', t);
  await trackHealth(r, 'tipos', false, 'HTTP 500', t + 9 * 60e3);
  assert.strictEqual(sent.length, 0);
  await trackHealth(r, 'tipos', false, 'HTTP 500', t + 11 * 60e3);
  assert.ok(/Tipos: no odds read for 11 min/.test(sent[0]));
  await trackHealth(r, 'tipos', false, 'HTTP 500', t + 30 * 60e3); // not a timeout: never restarted
  assert.strictEqual(sent.length, 1);
  await trackHealth(r, 'tipos', true, null, t + 31 * 60e3);
  assert.ok(/odds are read again \(was down 31 min\)/.test(sent[1]));
  await trackHealth(r, 'tipos', true, null, t + 32 * 60e3);
  assert.strictEqual(sent.length, 2);

  console.log('watch tests passed');
})().catch(e => { console.error(e); process.exit(1); });
