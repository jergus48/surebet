// Bet365 collector, "open tabs" mode. Bet365 has no usable JSON API (odds come
// over its own websocket protocol), and it starts serving EMPTY pages when a
// page is reloaded over and over by automation. So this works like a person
// with a few tabs open:
//   - one tab per route (sport page), opened ONCE in your Bet365 debug Chrome
//   - Bet365 itself keeps the odds in that tab live (its websocket updates the page)
//   - every scan only re-reads what is on screen (bet365-extract.js), no navigation
//   - a tab is reloaded only if it shows nothing, at most once per reloadMinSec
//   - after repeated empty reads the book is marked blocked and skipped for a while
// Pre-match 1X2 / match-winner only. Routes (verified 2026-11): #/AS/B1/ Football,
// #/AS/B13/ Tennis. A sport page shows its featured fixtures only; add more
// routes per sport in settings.bet365Routes for more coverage.
const chrome = require('../../bettor/chrome');
const extract = require('./bet365-extract');
const db = require('../../db');

const ORIGIN = 'https://www.bet365.com/';
const MONTHS = { jan: 0, feb: 1, mar: 2, 'mär': 2, apr: 3, may: 4, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, dez: 11 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Our sport key -> bet365 routes, one open tab each. Override with settings.bet365Routes.
// Verified 2026-11 by clicking the sport page's cards: football region cards open
// "Weekend" coupons (F^2001), tennis tour cards open F^24 coupons. ~350 football
// + ~55 tennis prematch fixtures in total.
const C = (sport, g, j, f) => `#/AC/B${sport}/C1/D1002/G${g}/J${j}/Q1/F%5E${f}/`;
// Six tabs, not sixteen: each Bet365 tab holds ~350 MB and the Mac ran out of memory with 16
// (2026-11-13). Override with settings.bet365Routes.
const SPORTS = {
  football: [
    '#/AS/B1/', // featured
    C(1, 40, 99, 2001), // Top Leagues
    C(1, 40, 17, 2001), // Europe
    C(1, 40, 13, 2001), // Rest of the World
  ],
  tennis: [
    '#/AS/B13/', // featured
    C(13, 83, 12, 24), // Challenger (the most matches)
  ],
};

// route -> { page, loadedAt, emptyReads }
const tabs = new Map();
let blockedUntil = 0;

const WEEKDAYS = { so: 0, sun: 0, mo: 1, mon: 1, di: 2, tue: 2, mi: 3, wed: 3, do: 4, thu: 4, fr: 5, fri: 5, sa: 6, sat: 6 };

// "Fr" + "21:00" (coupon pages) -> next such weekday from today, local time.
function parseWeekday(day, time, now = new Date()) {
  const wd = WEEKDAYS[String(day).toLowerCase()];
  if (wd == null || !time) return null;
  const [hh, mm] = time.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  d.setDate(d.getDate() + ((wd - now.getDay() + 7) % 7));
  return d.getTime();
}

// "Fr 06 Nov" + "19:30" -> local timestamp (nearest year).
function parseStart(dateLabel, time, now = new Date()) {
  if (!dateLabel || !time) return null;
  const m = dateLabel.match(/(\d{1,2})\s+([A-Za-zÄÖÜäöü]{3})/);
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon == null) return null;
  const [hh, mm] = time.split(':').map(Number);
  let d = new Date(now.getFullYear(), mon, Number(m[1]), hh, mm);
  if (d - now < -180 * 864e5) d = new Date(now.getFullYear() + 1, mon, Number(m[1]), hh, mm);
  return d.getTime();
}

const countOdds = page => page.evaluate(() => [...document.querySelectorAll('*')]
  .filter(e => e.children.length === 0 && /^\d{1,3}\.\d{2,3}$/.test((e.textContent || '').trim())).length);

// Wait until the number of rendered odds stops growing (coupon renders in chunks).
async function waitRendered(page, waitMs) {
  const t0 = Date.now();
  let prev = -1, stable = 0;
  while (Date.now() - t0 < waitMs) {
    await sleep(1000);
    const n = await countOdds(page).catch(() => 0);
    stable = n > 0 && n === prev ? stable + 1 : 0;
    prev = n;
    if (stable >= 3) return n;
  }
  return prev;
}

