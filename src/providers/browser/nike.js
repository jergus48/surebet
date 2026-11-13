// Niké collector. Calls Niké's own offer API from INSIDE the nike.sk tab (same
// origin, site cookies), the same request the sport page makes (and its
// infinite-scroll "load more"):
//   GET /api-gw/nikeone/v1/boxes/search/portal?betNumbers&date&live=true
//       &menu=/futbal&minutes&order=<prev maxBoxOrder>&prematch=true&results=false&limit=100
// limit > ~100 returns HTTP 400. Paginate with order = previous response's
// maxBoxOrder while hasMoreBets. Several menu= params can be combined (esports).
// Response: { boxes[], bets{betId:..}, sportEvents{id:..}, maxBoxOrder, hasMoreBets }.
// Only each box's default market comes back ("Zápas" 1X2+DC or "Víťaz zápasu");
// live events are listed but their bets are NOT in this response (live odds
// come via the push websocket), so effectively prematch only.
// Selection tip codes (verified on all sports, 2026-11): 49=1 88=X 50=2 52=1X 51=12 53=X2.
// Menu slugs / sportIds from /api-gw/nikeone/v1/init-data/portal menu (2026-11).
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.nike.sk';
const SPORTS = {
  football: ['/futbal'],          // sportId 1
  hockey: ['/hokej'],             // 3
  tennis: ['/tenis'],             // 7
  basketball: ['/basketbal'],     // 5
  handball: ['/hadzana'],         // 11
  volleyball: ['/volejbal'],      // 13
  tabletennis: ['/stolny-tenis'], // 61
  // esports titles (each its own sport on Niké); e-simulations (efutbal/ehokej/ebasketbal) left out
  esports: ['/counter-strike', '/dota-2', '/league-of-legends', '/call-of-duty', '/mobile-legends', '/rainbow-six'],
};
const TIP = { 49: '1', 88: 'X', 50: '2', 52: '1X', 51: '12', 53: 'X2' };
const MATCH_HEADERS = new Set(['Zápas', 'Víťaz zápasu']);
const LIMIT = 100;      // bets per page; the API rejects much larger values with 400
const PAGE_DELAY_MS = 1500;
let lastStats = { pages: {}, errors: [] }; // last collect(): pages per sport + stop reasons

