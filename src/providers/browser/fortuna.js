// Fortuna (ifortuna.sk) collector. Calls Fortuna's own offer API from INSIDE an
// ifortuna.sk tab (api.ifortuna.sk allows the www origin, site cookies), the
// same GET requests the site makes when you open a sport page (e.g. /stavkovanie/futbal):
//   1. GET /offer/markets/api/v1_0/codebook/sport/<sportId>/overview-market-types?timeFilter=all
//        -> [{marketTypeId, marketTypeName}]  (cached; used to find market type ids by name)
//   2. GET /offer/structure/api/v1_0/sport/<sportId>/tournaments?categories=true&timeFilter=all
//        -> {sport, categories, tournaments:[{id, name, fixturesCount, features}]}
//   3. GET /offer/structure/api/v1_0/tournament/<tournamentId>/matches?timeFilter=all
//        -> {tournament, fixtures:[{id, kind:'PREMATCH'|'LIVE', status, participants:[{name,type:'HOME'|'AWAY'}],
//            startDatetime(ms), sportSeoName, categorySeoName, tournamentSeoName, seoName}]}
//      There is no sport-wide fixture list: the site itself loads matches per tournament.
//   4. GET /offer/markets/api/v1_0/fixtures/markets/overview?fixtureIds=..&fixtureIds=..&marketTypeIds=..
//        -> {"<fixtureId>": [{marketTypeId, name, outcomes:[{name, odds, displayType:'OPEN'|..}]}]}
//      Batched (up to 50 fixtures per call).
// Sport ids from /offer/structure/api/v1_0/sports?timeFilter=all (2026-11).
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.ifortuna.sk';
const API = 'https://api.ifortuna.sk/offer';

// Our key -> Fortuna sport id(s). Esports is split by game on Fortuna.
const SPORTS = {
  football: ['ufo:sprt:00'],    // Futbal
  tennis: ['ufo:sprt:0x'],      // Tenis
  hockey: ['ufo:sprt:0w'],      // Hokej
  basketball: ['ufo:sprt:0i'],  // Basketbal
  tabletennis: ['ufo:sprt:0j'], // Stolný tenis
  esports: ['ufo:sprt:02', 'ufo:sprt:03', 'ufo:sprt:04', 'ufo:sprt:08'], // CS, LOL, DOTA2, Overwatch
  volleyball: ['ufo:sprt:0m'],  // Volejbal
  handball: ['ufo:sprt:0y'],    // Hádzaná
};

// Market type names (from the overview-market-types codebook) per our sport.
//   h2h:    main result market. Draw sports: "Výsledok zápasu" (1/0/2, regular time).
//           Basketball: 2-way incl. overtime, matching draw:false in sports.js.
//   dc:     double chance (outcomes "10", "02", "12").
//   totals: full-time total goals, outcomes "Viac ako 2.5" / "Menej ako 2.5" or "+ 60.5" / "- 60.5".
const MARKETS = {
  football: { h2h: ['Výsledok zápasu'], dc: ['Výsledok zápasu - dvojtip'], totals: ['Počet gólov'] },
  hockey: { h2h: ['Výsledok zápasu'], dc: ['Výsledok zápasu - dvojtip'], totals: ['Počet gólov v zápase'] },
  handball: { h2h: ['Výsledok zápasu'], dc: ['Výsledok zápasu - dvojtip'], totals: ['Počet gólov v zápase'] },
  basketball: { h2h: ['Víťaz zápasu (vrátane predĺženia)'] },
  tennis: { h2h: ['Víťaz zápasu'] },
  tabletennis: { h2h: ['Víťaz zápasu'] },
  esports: { h2h: ['Víťaz zápasu'] },
  volleyball: { h2h: ['Víťaz zápasu'] },
};

const H2H_SEL = { '1': '1', '0': 'X', '2': '2' };
const DC_SEL = { '10': '1X', '02': 'X2', '12': '12' };

