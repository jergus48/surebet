#!/usr/bin/env node
// Teach the bot where a bookmaker's balance, odds, stake box and Place button are.
// Same flow as the dashboard's Calibrate button, in the terminal:
//   node scripts/calibrate.js tipsport              click each element when asked
//   node scripts/calibrate.js chance --from tipsport  start from another book's selectors
//   node scripts/calibrate.js tipsport --check       show what the saved selectors find now
// You log in yourself in the book's own Chrome window. The Place click is blocked,
// so calibrating never places a bet. Results go to data/sites.json.
const readline = require('readline/promises');
const config = require('../src/config');
const sites = require('../src/bettor/sites');
const picker = require('../src/bettor/picker');
const cal = require('../src/bettor/calibration');

const args = process.argv.slice(2);
const book = args.find(a => !a.startsWith('--'));
const fromIdx = args.indexOf('--from');
const from = fromIdx > -1 ? args[fromIdx + 1] : null;
const checkOnly = args.includes('--check');

async function main() {
  const s = config.load();
  const all = sites.load();
  if (!book || !s.bookmakers[book] || !all[book]) {
    console.log(`Usage: node scripts/calibrate.js <book> [--from <book>] [--check]\nBooks: ${Object.keys(s.bookmakers).join(', ')}`);
    process.exit(1);
  }
  const port = s.bookmakers[book].port;
  const page = await cal.openTab(port, book);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const done = code => { rl.close(); process.exit(code); };

  if (from) {
    if (!all[from]) throw new Error(`unknown book ${from}`);
    sites.save(book, { ...all[from].selectors });
    console.log(`Copied ${from}'s selectors to ${book}.`);
  }
  if (checkOnly || from) {
    await rl.question('Log in in the window and open a match (put a selection on the slip to check slip fields), then press Enter. ');
    const r = await cal.inspect(page, book);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(13)} ${v.missing ? 'not set' : v.error ? 'ERROR ' + v.error : `${v.count} found ${JSON.stringify(v.sample)}`}`);
    return done(0);
  }

  console.log(`\nCalibrating ${s.bookmakers[book].name} in its own Chrome window (port ${port}).`);
  await rl.question('1. Log in there yourself.\n2. Open any upcoming match with odds.\n3. Press Enter here. ');
  const chosen = {};
  for (const step of cal.STEPS) {
    for (;;) {
      console.log(`\n> In the Chrome window, click ${step.label}.${step.block ? ' The click is blocked: nothing is bet.' : ''}`);
      const found = await cal.pickOnce(page, step);
      if (!found.selector) {
        const a = await rl.question(`  No stable selector for that element ("${found.text}"). Try clicking it again (Enter) or skip (s)? `);
        if (a.trim().toLowerCase() === 's') break;
        continue;
      }
      if (!found.ok) {
        const a = await rl.question(`  That shows "${found.text}", which does not look right. Try again (Enter) or keep it (k)? `);
        if (a.trim().toLowerCase() !== 'k') continue;
      }
      const a = await rl.question(`  ${found.selector}  (${found.count} on page${found.show ? ', ' + found.show : ''}). Keep (Enter), redo (r) or skip (s)? `);
      const c = a.trim().toLowerCase();
      if (c === 'r') continue;
      if (c !== 's') chosen[step.key] = found.selector;
      break;
    }
  }
  await page.evaluate(picker.stopPick).catch(() => null);
  const saved = cal.finish(book, chosen);
  if (!saved) { console.log('\nNothing saved.'); return done(0); }
  console.log(`\nSaved to data/sites.json:\n${JSON.stringify(saved.selectors, null, 2)}`);
  console.log(sites.calibrated(saved) ? `${book} is calibrated. Remove the selection from the bet slip by hand.` : `${book} still needs odds, stake and Place to be calibrated.`);
  return done(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