async function nikePage(port) {
  await chrome.launch(port, 'nike', ORIGIN + '/');
  const page = await chrome.bookPage(port, /nike\.sk/);
  if (!/nike\.sk/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

async function fetchPage(page, menus, order) {
  return page.evaluate(async (menus, order, limit) => {
    const q = menus.map(m => 'menu=' + encodeURIComponent(m)).join('&');
    const r = await fetch(`/api-gw/nikeone/v1/boxes/search/portal?betNumbers&date&live=true&${q}&minutes&order=${order ?? ''}&prematch=true&results=false&limit=${limit}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return r.json();
  }, menus, order, LIMIT);
}

// Pure: one or more raw responses (array or single) -> events.
function parse(jsons, sportKey) {
  const list = Array.isArray(jsons) ? jsons : [jsons];
  const now = Date.now();
  const byEvent = new Map();
  const seenBets = new Set();
  for (const json of list) {
    const boxes = json.boxes || [];
    const sevs = json.sportEvents || {};
    const leagueOf = {};
    for (const b of boxes) if (!b.special) for (const id of b.sportEventIds || []) leagueOf[id] = b.name;
    for (const bet of Object.values(json.bets || {})) {
      if (seenBets.has(bet.betId)) continue;
      seenBets.add(bet.betId);
      if (!MATCH_HEADERS.has(bet.header)) continue; // outrights, Superšanca, other markets
      if (bet.bettingState && bet.bettingState !== 'RUNNING') continue;
      // Only on an accumulator of at least minMultiple picks (Niké's lower leagues: "Zápasy na tikete
      // vyžadujú počet tipov najmenej 3"): a single bet is refused, so it can never be a surebet leg.
      if (Number(bet.validationRules && bet.validationRules.minMultiple) > 1) continue;
      const se = sevs[bet.sportEventId];
      const parts = (se && se.participants) || bet.participants || [];
      if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
      const link = `${ORIGIN}/tipovanie/zapas/${bet.sportEventId}`;
      let ev = byEvent.get(bet.sportEventId);
      if (!ev) {
        ev = {
          book: 'nike',
          sport: sportKey,
          league: leagueOf[bet.sportEventId] || (se && se.tournamentName) || null,
          home: String(parts[0]).trim(),
          away: String(parts[1]).trim(),
          start: Date.parse((se && se.expiration) || bet.expirationTime),
          live: !!(se && se.isLive),
          link,
          odds: [],
        };
        byEvent.set(bet.sportEventId, ev);
      }
      for (const row of bet.selectionGrid || []) {
        for (const c of row || []) {
          if (!c || c.type !== 'selection') continue;
          const sel = TIP[c.tip];
          const price = Number(c.odds);
          if (!sel || !c.enabled || c.locked || !(price > 1)) continue;
          if (ev.odds.some(o => o.market === 'h2h' && o.sel === sel)) continue;
          ev.odds.push({ book: 'nike', market: 'h2h', point: null, sel, price, link, updated: now });
        }
      }
    }
  }
  return [...byEvent.values()].filter(e => e.odds.length);
}

async function collect(settings, sportKeys) {
  const cfg = settings.bookmakers.nike || {};
  const maxPages = cfg.maxPages || settings.nikeMaxPages || 15;
  const page = await nikePage(cfg.port);
  const events = [];
  lastStats = { pages: {}, errors: [] };
  for (const key of sportKeys) {
    const menus = SPORTS[key];
    if (!menus) continue;
    const pages = [];
    let order = null;
    for (let i = 0; i < maxPages; i++) {
      const json = await fetchPage(page, menus, order);
      if (json.error) {
        // Cloudflare answers 403 (cf-mitigated: challenge) when reads come too fast.
        // Keep the pages we already have; no retry, no attempt to get around it.
        if (!pages.length) throw new Error(`nike ${key}: ${json.error}`);
        lastStats.errors.push(`${key} page ${i + 1}: ${json.error}`);
        break;
      }
      pages.push(json);
      if (!json.hasMoreBets || json.maxBoxOrder == null || json.maxBoxOrder === order) break;
      order = json.maxBoxOrder;
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }
    lastStats.pages[key] = pages.length;
    events.push(...parse(pages, key));
  }
  return events;
}

// ---- live (fast loop) ---------------------------------------------------------------
// Live odds are not in the boxes API. The live page reads them from Niké's push server, which
// also answers plain snapshot requests (same origin cookies, called from the nike.sk tab):
//   /n1/overview/sports/                      sports with live matches + their overview market ids
//   /n1/overview/<slug>/bets/<marketId>/      every live match's bet in that market (codes 49/88/50)
//   /n1/match/<id>/scoreboard/                match.startTime (cached: needed to pair with other books)
// Draw sports use "Zápas - Výsledok" (1X2), the others the match winner (basketball incl. overtime).
const PUSH = 'https://push.nike.sk/snapshot?format=v2&path=';
const SPORTS_INFO = require('./sports');
const LIVE_HEADERS = { draw: ['Zápas - Výsledok'], nodraw: ['Zápas - Víťaz', 'Zápas - Víťaz vrátane predĺženia'] };
const marketCache = new Map(); // slug -> { id, at }
const startCache = new Map();  // matchId -> ms (null = unknown)

const snapshot = (page, paths) => page.evaluate(async (base, paths) => Promise.all(paths.map(async p => {
  try {
    const r = await fetch(base + encodeURIComponent(p) + '&ts=' + Date.now(), { credentials: 'include' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return (j[0] && j[0][1]) || null;
  } catch (e) { return { error: e.message }; }
})), PUSH, paths);

const wantedHeader = (sportKey, header) => LIVE_HEADERS[SPORTS_INFO[sportKey]?.draw ? 'draw' : 'nodraw'].includes(header);

// Pure: one overview-bets snapshot -> live events (matches without a known start are left out).
function parseLive(json, sportKey, slug, starts) {
  const out = [];
  const now = Date.now();
  for (const bet of (json && json.bets) || []) {
    if (bet.state && bet.state !== 'Running') continue;
    if (!wantedHeader(sportKey, bet.header && bet.header.sk)) continue;
    const parts = (bet.participants || []).map(x => x && (x.sk || x.en));
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const start = starts.get(String(bet.matchId));
    if (!start) continue;
    const link = `${ORIGIN}/live-stavky${slug}/${bet.matchId}`;
    const odds = [];
    for (const c of bet.selections || []) {
      const sel = TIP[c.code];
      const price = Number(c.odds);
      if (!sel || c.enabled === false || c.locked || !(price > 1)) continue;
      odds.push({ book: 'nike', market: 'h2h', point: null, sel, price, link, updated: now });
    }
    if (odds.length) out.push({ book: 'nike', sport: sportKey, league: null, home: parts[0].trim(), away: parts[1].trim(), start, live: true, link, odds, nikeId: String(bet.matchId) });
  }
  return out;
}

async function collectLive(settings, sportKeys) {
  const page = await nikePage(settings.bookmakers.nike.port);
  const [ov] = await snapshot(page, ['/n1/overview/sports/']);
  if (!ov || ov.error) throw new Error(`nike live: overview ${ov ? ov.error : 'empty'}`);
  const bySlug = new Map((ov.sports || []).filter(x => x.matchCount > 0 && !x.isVirtual).map(x => [x.slug, x]));
  const jobs = [];
  for (const key of sportKeys) for (const slug of SPORTS[key] || []) if (bySlug.has(slug)) jobs.push({ key, slug, cols: bySlug.get(slug).overviewColumns || [] });
  const events = [];
  await Promise.all(jobs.map(async j => {
    let m = marketCache.get(j.slug);
    let json = null;
    if (m && Date.now() - m.at < 3600e3) [json] = await snapshot(page, [`/n1/overview${j.slug}/bets/${m.id}/`]);
    if (!json || json.error || !(json.bets || []).some(b => wantedHeader(j.key, b.header && b.header.sk))) {
      json = null;
      // find the column that holds the match result / winner (first 4 overview columns)
      const cols = j.cols.slice(0, 4).map(c => c.marketId);
      const res = await snapshot(page, cols.map(id => `/n1/overview${j.slug}/bets/${id}/`));
      res.forEach((r, i) => { if (!json && r && !r.error && (r.bets || []).some(b => wantedHeader(j.key, b.header && b.header.sk))) { json = r; marketCache.set(j.slug, { id: cols[i], at: Date.now() }); } });
    }
    if (!json) return;
    const ids = [...new Set((json.bets || []).map(b => String(b.matchId)))].filter(id => !startCache.has(id));
    for (let i = 0; i < ids.length; i += 15) {
      const chunk = ids.slice(i, i + 15);
      const sb = await snapshot(page, chunk.map(id => `/n1/match/${id}/scoreboard/`));
      sb.forEach((r, k) => { const t = r && r.match && Date.parse(r.match.startTime); startCache.set(chunk[k], t > 0 ? t : null); });
    }
    events.push(...parseLive(json, j.key, j.slug, startCache));
  }));
  if (startCache.size > 5000) startCache.clear();
  return events;
}

// ---- extra markets (match detail) -------------------------------------------------------
// GET /api-gw/nikeone/v1/boxes/extended/sport-event-id?sportEventId=<id>
//   -> { sportEvents[{participants}], markets[{marketId, name}], bets[{marketId, header, selectionGrid,
//        validationRules}] }; picks are named: team names, "remíza", "1X", "viac ako 2.5" / "menej ako 2.5",
//        handicap "Moldavsko -1.5" / "Kazachstan +1.5", "áno" / "nie". Market names checked 2026-11-13.
// Ported from the Python scanner (extension.parse_nike). Bets that need an accumulator are skipped.
const numOf = s => { const m = /([+-]?\d+(?:[.,]\d+)?)\s*$/.exec(s || ''); return m ? Number(m[1].replace(',', '.')) : NaN; };
const halfLine = x => Number.isFinite(x) && Math.abs(Math.abs(x) % 1 - 0.5) < 1e-9;
const arr = x => (Array.isArray(x) ? x : Object.values(x || {}));

function parseDetail(json, link, now = Date.now()) {
  const se = arr(json && json.sportEvents)[0];
  const parts = (se && se.participants) || [];
  if (parts.length !== 2) return [];
  const [home, away] = parts.map(x => String(x).trim());
  const draw = !!(SPORTS_INFO[sportOf(se.sportId)] && SPORTS_INFO[sportOf(se.sportId)].draw);
  const names = Object.fromEntries(arr(json.markets).map(m => [String(m.marketId), String(m.name || '').trim()]));
  const out = [];
  const seen = new Set();
  // picks: { sel: cell }. The bettor clicks the button by its row (title "Číslo zápasu: <betNumber> | ..."
  // on the match page) and its label (the pick's name, e.g. "viac ako 2.5", "Moldavsko -1.5").
  const put = (market, point, picks, betNumber) => {
    const k = `${market}|${point ?? ''}`;
    if (seen.has(k) || Object.values(picks).some(c => !c || !(Number(c.odds) > 1))) return;
    seen.add(k);
    for (const [sel, c] of Object.entries(picks)) {
      const label = String(c.name || '').trim();
      out.push({ book: 'nike', market, point: point ?? null, sel, price: Math.round(Number(c.odds) * 100) / 100, link, updated: now,
        ...(betNumber ? { pick: { css: `[title^="Číslo zápasu: ${betNumber} |"] a[data-atid="n1-bet-box"]`, label } } : {}) });
    }
  };
  for (const b of arr(json.bets)) {
    if (b.bettingState && b.bettingState !== 'RUNNING') continue;
    if (Number(b.validationRules && b.validationRules.minMultiple) > 1) continue;
    const cells = (b.selectionGrid || []).flat().filter(c => c && c.type === 'selection' && c.enabled !== false && !c.locked);
    const by = Object.fromEntries(cells.map(c => [String(c.name || '').trim(), c]));
    const keys = Object.keys(by);
    const mname = names[String(b.marketId)] || String(b.header || '').trim();
    const n = b.betNumber;
    const ou = market => {
      const o = keys.find(k => /^viac ako/i.test(k)), u = keys.find(k => /^menej ako/i.test(k));
      if (keys.length === 2 && o && u && numOf(o) === numOf(u) && halfLine(numOf(o))) put(market, numOf(o), { O: by[o], U: by[u] }, n);
    };
    const hcp = market => {
      const h = keys.find(k => k.startsWith(home + ' ')), a = keys.find(k => k.startsWith(away + ' '));
      const hl = numOf(h), al = numOf(a);
      if (keys.length === 2 && h && a && Math.abs(hl + al) < 1e-9 && halfLine(hl)) put(market, hl, { H: by[h], A: by[a] }, n);
    };
    if (!draw) {
      if (mname === '1.set' && keys.length === 2 && by[home] && by[away] && !/gem|handic|presn/i.test(b.header || '')) put('set1_h2h', null, { '1': by[home], '2': by[away] }, n);
      continue; // match winner comes from the list
    }
    if (mname === 'Stávka bez remízy' && keys.length === 2) put('dnb', null, { '1': by[home] || by['1'], '2': by[away] || by['2'] }, n);
    else if (mname === 'Obaja dajú gól') put('btts', null, { Y: by['áno'], N: by['nie'] }, n);
    else if (mname === '1. polčas' && by[home] && by['remíza'] && by[away]) put('1h_h2h', null, { '1': by[home], X: by['remíza'], '2': by[away] }, n);
    else if (mname === 'Počet gólov v zápase') ou('totals'); // hockey: regular time, like Tipos
    else if (mname === 'Počet gólov 1.polčas') ou('1h_totals');
    else if (mname === 'Počet gólov dom.') ou('home_totals');
    else if (mname === 'Počet gólov hos.') ou('away_totals');
    else if (mname === 'Počet gólov do rozhodnutia') ou('ot_totals');
    else if (mname === 'Handicap') hcp('spreads');
  }
  return out;
}
const SPORT_IDS = { 1: 'football', 3: 'hockey', 5: 'basketball', 7: 'tennis', 11: 'handball', 13: 'volleyball', 61: 'tabletennis' };
const sportOf = id => SPORT_IDS[Number(id)] || 'esports';

const detailQueue = require('./detailQueue').createDetailQueue({
  name: 'nike',
  keyOf: link => (/\/zapas\/(\d+)/.exec(link) || [])[1] || null,
  fetchOne: async (settings, id) => {
    const page = await nikePage(settings.bookmakers.nike.port);
    return page.evaluate(async (id) => {
      const r = await fetch('/api-gw/nikeone/v1/boxes/extended/sport-event-id?sportEventId=' + encodeURIComponent(id), { headers: { accept: 'application/json' } });
      if (!r.ok) return { error: `HTTP ${r.status}`, status: r.status };
      try { return await r.json(); } catch { return { error: 'non-JSON response' }; }
    }, id);
  },
  parse: (j, link) => parseDetail(j, link),
  gapMs: 1000,
});

module.exports = { SPORTS, collect, collectLive, parse, parseLive, parseDetail, details: detailQueue.details, stats: () => lastStats };
