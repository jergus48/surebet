// "browser" provider (hybrid). Each enabled bookmaker has a source:
//   source: 'browser' -> read from its own logged-in debug Chrome (src/providers/browser/<key>.js)
//   source: 'api'     -> Odds-API.io (bookmakers[key].apiName = Odds-API.io bookmaker name)
// Every book is read in parallel, then fixtures are grouped across books.
const fs = require('fs');
const path = require('path');
const { mergeBooks, swapSides } = require('./match');
const SPORTS = require('./sports');
const oddsapiio = require('../oddsapiio');
const db = require('../../db');
const chrome = require('../../bettor/chrome');
const sites = require('../../bettor/sites');

function collectorFor(key) {
  const f = path.join(__dirname, `${key}.js`);
  if (!fs.existsSync(f)) return null;
  const mod = require(f);
  return typeof mod.collect === 'function' ? mod : null;
}

let stats = {};

// Only compare like with like:
//  - draw sports (football, hockey, handball): 3-way regulation-time 1X2 / double
//    chance; a book's 2-way winner (incl. overtime) is dropped.
//  - non-draw sports (tennis, basketball...): 2-way winner; a book's 3-way
//    regulation market (e.g. Niké/Doxxbet basketball 1X2) is dropped.
function cleanForSport(events) {
  return events.map(e => {
    const hasX = e.odds.some(o => o.market === 'h2h' && o.sel === 'X');
    if (SPORTS[e.sport]?.draw) return hasX ? e : { ...e, odds: e.odds.filter(o => o.market !== 'h2h' || /X|12/.test(o.sel)) };
    return hasX ? { ...e, odds: e.odds.filter(o => o.market !== 'h2h') } : e;
  }).filter(e => e.odds.length);
}