async function openTab(settings, route) {
  const port = settings.bookmakers.bet365.port;
  await chrome.launch(port, 'bet365', ORIGIN);
  const browser = await chrome.connect(port);
  // Reuse a tab already on this route (e.g. after a bot restart) before opening one.
  const pages = await browser.pages();
  let page = pages.find(p => p.url().endsWith(route));
  if (!page) {
    // Space out first-time page loads so opening many tabs is not a burst.
    await sleep(2000 + Math.random() * 3000);
    page = await browser.newPage();
    await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  // A reused tab that already shows odds needs no waiting.
  if (!(await countOdds(page).catch(() => 0))) await waitRendered(page, (settings.bet365WaitSec || 20) * 1000);
  const t = { page, loadedAt: Date.now(), emptyReads: 0 };
  tabs.set(route, t);
  return t;
}

// A tab that died (Chrome restarted or closed) throws here forever with "detached Frame":
// forget it so the next read reopens the window and the tab.
async function readRoute(settings, route) {
  try {
    return await readRouteOnce(settings, route);
  } catch (e) {
    tabs.delete(route);
    throw e;
  }
}

async function readRouteOnce(settings, route) {
  let t = tabs.get(route);
  if (!t || t.page.isClosed()) t = await openTab(settings, route);
  let rows = await t.page.evaluate(`(${extract.toString()})()`);
  if (rows.length) { t.emptyReads = 0; return rows; }

  t.emptyReads++;
  const reloadMin = (settings.bet365ReloadMinSec || 600) * 1000;
  if (Date.now() - t.loadedAt >= reloadMin) {
    db.log('info', `bet365 ${route}: empty, reloading once`);
    await t.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    t.loadedAt = Date.now();
    await waitRendered(t.page, (settings.bet365WaitSec || 20) * 1000);
    rows = await t.page.evaluate(`(${extract.toString()})()`);
    if (rows.length) t.emptyReads = 0;
  }
  return rows;
}

async function collect(settings, sportKeys) {
  if (Date.now() < blockedUntil) throw new Error(`paused until ${new Date(blockedUntil).toLocaleTimeString()} (Bet365 kept serving empty pages)`);
  const routes = { ...SPORTS, ...(settings.bet365Routes || {}) };
  const events = [];
  let emptyRoutes = 0, totalRoutes = 0;
  for (const key of sportKeys) {
    for (const route of routes[key] || []) {
      totalRoutes++;
      const rows = await readRoute(settings, route);
      if (!rows.length) emptyRoutes++;
      for (const r of rows) {
        if (r.live) continue;
        const start = r.day ? parseWeekday(r.day, r.time) : parseStart(r.dateLabel, r.time);
        if (!start) continue;
        const sels = r.odds.length === 3 ? ['1', 'X', '2'] : r.odds.length === 2 ? ['1', '2'] : null;
        if (!sels) continue;
        // Bet365 has no per-match link: link to the page the match was read from.
        const pageLink = ORIGIN + route;
        events.push({
          book: 'bet365', sport: key, league: null, home: r.home, away: r.away, start, live: false, link: pageLink,
          // home/away in bet365's own spelling (German): the bettor checks its slip against these.
          odds: r.odds.map((price, i) => ({ book: 'bet365', market: 'h2h', point: null, sel: sels[i], price, link: pageLink, updated: Date.now(), home: r.home, away: r.away })),
        });
      }
    }
  }
  // Every tab empty for 3 reads in a row: back off instead of pushing.
  const stuck = [...tabs.values()].every(t => t.emptyReads >= 3);
  if (totalRoutes && emptyRoutes === totalRoutes && stuck) {
    blockedUntil = Date.now() + (settings.bet365BackoffSec || 1800) * 1000;
    db.log('warn', `bet365: all pages empty, pausing Bet365 for ${(settings.bet365BackoffSec || 1800) / 60} min`);
  }
  // Same fixture can appear on several routes; keep one.
  const seen = new Map();
  for (const e of events) seen.set(`${e.home}|${e.away}|${e.start}`, e);
  return [...seen.values()];
}

// ---- live (fast loop) ---------------------------------------------------------------
// One In-Play tab per sport, opened once and kept live by Bet365 itself (like the pre-match tabs);
// every live poll only re-reads the screen (bet365-live.js). Only the sports with the most live
// surebets get a tab, to keep this window's memory in check. In-Play rows show no kick-off time:
// football's is estimated from its clock, the others carry start null (paired by names, live only).
const live = require('./bet365-live');
const LIVE_ROUTES = { football: ['#/IP/B1', 3], tennis: ['#/IP/B13', 2], basketball: ['#/IP/B18', 2], tabletennis: ['#/IP/B92', 2] };

// Bet365 stops sending odds to an In-Play tab after a while: the socket stays open (heartbeats only)
// and the page keeps counting its clocks, but every price freezes. A live tab gets several updates
// a second, so each In-Play tab's websocket frames are counted: a tab under LIVE_MIN_FRAMES in the
// last LIVE_WINDOW_MS is stale, its prices are not used, and it is reloaded (at most every 90 s).
const LIVE_WINDOW_MS = 30000, LIVE_MIN_FRAMES = 15, LIVE_RELOAD_MS = 90000;
const feeds = new Map(); // route -> { page, frames: [ms], loadedAt }

async function watchFeed(route, page) {
  const f = feeds.get(route);
  if (f && f.page === page) return f;
  const c = await page.target().createCDPSession();
  const nf = { page, frames: [], loadedAt: Date.now(), reloadedAt: 0 };
  c.on('Network.webSocketFrameReceived', () => nf.frames.push(Date.now()));
  await c.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
  feeds.set(route, nf);
  return nf;
}

function feedRate(f, now = Date.now()) {
  while (f.frames.length && now - f.frames[0] > LIVE_WINDOW_MS) f.frames.shift();
  return f.frames.length;
}

async function collectLive(settings, sportKeys) {
  if (Date.now() < blockedUntil) throw new Error('bet365 paused (empty pages)');
  const routes = { ...LIVE_ROUTES, ...(settings.bet365LiveRoutes || {}) };
  const events = [];
  const now = Date.now();
  const stale = [];
  for (const key of sportKeys) {
    if (!routes[key]) continue;
    const [route, n] = routes[key];
    let rows;
    try {
      let t = tabs.get(route);
      if (!t || t.page.isClosed()) t = await openTab(settings, route);
      const f = await watchFeed(route, t.page);
      // Not watched long enough yet: no verdict, no prices.
      if (now - f.loadedAt < LIVE_WINDOW_MS) continue;
      if (feedRate(f, now) < LIVE_MIN_FRAMES) {
        stale.push(key);
        if (now - f.reloadedAt >= LIVE_RELOAD_MS) {
          f.reloadedAt = now;
          f.loadedAt = now;
          f.frames = [];
          t.page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => db.log('warn', `bet365 live ${key} reload: ${e.message}`));
        }
        continue;
      }
      rows = live.parseCells(await t.page.evaluate(`(${live.leafTexts.toString()})()`), n);
    } catch (e) {
      tabs.delete(route);
      feeds.delete(route);
      throw new Error(`bet365 live ${key}: ${e.message}`);
    }
    const link = ORIGIN + route;
    for (const r of rows) {
      const sels = n === 3 ? ['1', 'X', '2'] : ['1', '2'];
      events.push({
        book: 'bet365', sport: key, league: null, home: r.home, away: r.away,
        start: key === 'football' ? live.footballStart(r.clock, now) : null, live: true, link,
        odds: r.odds.map((price, i) => ({ book: 'bet365', market: 'h2h', point: null, sel: sels[i], price, link, updated: now, home: r.home, away: r.away })),
      });
    }
  }
  if (stale.length) db.log('debug', `bet365 live: odds feed stalled on ${stale.join(', ')} (prices not used, tab reloaded)`);
  return events;
}

module.exports = { SPORTS, collect, collectLive, parseStart, parseWeekday, LIVE_ROUTES, feedRate };