async function fortunaPage(port) {
  await chrome.launch(port, 'fortuna', ORIGIN + '/');
  const page = await chrome.bookPage(port, /ifortuna\.sk/);
  if (!/ifortuna\.sk/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// marketTypeId -> {kind:'h2h'|'dc'|'totals'} for one Fortuna sport, cached 1 h.
const typeCache = new Map();
async function marketTypes(page, sportId, key) {
  const c = typeCache.get(sportId);
  if (c && Date.now() - c.at < 3600e3) return c.types;
  const res = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    return r.ok ? r.json() : { error: `HTTP ${r.status}` };
  }, `${API}/markets/api/v1_0/codebook/sport/${sportId}/overview-market-types?timeFilter=all`);
  if (res.error) throw new Error(`market types ${sportId}: ${res.error}`);
  const want = MARKETS[key] || {};
  const types = {};
  for (const t of Array.isArray(res) ? res : []) {
    for (const kind of ['h2h', 'dc', 'totals']) {
      if ((want[kind] || []).includes(t.marketTypeName)) types[t.marketTypeId] = kind;
    }
  }
  typeCache.set(sportId, { at: Date.now(), types });
  return types;
}

// Runs in the page: tournaments -> matches per tournament -> overview markets.
// Returns trimmed raw data in the API's own field names (input for parse()).
async function fetchSport(page, sportId, marketTypeIds, opts) {
  return page.evaluate(async (API, sportId, marketTypeIds, opts) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const get = async (url) => {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(API, '').slice(0, 80)}`);
      return r.json();
    };
    try {
      const tree = await get(`${API}/structure/api/v1_0/sport/${sportId}/tournaments?categories=true&timeFilter=all`);
      const tours = (tree.tournaments || [])
        .filter(t => t.fixturesCount > 0 && (!t.features || t.features.includes('MATCHES')))
        .slice(0, opts.maxTournaments);
      const tournaments = tours.map(t => ({ id: t.id, name: t.name }));
      const fixtures = [];
      for (let i = 0; i < tours.length; i += opts.concurrency) {
        const chunk = tours.slice(i, i + opts.concurrency);
        const res = await Promise.all(chunk.map(t =>
          get(`${API}/structure/api/v1_0/tournament/${encodeURIComponent(t.id)}/matches?timeFilter=all`).catch(() => null)));
        for (const r of res) {
          for (const f of (r && r.fixtures) || []) {
            fixtures.push({
              id: f.id, tournamentId: f.tournamentId, kind: f.kind, status: f.status, hasMarkets: f.hasMarkets,
              participants: (f.participants || []).map(p => ({ name: p.name, type: p.type })),
              startDatetime: f.startDatetime, sportSeoName: f.sportSeoName, categorySeoName: f.categorySeoName,
              tournamentSeoName: f.tournamentSeoName, seoName: f.seoName,
            });
          }
        }
        if (i + opts.concurrency < tours.length) await sleep(opts.delayMs);
      }
      const markets = {};
      const ids = fixtures.filter(f => f.hasMarkets !== false && f.participants.length === 2).map(f => f.id);
      const mt = marketTypeIds.map(m => 'marketTypeIds=' + encodeURIComponent(m)).join('&');
      for (let i = 0; i < ids.length && mt; i += opts.batch) {
        const q = ids.slice(i, i + opts.batch).map(id => 'fixtureIds=' + encodeURIComponent(id)).join('&');
        const r = await get(`${API}/markets/api/v1_0/fixtures/markets/overview?${q}&${mt}`);
        for (const [fid, ms] of Object.entries(r || {})) {
          markets[fid] = (ms || []).map(m => ({
            marketTypeId: m.marketTypeId, name: m.name,
            outcomes: (m.outcomes || []).map(o => ({ name: o.name, odds: o.odds, displayType: o.displayType })),
          }));
        }
        if (i + opts.batch < ids.length) await sleep(opts.delayMs);
      }
      return { tournaments, fixtures, markets };
    } catch (e) {
      return { error: e.message };
    }
  }, API, sportId, marketTypeIds, opts);
}

function linkFor(f) {
  if (!f.sportSeoName || !f.categorySeoName || !f.tournamentSeoName || !f.seoName) return null;
  return `${ORIGIN}/stavkovanie/${f.sportSeoName}/${f.categorySeoName}/${f.tournamentSeoName}/${f.seoName}`;
}

// Pure: raw = { tournaments:[{id,name}], fixtures:[...], markets:{fixtureId:[...]} } as returned
// by fetchSport; types = { marketTypeId: 'h2h'|'dc'|'totals' }; sportKey = our key.
function parse(raw, sportKey, types) {
  const out = [];
  const league = new Map((raw.tournaments || []).map(t => [t.id, t.name]));
  const now = Date.now();
  for (const f of raw.fixtures || []) {
    if (f.status && f.status !== 'ACTIVE') continue;
    const home = (f.participants || []).find(p => p.type === 'HOME');
    const away = (f.participants || []).find(p => p.type === 'AWAY');
    if (!home || !away || (f.participants || []).length !== 2) continue;
    const link = linkFor(f);
    const odds = [];
    const seen = new Set();
    for (const m of (raw.markets || {})[f.id] || []) {
      const kind = types[m.marketTypeId];
      if (!kind) continue;
      for (const o of m.outcomes || []) {
        if (o.displayType !== 'OPEN') continue;
        const price = Number(o.odds);
        if (!(price > 1)) continue;
        let sel, point = null, market = 'h2h';
        if (kind === 'h2h') {
          // most sports name outcomes "1"/"0"/"2"; esports use the team names
          sel = H2H_SEL[o.name];
          if (!sel && o.name === home.name) sel = '1';
          else if (!sel && o.name === away.name) sel = '2';
        }
        else if (kind === 'dc') sel = DC_SEL[o.name];
        else {
          // "Viac ako 2.5" / "Menej ako 2.5" (football, hockey) or "+ 60.5" / "- 60.5" (handball)
          const mm = /^(Viac ako|Menej ako|\+|-)\s*(\d+(?:\.\d+)?)$/.exec(String(o.name).trim());
          if (!mm) continue;
          market = 'totals'; sel = /^(Viac|\+)/.test(mm[1]) ? 'O' : 'U'; point = Number(mm[2]);
        }
        if (!sel) continue;
        const k = `${market}|${point}|${sel}`;
        if (seen.has(k)) continue; // same line listed twice: keep the first
        seen.add(k);
        odds.push({ book: 'fortuna', market, point, sel, price, link, updated: now });
      }
    }
    if (!odds.length) continue;
    out.push({
      book: 'fortuna',
      sport: sportKey,
      league: league.get(f.tournamentId) || null,
      home: String(home.name).trim(),
      away: String(away.name).trim(),
      start: Number(f.startDatetime),
      live: f.kind === 'LIVE',
      link,
      odds,
    });
  }
  return out;
}

async function collect(settings, sportKeys) {
  const port = settings.bookmakers.fortuna.port;
  const page = await fortunaPage(port);
  const opts = {
    maxTournaments: settings.fortunaMaxTournaments || 400,
    concurrency: 3,
    delayMs: 150,
    batch: 50,
  };
  const events = [];
  for (const key of sportKeys) {
    for (const sportId of SPORTS[key] || []) {
      const types = await marketTypes(page, sportId, key);
      const ids = Object.keys(types);
      if (!ids.length) continue;
      const raw = await fetchSport(page, sportId, ids, opts);
      if (raw.error) throw new Error(`fortuna ${key} ${sportId}: ${raw.error}`);
      events.push(...parse(raw, key, types));
    }
  }
  return events;
}

module.exports = { SPORTS, MARKETS, collect, parse, fetchSport, marketTypes };