// Per-book pacing: heavy or touchy sites are re-read at most every everySec;
// in between their last result is reused (odds keep their read timestamp).
const cache = {};
async function paced(k, s, fn) {
  const every = (s.bookmakers[k].everySec || 0) * 1000;
  const c = cache[k];
  if (c && every && Date.now() - c.at < every) return { ...c.res, cached: true };
  const res = await fn();
  if (res.ok) cache[k] = { at: Date.now(), res };
  return res;
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ok: true, ms: Date.now() - t0, r };
  } catch (e) {
    db.log('warn', `${label}: ${e.message}`);
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

// A CDP call timed out: the book's scan tab is most likely frozen. Swap it for a fresh tab
// (bet365 has many tabs and its own per-tab recovery). Returns true when a tab was replaced.
async function recoverFrozen(k, s, e) {
  if (k === 'bet365' || !chrome.isTimeout(e)) return false;
  try {
    const site = sites.load()[k];
    const url = site && await chrome.replaceFrozenTab(s.bookmakers[k].port, site.domain);
    if (url) db.log('warn', `${k}: scan tab froze (CDP timeout), opened a fresh tab on ${url}`);
    return !!url;
  } catch (err) {
    db.log('warn', `${k}: could not replace frozen tab: ${err.message}`);
    return false;
  }
}

// Reader watch: a book that reads nothing is reported on Telegram after DOWN_ALERT_MS (again every
// hour, and when it reads again). Tipos read nothing for 9 hours on 2026-11-14 with only a log line.
// A window that keeps timing out (frozen) past DOWN_RESTART_MS is restarted, once per outage.
const down = {}; // book -> { since, error, alertedAt, restarted }
const DOWN_ALERT_MS = 10 * 60e3, DOWN_RESTART_MS = 20 * 60e3, DOWN_REPEAT_MS = 3600e3;
async function trackHealth(s, k, ok, error, now = Date.now()) {
  const notify = require('../../notify');
  const name = (s.bookmakers[k] && s.bookmakers[k].name) || k;
  const d = down[k];
  if (ok) {
    if (d && d.alertedAt) notify.send(s, `✅ ${name}: odds are read again (was down ${Math.round((now - d.since) / 60000)} min).`).catch(() => { });
    delete down[k];
    return;
  }
  if (!d) { down[k] = { since: now, error, alertedAt: 0, restarted: false }; return; }
  d.error = error;
  if (now - d.since >= DOWN_RESTART_MS && !d.restarted && chrome.isTimeout({ message: error }) && !require('../../bettor').busy()) {
    d.restarted = true;
    const site = sites.load()[k];
    db.log('warn', `${k}: window frozen for ${Math.round((now - d.since) / 60000)} min, restarting it`);
    try {
      await chrome.restart(s.bookmakers[k].port, k, site && site.home);
      notify.send(s, `🔄 ${name}: its Chrome window was frozen, the bot restarted it. If it asks you to log in, log in there.`).catch(() => { });
    } catch (e) { db.log('warn', `${k}: restart failed: ${e.message}`); }
  }
  if (now - d.since >= DOWN_ALERT_MS && now - d.alertedAt >= DOWN_REPEAT_MS) {
    d.alertedAt = now;
    notify.send(s, `⚠️ ${name}: no odds read for ${Math.round((now - d.since) / 60000)} min, so no surebets with ${name} are found or bet. Last error: ${String(error || '').slice(0, 200)}`).catch(() => { });
  }
}

// Returns { [bookKey]: events[] } for every enabled book, plus per-book stats.
async function collectAll(s, sportKeys) {
  const enabled = Object.entries(s.bookmakers).filter(([, b]) => b.enabled);
  const browserBooks = enabled.filter(([, b]) => (b.source || 'browser') === 'browser').map(([k]) => k);
  const apiBooks = enabled.filter(([, b]) => b.source === 'api').map(([k]) => k);
  const jobs = browserBooks.map(k => {
    const mod = collectorFor(k);
    if (!mod) return Promise.resolve([k, { ok: false, ms: 0, error: 'no browser collector for this book' }]);
    // One sport at a time, so a failed request only loses that sport.
    return paced(k, s, () => timed(k, async () => {
      const all = [], errs = [];
      for (const sk of sportKeys) {
        try { all.push(...await mod.collect(s, [sk])); } catch (e) {
          errs.push(`${sk}: ${e.message}`);
          // frozen tab: replace it and skip this book's remaining sports (each would wait 60 s)
          if (chrome.isTimeout(e)) { await recoverFrozen(k, s, e); break; }
        }
      }
      if (errs.length) db.log('warn', `${k}: ${errs.join(' | ')}`);
      if (!all.length && errs.length) throw new Error(errs.join(' | '));
      return all;
    })).then(x => [k, x]);
  });
  if (apiBooks.length) jobs.push(timed('odds-api.io', () => oddsapiio.collect(s, sportKeys, apiBooks)).then(x => ['__api', x]));
  const res = await Promise.all(jobs);
  const perBook = {};
  stats = {};
  for (const [k, x] of res) {
    if (k === '__api') {
      for (const b of apiBooks) {
        perBook[b] = x.ok ? cleanForSport(x.r[b] || []) : [];
        stats[b] = { source: 'api', ok: x.ok, ms: x.ms, events: perBook[b].length, error: x.error };
      }
    } else {
      perBook[k] = x.ok ? cleanForSport(x.r) : [];
      stats[k] = { source: 'browser', ok: x.ok, ms: x.ms, events: perBook[k].length, error: x.error, cached: !!x.cached };
      await trackHealth(s, k, x.ok && perBook[k].length > 0, x.error || 'no matches read').catch(e => db.log('warn', `health ${k}: ${e.message}`));
    }
  }
  return perBook;
}

// Extra markets from books that only give them per match (detail requests): fetched only for
// matches another enabled book quotes on those markets too (else no surebet is possible), soonest
// kick-off first, within a time budget. A failed detail read never breaks the scan.
// Chance last: it reuses Tipsport's details (same match ids and prices) instead of asking Chance (HTTP 429).
const DETAIL_BOOKS = ['doxxbet', 'nike', 'tipsport', 'chance'];
async function addDetails(s, merged) {
  const now = Date.now();
  for (const book of DETAIL_BOOKS) {
    if (!(s.bookmakers[book] && s.bookmakers[book].enabled)) continue;
    const mod = collectorFor(book);
    if (!mod || typeof mod.details !== 'function') continue;
    const want = merged
      .filter(e => !e.live && e.start > now && (book === 'doxxbet' || book === 'nike' ? true : e.sport === 'football') && e.odds.some(o => o.book === book) && e.odds.some(o => o.book !== book && o.market !== 'h2h'))
      .sort((a, b) => a.start - b.start);
    const linkOf = e => (e.odds.find(o => o.book === book && o.link) || {}).link;
    const links = [...new Set(want.map(linkOf).filter(Boolean))];
    if (!links.length) continue;
    try {
      const t0 = Date.now();
      const starts = new Map(want.map(e => [linkOf(e), e.start]));
      const got = await mod.details(s, links, starts); // fresh cached details; a background queue fetches the rest
      let n = 0;
      for (const e of want) {
        const extra = got.get(linkOf(e));
        if (!extra || !extra.length) continue;
        // This book lists the match the other way round (its 1X2 was turned in mergeBooks): its extra
        // markets must be turned the same way, or a "surebet" puts one team on both legs.
        const swapped = e.odds.some(o => o.book === book && o.swapped);
        e.odds.push(...(swapped ? swapSides({ odds: extra }).odds : extra));
        n++;
      }
      db.log('debug', `${book} details: ${n}/${links.length} matches, ${Date.now() - t0} ms`);
    } catch (e) {
      db.log('warn', `${book} details: ${e.message}`);
    }
  }
}

function scanSports(s) {
  return (s.scanSports || ['football', 'tennis']).filter(k => SPORTS[k]);
}

async function fetchEvents(s) {
  const sportKeys = scanSports(s);
  if (!sportKeys.length) throw new Error('No sports selected (Nastavenia)');
  const perBook = await collectAll(s, sportKeys);
  // Tipsport first: its names become the group's display names.
  const order = Object.keys(perBook).sort((a, b) => (a === 'tipsport' ? -1 : b === 'tipsport' ? 1 : 0));
  const merged = mergeBooks(order.map(k => perBook[k]), m => db.log('debug', `${Object.entries(stats).map(([k, v]) => `${k} ${v.events}${v.ok ? '' : ' ERR'} ${v.ms}ms`).join(', ')} | ${m}`));
  await addDetails(s, merged);
  return merged.map(e => ({ ...e, sportTitle: SPORTS[e.sport].name, drawPossible: SPORTS[e.sport].draw }));
}

// Fast live read: only books whose collector has collectLive (prices straight
// from the site's API in ~1 s). All books are read at the same moment, so
// every leg of a live surebet comes from the same poll.
let liveStats = {};
async function fetchLive(s) {
  const sportKeys = scanSports(s);
  const books = Object.entries(s.bookmakers)
    .filter(([k, b]) => b.enabled && (b.source || 'browser') === 'browser' && b.live !== false)
    .map(([k]) => [k, collectorFor(k)])
    .filter(([, m]) => m && typeof m.collectLive === 'function');
  const res = await Promise.all(books.map(([k, m]) => timed(`${k} live`, () => m.collectLive(s, sportKeys).catch(async e => { await recoverFrozen(k, s, e); throw e; })).then(x => [k, x])));
  liveStats = {};
  const lists = [];
  for (const [k, x] of res) {
    const ev = x.ok ? cleanForSport(x.r.filter(e => e.live)) : [];
    liveStats[k] = { ok: x.ok, ms: x.ms, events: ev.length, error: x.error };
    lists.push(ev);
  }
  // Tipsport first for display names.
  lists.sort((a, b) => (a[0]?.book === 'tipsport' ? -1 : b[0]?.book === 'tipsport' ? 1 : 0));
  const merged = mergeBooks(lists);
  return merged.map(e => ({ ...e, live: true, sportTitle: SPORTS[e.sport].name, drawPossible: SPORTS[e.sport].draw }));
}

module.exports = {
  name: 'browser',
  fetchEvents,
  fetchLive,
  getLiveStats: () => liveStats,
  collectAll,
  trackHealth,
  scanSports,
  listSports: async () => Object.entries(SPORTS).map(([key, v]) => ({ key, group: v.name, title: v.name, active: true })),
  estimateCreditsPerHour: () => 0,
  getCredits: () => ({ remaining: oddsapiio.getRate().remaining, used: oddsapiio.getRate().requests, last: null, books: stats }),
};
