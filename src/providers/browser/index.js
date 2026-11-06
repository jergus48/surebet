// "browser" provider (hybrid). Each enabled bookmaker has a source:
//   source: 'browser' -> read from its own logged-in debug Chrome (src/providers/browser/<key>.js)
//   source: 'api'     -> Odds-API.io (bookmakers[key].apiName = Odds-API.io bookmaker name)
// Every book is read in parallel, then fixtures are grouped across books.
const fs = require('fs');
const path = require('path');
const { mergeBooks } = require('./match');
const SPORTS = require('./sports');
const oddsapiio = require('../oddsapiio');
const db = require('../../db');

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
        try { all.push(...await mod.collect(s, [sk])); } catch (e) { errs.push(`${sk}: ${e.message}`); }
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
    }
  }
  return perBook;
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
  const res = await Promise.all(books.map(([k, m]) => timed(`${k} live`, () => m.collectLive(s, sportKeys)).then(x => [k, x])));
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
  scanSports,
  listSports: async () => Object.entries(SPORTS).map(([key, v]) => ({ key, group: v.name, title: v.name, active: true })),
  estimateCreditsPerHour: () => 0,
  getCredits: () => ({ remaining: oddsapiio.getRate().remaining, used: oddsapiio.getRate().requests, last: null, books: stats }),
};
