// Inbet (inbet.com, Bulgaria, EGT Digital platform) collector. Read-only, public pre-match
// odds, no login. Calls the site's own JSON API from INSIDE an inbet.com tab (real Chrome
// passes Cloudflare). Base: https://inbet-api.egt-digital.com/api/sportsapi/public/
//   GET  sports                                   -> sports with categories/tournaments (ids)
//   POST sport-events/v2/tournaments/events/{sportId}?pagingPage=0&pagingSize=3000
//        &marketTemplateId=100001&marketCount=1&viewType=multi     body: [tournamentId,...]
//        -> { events: { id: { eventPath, homeTeam, awayTeam, scheduledTimeUtc, live, markets:[
//             { marketTemplateId, marketStatus, outcomes:[{name:'1'|'X'|'2', odds, isActive}] }]}}}
// Every call needs the site's own client headers (X-Platform-*). X-Platform-Hash is
// base64url(MD5('amazingsecret' + exp)) and X-Platform-Exp is a unix time (the web app uses
// now + 30 min), both computed in the public front-end bundle; without them the API answers
// 488 "Missing user device header". The API is reached from the tab, so CORS is the site's.
// Names: homeTeam/awayTeam are Cyrillic, but eventPath ("Home vs. Away") is Latin, so the
// collector uses eventPath (no transliteration needed for match.js). Tennis/table tennis
// eventPath is "Surname, First vs. Surname, First" and is rewritten to "First Surname".
// scheduledTimeUtc is real UTC; startTime/startDate are Sofia local time mislabelled with Z.
const crypto = require('crypto');
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://inbet.com';
const API = 'https://inbet-api.egt-digital.com/api/sportsapi/public/';
// Our sport key -> Inbet sport path (from GET sports). Hockey/basketball main market is 2-way
// incl. overtime (index.js drops it for hockey), so hockey is left out.
const SPORTS = { football: 'soccer', tennis: 'tennis', basketball: 'basketball', tabletennis: 'table-tennis', volleyball: 'volleyball', handball: 'handball' };
const DRAW = new Set(['football', 'hockey', 'handball']);
const CHUNK = 80; // tournaments per request (football is ~12 MB for all of them at once)

function headers() {
  const exp = Math.round((Date.now() + 30 * 60e3) / 1e3);
  const hash = crypto.createHash('md5').update(`amazingsecret${exp}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return {
    'X-Platform-Lang': 'bg', 'X-Platform-TZ': '120', 'X-Platform-Device': 'mobile',
    'X-Platform-Timezone': 'Europe/Sofia', 'X-Platform-Hash': hash, 'X-Platform-Exp': String(exp),
  };
}

async function inbetPage(port) {
  await chrome.launch(port, 'inbet', ORIGIN + '/sports');
  const page = await chrome.bookPage(port, /inbet[.]com/);
  if (!/inbet[.]com/.test(page.url())) await page.goto(ORIGIN + '/sports', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// One API call from inside the tab. Returns parsed JSON or {error}.
async function call(page, path, body) {
  return page.evaluate(async (url, hdrs, body) => {
    try {
      const init = { headers: { ...hdrs, accept: 'application/json' } };
      if (body) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
      const r = await fetch(url, init);
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { return { error: `HTTP ${r.status} non-JSON` }; }
      if (!r.ok) return { error: `HTTP ${r.status} ${(j && j.Message) || ''}`.trim() };
      return { json: j };
    } catch (e) { return { error: String(e.message || e) }; }
  }, API + path, headers(), body || null);
}

function nameFix(n) {
  // "Surname, First" -> "First Surname" (per side; doubles "A/B" keep their slash)
  return String(n).split('/').map(p => { const m = p.match(/^\s*([^,]+),\s*(.+?)\s*$/); return m ? `${m[2]} ${m[1]}` : p.trim(); }).join('/');
}

function parse(events, sportKey, sportId, sportPath) {
  const out = [];
  const now = Date.now();
  const draw = DRAW.has(sportKey);
  for (const e of Object.values(events || {})) {
    if (e.sportEventType && e.sportEventType !== 'match') continue;
    const parts = String(e.eventPath || '').split(' vs. ');
    let home = parts.length === 2 ? parts[0] : e.homeTeam;
    let away = parts.length === 2 ? parts[1] : e.awayTeam;
    if (!home || !away) continue;
    if (!draw) { home = nameFix(home); away = nameFix(away); }
    const start = Date.parse(`${String(e.scheduledTimeUtc || '').replace(/Z$/, '')}Z`);
    if (!Number.isFinite(start)) continue;
    const link = `${ORIGIN}/sports/${sportPath}-${sportId}`;
    const odds = [];
    for (const m of e.markets || []) {
      if (m.marketStatus !== 'Active') continue;
      const outs = m.outcomes || [];
      const cols = outs.map(o => String(o.name));
      const is3 = draw && cols.length === 3 && cols.join() === '1,X,2';
      const is2 = !draw && cols.length === 2 && cols.join() === '1,2';
      if (!is3 && !is2) continue;
      for (const o of outs) {
        if (o.isActive && Number(o.odds) > 1) odds.push({ book: 'inbet', market: 'h2h', point: null, sel: String(o.name), price: Number(o.odds), link, updated: now });
      }
      if (odds.length) break; // one main market per event
    }
    if (!odds.length) continue;
    out.push({
      book: 'inbet', sport: sportKey,
      league: [e.tournamentPath, e.category].filter(Boolean).join(' / ') || e.tournamentName || null,
      home: home.trim(), away: away.trim(), start, live: !!e.live, link, odds,
    });
  }
  return out;
}

async function fetchSport(page, sportKey) {
  const sp = await call(page, 'sports');
  if (sp.error) throw new Error(`inbet sports: ${sp.error}`);
  const s = (sp.json || []).find(x => x.path === SPORTS[sportKey]);
  if (!s) return [];
  const ids = [];
  for (const c of s.data || []) for (const t of c.data || []) if (t.type === 'tournament' && t.eventsCount > 0) ids.push(t.id);
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const q = `pagingPage=0&pagingSize=3000&marketCount=1&viewType=multi${sportKey === 'football' ? '&marketTemplateId=100001' : ''}`;
    const r = await call(page, `sport-events/v2/tournaments/events/${s.id}?${q}`, ids.slice(i, i + CHUNK));
    if (r.error) throw new Error(`inbet ${sportKey}: ${r.error}`);
    out.push(...parse(r.json.events, sportKey, s.id, s.path));
  }
  return out;
}

async function collect(settings, sportKeys) {
  const port = (settings.bookmakers.inbet || {}).port || 9320;
  const page = await inbetPage(port);
  const events = [];
  for (const key of sportKeys) {
    if (!SPORTS[key]) continue;
    events.push(...await fetchSport(page, key));
  }
  return events;
}

module.exports = { SPORTS, collect, parse };
