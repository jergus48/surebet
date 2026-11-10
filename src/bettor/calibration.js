// Calibration flow shared by scripts/calibrate.js (terminal) and the dashboard's
// Calibrate button. One session at a time: it opens its own tab in the book's window,
// waits for you to log in, then records one element per step. The Place click is
// blocked, so calibrating never bets.
const chrome = require('./chrome');
const sites = require('./sites');
const picker = require('./picker');
const { candidates } = require('./selectors');
const { parseMoney, parsePrice } = require('./parse');

const STEPS = [
  { key: 'balance', label: 'your account BALANCE (the money amount shown when you are logged in)', check: t => parseMoney(t) != null, show: t => `reads ${parseMoney(t)}` },
  { key: 'oddsButton', label: 'any ODDS button of the match (it goes onto the bet slip)', many: true, pass: true, check: t => parsePrice(t) != null },
  { key: 'stakeInput', label: 'the STAKE box on the bet slip', field: true },
  { key: 'slipOdds', label: 'the ODDS shown on the bet slip', check: t => parsePrice(t) != null, show: t => `reads ${parsePrice(t)}` },
  { key: 'placeButton', label: 'the PLACE BET button', block: true },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// New tab, so a running scanner keeps the tab it reads from.
async function openTab(port, book) {
  const site = sites.load()[book];
  await chrome.launch(port, book, site.home);
  const browser = await chrome.connect(port);
  const page = await browser.newPage();
  await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();
  return page;
}

// Waits for one click and turns it into a stable selector.
// -> { selector, count, text, ok, show } or { selector: null, text } when nothing stable matched.
async function pickOnce(page, step, cancelled = () => false) {
  for (;;) {
    if (cancelled()) return null;
    await page.evaluate(picker.startPick, step.label, !!step.block, !!step.field).catch(() => null);
    for (;;) {
      if (cancelled()) { await page.evaluate(picker.stopPick).catch(() => null); return null; }
      await sleep(400);
      const r = await page.evaluate(picker.pollPick).catch(() => null);
      if (r === false) continue;
      if (r === null) break; // page navigated: start the picker again
      const found = await page.evaluate(picker.chooseSelector, candidates(r.chain, { many: !!step.many }), !!step.many);
      if (!found) return { selector: null, text: r.text };
      const ok = !step.check || step.check(found.text);
      return { ...found, ok, show: step.show && ok ? step.show(found.text) : null };
    }
  }
}

// Save what was picked; the balance doubles as the "logged in" marker.
function finish(book, chosen) {
  if (chosen.balance) chosen.loggedIn = chosen.balance;
  return Object.keys(chosen).length ? sites.save(book, chosen) : null;
}

async function inspect(page, book) {
  return page.evaluate(picker.inspect, sites.load()[book].selectors);
}

// ---- dashboard session ----
let session = null;

function view() {
  if (!session) return { active: false };
  const { book, phase, step, pending, chosen, message, check } = session;
  const st = STEPS[step];
  return {
    active: true, book, phase, message, check: check || null,
    step: step + 1, steps: STEPS.length, stepKey: st ? st.key : null,
    instruction: st ? `Click ${st.label}.${st.block ? ' This click is blocked: nothing is bet.' : ''}` : null,
    pending: pending || null, chosen: { ...chosen },
  };
}

async function start(settings, book) {
  if (session && session.phase !== 'done') await cancel();
  const bk = settings.bookmakers[book];
  if (!bk || !sites.load()[book]) throw new Error('unknown bookmaker');
  session = { book, port: bk.port, phase: 'opening', step: 0, chosen: {}, pending: null, message: 'Opening the window…', cancelled: false };
  const s = session;
  try {
    s.page = await openTab(bk.port, book);
    if (s.cancelled) return view();
    s.phase = 'login';
    s.message = `Log in to ${bk.name} in its window, open any upcoming match with odds, then press "I'm logged in".`;
  } catch (e) {
    s.phase = 'error'; s.message = e.message;
  }
  return view();
}

function runStep() {
  const s = session;
  if (!s || s.step >= STEPS.length) return;
  s.phase = 'picking'; s.pending = null; s.message = null;
  const token = s.token = (s.token || 0) + 1;
  const stale = () => s.cancelled || session !== s || s.token !== token;
  pickOnce(s.page, STEPS[s.step], stale)
    .then(r => {
      if (!r || stale()) return;
      s.pending = r;
      s.phase = 'review';
    })
    .catch(e => { if (session === s) { s.phase = 'error'; s.message = e.message; } });
}

function next() {
  const s = session;
  s.step += 1;
  if (s.step < STEPS.length) return runStep();
  const saved = finish(s.book, s.chosen);
  s.phase = 'done';
  s.message = !saved ? 'Nothing saved.'
    : sites.calibrated(saved) ? 'Saved. This bookmaker is calibrated. Clear the bet slip in its window by hand.'
      : 'Saved, but odds, stake and Place are all needed before the bot can bet here.';
  s.page.evaluate(picker.stopPick).catch(() => null);
}

// action: 'ready' | 'keep' | 'redo' | 'skip'
async function act(action) {
  const s = session;
  if (!s) throw new Error('no calibration running');
  if (action === 'ready' && s.phase === 'login') runStep();
  else if (s.phase === 'picking' && action === 'skip') {
    s.token += 1; // the waiting pick is dropped
    await s.page.evaluate(picker.stopPick).catch(() => null);
    next();
  } else if (s.phase === 'review') {
    if (action === 'keep' && s.pending.selector) { s.chosen[STEPS[s.step].key] = s.pending.selector; next(); }
    else if (action === 'skip') next();
    else runStep();
  }
  return view();
}

// Start from another book's selectors (same platform) and show what they find here.
async function copyFrom(fromBook) {
  const s = session;
  if (!s || !s.page) throw new Error('no calibration running');
  const from = sites.load()[fromBook];
  if (!from || !from.selectors || !from.selectors.oddsButton) throw new Error(`${fromBook} is not calibrated`);
  sites.save(s.book, { ...from.selectors });
  s.check = await inspect(s.page, s.book);
  s.message = `Copied ${fromBook}'s setup. Counts below are on the page open now: balance needs you logged in, slip fields need a selection on the slip. Calibrate again for any step showing 0.`;
  return view();
}

async function cancel() {
  const s = session;
  session = null;
  if (!s) return { active: false };
  s.cancelled = true;
  if (s.page) await s.page.evaluate(picker.stopPick).catch(() => null);
  return { active: false };
}

module.exports = { STEPS, openTab, pickOnce, finish, inspect, start, act, copyFrom, cancel, view };
