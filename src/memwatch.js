// Keeps the Mac out of swap. Long-running bookmaker tabs leak (renderers grow to 2-4 GB each
// after days of fetching), so every few minutes each bookmaker Chrome is measured (macOS counts
// compressed memory too) and one that grew past its limit gets its scanning tabs reloaded,
// which frees the leaked memory. The window stays open, so the login stays, and the betting
// tab (a filled slip) is never touched; nothing is reloaded while a bet is being prepared.
//   - per window: over limitMb (bet365 has 17 tabs: bet365LimitMb)
//   - under system pressure (swap > swapMb): the biggest window over pressureMb
// One window per round. macOS only.
const { execFile } = require('child_process');
const db = require('./db');
const config = require('./config');
const chrome = require('./bettor/chrome');

const LIMIT_MB = Number(process.env.MEMWATCH_LIMIT_MB || 1500);
// Bet365 holds ~17 tabs, ~4.5 GB right after a fresh load, and serves empty pages when reloaded often.
const BET365_LIMIT_MB = Number(process.env.MEMWATCH_BET365_LIMIT_MB || 3000);
const SWAP_MB = 3000;
const PRESSURE_MB = 900;
const EVERY_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000; // a window that was just reloaded is left alone this long
const lastReload = new Map(); // profile -> ms
const FIRST_MS = 3 * 60 * 1000; // let the first scan finish before looking

const run = (cmd, args) => new Promise(res => execFile(cmd, args, { maxBuffer: 20e6, timeout: 60000 }, (e, out) => res(e ? '' : String(out))));

const UNIT = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 };

// -> { 'chrome-tipos': { mb, pids: [..] }, ... } for every bookmaker Chrome
async function measure() {
  const ps = await run('ps', ['-axo', 'pid=,command=']);
  const owner = new Map();
  for (const l of ps.split('\n')) {
    const m = /^\s*(\d+)\s.*Google Chrome.*--user-data-dir=\S*?(chrome-[a-z0-9]+)/.exec(l);
    if (m) owner.set(m[1], m[2]);
  }
  const top = await run('top', ['-l', '1', '-stats', 'pid,mem']);
  const out = {};
  for (const l of top.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])[+-]?\s*$/.exec(l);
    const prof = m && owner.get(m[1]);
    if (!prof) continue;
    const o = out[prof] || (out[prof] = { mb: 0, pids: [] });
    o.mb += parseFloat(m[2]) * UNIT[m[3]];
    o.pids.push(Number(m[1]));
  }
  for (const [pid, prof] of owner) {
    const o = out[prof] || (out[prof] = { mb: 0, pids: [] });
    if (!o.pids.includes(Number(pid))) o.pids.push(Number(pid));
  }
  return out;
}

async function swapUsedMb() {
  const m = /used = ([\d.]+)M/.exec(await run('sysctl', ['-n', 'vm.swapusage']));
  return m ? Number(m[1]) : 0;
}

// Tabs pile up (match pages, finished live matches, error pages) and each one holds memory. Every
// window keeps only: its betting tab, its reading tab (the one the scanner uses) and, for Bet365,
// one tab per pre-match route. Everything else is closed. Never while a bet is running.
async function trimTabs(s) {
  if (require('./bettor').busy()) return;
  const sites = require('./bettor/sites').load();
  const b365 = require('./providers/browser/bet365');
  const routes = new Set(Object.values({ ...b365.SPORTS, ...(s.bet365Routes || {}) }).flat());
  for (const [book, bk] of Object.entries(s.bookmakers)) {
    if (!bk.enabled || !bk.port) continue;
    try {
      const browser = await chrome.connect(bk.port);
      const pages = (await browser.pages()).filter(p => /^https?:/.test(p.url()) || /^about:blank/.test(p.url()));
      const keep = new Set(pages.filter(p => chrome.isBetPage(p)));
      if (book === 'bet365') {
        const seen = new Set();
        for (const p of pages) { const r = p.url().replace(/^https:\/\/www\.bet365\.com\//, ''); if (routes.has(r) && !seen.has(r)) { seen.add(r); keep.add(p); } }
      } else {
        const site = sites[book];
        const onSite = pages.filter(p => site && site.domain.test(p.url()) && !keep.has(p));
        const scan = onSite.find(p => !/\/Error\/|zapas|event=|live-stavky|\/live\//i.test(p.url())) || onSite.find(p => !/\/Error\//i.test(p.url())) || onSite[0];
        if (scan) keep.add(scan);
      }
      const extra = pages.filter(p => !keep.has(p));
      if (!extra.length || keep.size === 0) continue;
      for (const p of extra) await p.close().catch(() => { });
      db.log('info', `memwatch: closed ${extra.length} extra tab(s) in ${book} (kept ${keep.size})`);
    } catch (e) {
      db.log('warn', `memwatch tabs ${book}: ${e.message}`);
    }
  }
}

async function check() {
  try {
    const s = config.load();
    await trimTabs(s);
    const enabled = new Set(Object.entries(s.bookmakers).filter(([, b]) => b.enabled).map(([k]) => `chrome-${k}`));
    const wins = await measure();
    const swap = await swapUsedMb();
    let victim = null;
    const cooling = prof => Date.now() - (lastReload.get(prof) || 0) < COOLDOWN_MS;
    for (const [prof, w] of Object.entries(wins)) {
      if (!enabled.has(prof) || cooling(prof)) continue;
      const limit = prof === 'chrome-bet365' ? BET365_LIMIT_MB : LIMIT_MB;
      if (w.mb > limit && (!victim || w.mb > victim.mb)) victim = { prof, ...w, why: `over ${limit} MB` };
    }
    if (!victim && swap > SWAP_MB) {
      for (const [prof, w] of Object.entries(wins)) {
        if (enabled.has(prof) && !cooling(prof) && w.mb > PRESSURE_MB && (!victim || w.mb > victim.mb)) victim = { prof, ...w, why: `swap ${Math.round(swap)} MB` };
      }
    }
    const total = Object.values(wins).reduce((a, w) => a + w.mb, 0);
    db.log('debug', `memwatch: chrome ${Math.round(total)} MB in ${Object.keys(wins).length} windows, swap ${Math.round(swap)} MB`);
    if (!victim) return;
    if (require('./bettor').busy()) return db.log('info', `memwatch: ${victim.prof} ${Math.round(victim.mb)} MB, bet in progress: later`);
    const bk = s.bookmakers[victim.prof.replace(/^chrome-/, '')];
    const browser = await chrome.connect(bk.port);
    const pages = (await browser.pages()).filter(p => !chrome.isBetPage(p) && /^https?:/.test(p.url()));
    lastReload.set(victim.prof, Date.now());
    db.log('info', `memwatch: reloading ${pages.length} scan tab(s) of ${victim.prof} (${Math.round(victim.mb)} MB, ${victim.why})`);
    for (const p of pages) await p.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => db.log('warn', `memwatch reload: ${e.message}`));
  } catch (e) {
    db.log('warn', `memwatch: ${e.message}`);
  }
}

function start() {
  if (process.platform !== 'darwin' || process.env.MEMWATCH === '0') return;
  setTimeout(function loop() { check().finally(() => setTimeout(loop, EVERY_MS).unref()); }, FIRST_MS).unref();
}

module.exports = { start, check, measure };
