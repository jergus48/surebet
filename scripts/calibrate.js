#!/usr/bin/env node
// Teach the bot where a bookmaker's balance, odds, stake box and Place button are.
//   node scripts/calibrate.js tipsport              click each element when asked
//   node scripts/calibrate.js chance --from tipsport  start from another book's selectors
//   node scripts/calibrate.js tipsport --check       show what the saved selectors find now
// You log in yourself in the book's own Chrome window. The Place click is blocked,
// so calibrating never places a bet. Results go to data/sites.json.
const readline = require('readline/promises');
const config = require('../src/config');
const chrome = require('../src/bettor/chrome');
const sites = require('../src/bettor/sites');
const picker = require('../src/bettor/picker');
const { candidates } = require('../src/bettor/selectors');
const { parseMoney, parsePrice } = require('../src/bettor/parse');

const STEPS = [
  { key: 'balance', label: 'your account BALANCE (the money amount shown when you are logged in)', check: t => parseMoney(t) != null, show: t => `reads ${parseMoney(t)}` },
  { key: 'oddsButton', label: 'any ODDS button of the match (it goes onto the bet slip)', many: true, pass: true, check: t => parsePrice(t) != null },
  { key: 'stakeInput', label: 'the STAKE box on the bet slip', field: true },
  { key: 'slipOdds', label: 'the ODDS shown on the bet slip', check: t => parsePrice(t) != null, show: t => `reads ${parsePrice(t)}` },
  { key: 'placeButton', label: 'the PLACE BET button', block: true },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const args = process.argv.slice(2);
const book = args.find(a => !a.startsWith('--'));
const fromIdx = args.indexOf('--from');
const from = fromIdx > -1 ? args[fromIdx + 1] : null;
const checkOnly = args.includes('--check');

// Own tab, so a running scanner keeps the tab it reads from.
async function bookTab(port, site) {
  const browser = await chrome.connect(port);
  const page = await browser.newPage();
  await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();
  return page;
}

async function pick(page, step) {
  for (;;) {
    await page.evaluate(picker.startPick, step.label, !!step.block, !!step.field).catch(() => null);
    for (;;) {
      await sleep(400);
      const r = await page.evaluate(picker.pollPick).catch(() => null);
      if (r === false) continue;
      if (r === null) break; // page navigated: start the picker again
      return r;
    }
  }
}

async function main() {
  const s = config.load();
  const all = sites.load();
  if (!book || !s.bookmakers[book] || !all[book]) {
    console.log(`Usage: node scripts/calibrate.js <book> [--from <book>] [--check]\nBooks: ${Object.keys(s.bookmakers).join(', ')}`);
    process.exit(1);
  }
  const site = all[book];
  const port = s.bookmakers[book].port;
  await chrome.launch(port, book, site.home);
  const page = await bookTab(port, site);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (from) {
    if (!all[from]) throw new Error(`unknown book ${from}`);
    sites.save(book, { ...all[from].selectors });
    console.log(`Copied ${from}'s selectors to ${book}. Checking them on the current page:`);
  }
  if (checkOnly || from) {
    const sel = sites.load()[book].selectors;
    const r = await page.evaluate(picker.inspect, sel);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(13)} ${v.missing ? 'not set' : v.error ? 'ERROR ' + v.error : `${v.count} found ${JSON.stringify(v.sample)}`}`);
    console.log('Balance and stake box only show once logged in, and slip fields only with a selection on the slip.');
    rl.close();
    process.exit(0);
  }

  console.log(`\nCalibrating ${s.bookmakers[book].name} in its own Chrome window (port ${port}).`);
  await rl.question('1. Log in there yourself.\n2. Open any upcoming match with odds.\n3. Press Enter here. ');
  const chosen = {};
  for (const step of STEPS) {
    for (;;) {
      console.log(`\n> In the Chrome window, click ${step.label}.${step.block ? ' The click is blocked: nothing is bet.' : ''}`);
      const r = await pick(page, step);
      const found = await page.evaluate(picker.chooseSelector, candidates(r.chain, { many: !!step.many }), !!step.many);
      if (!found) {
        const a = await rl.question(`  No stable selector for that element ("${r.text}"). Try clicking it again (Enter) or skip (s)? `);
        if (a.trim().toLowerCase() === 's') break;
        continue;
      }
      if (step.check && !step.check(found.text)) {
        const a = await rl.question(`  That shows "${found.text}", which does not look right. Try again (Enter) or keep it (k)? `);
        if (a.trim().toLowerCase() !== 'k') continue;
      }
      const a = await rl.question(`  ${found.selector}  (${found.count} on page${step.show ? ', ' + step.show(found.text) : ''}). Keep (Enter), redo (r) or skip (s)? `);
      const c = a.trim().toLowerCase();
      if (c === 'r') continue;
      if (c !== 's') chosen[step.key] = found.selector;
      break;
    }
  }
  await page.evaluate(picker.stopPick).catch(() => null);
  if (chosen.balance) chosen.loggedIn = chosen.balance; // the balance only shows when logged in
  if (!Object.keys(chosen).length) { console.log('\nNothing saved.'); rl.close(); process.exit(0); }
  const saved = sites.save(book, chosen);
  console.log(`\nSaved to data/sites.json:\n${JSON.stringify(saved.selectors, null, 2)}`);
  console.log(sites.calibrated(saved) ? `${book} is calibrated. Remove the selection from the bet slip by hand.` : `${book} still needs odds, stake and Place to be calibrated.`);
  rl.close();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
