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

module.exports = { SPORTS, collect, parse, stats: () => lastStats };
