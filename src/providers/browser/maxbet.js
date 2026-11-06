// Maxbet North Macedonia (maxbet.mk) pre-match collector. Public odds, no login.
// maxbet.mk runs the same iBet platform as maxbet.rs (its bundle even points REST_API_ADDRESS to
// maxbet.rs/restapi); from a maxbet.mk tab the same-origin REST call works:
//   GET /restapi/offer/mk/sport/<code>/mob?annex=50&hours=<N>
// -> { esMatches:[{ id, home, away, kickOffTime(ms), status, blocked, leagueName, live(=has live offer),
//      odds:{ "<betPickCode>": price, ... } }] }   (verified 2026-11-06)
// Sport codes (from /restapi/translate/mk/sports and the live offer): S football, T tennis, B basketball, H hockey.
// Bet pick codes (verified against the site): football 1 / 2 / 3 = 1 / X / 2; tennis 1 / 3 = home / away.
// Team names come Latin-script from the feed ("Septemvri Sofia", "Van Assche L."), so no
// transliteration is needed; only league names for basketball are prefixed with Cyrillic sport name.
// Football is ~10 MB / ~12 s for the whole offer, so set everySec (60+) in the book's config.
// "desk" variant is lighter but carries no odds, so the "mob" variant is used.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.maxbet.mk';
const SPORTS = { football: 'S', tennis: 'T', basketball: 'B', hockey: 'H' };
const DRAW = new Set(['football', 'hockey']);

async function maxbetPage(port) {
  await chrome.launch(port, 'maxbet', ORIGIN + '/mk');
  const page = await chrome.bookPage(port, /maxbet[.]mk/);
  if (!/maxbet[.]mk/.test(page.url())) await page.goto(ORIGIN + '/mk', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// Runs inside the tab; returns only the fields we need (the raw response is ~10 MB for football).
async function fetchSport(page, code, hours) {
  return page.evaluate(async (code, hours) => {
    try {
      const r = await fetch(`/restapi/offer/mk/sport/${code}/mob?annex=50${hours ? `&hours=${hours}` : ''}&locale=mk`);
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const j = await r.json();
      return {
        matches: (j.esMatches || []).map(m => ({
          id: m.id, home: m.home, away: m.away, t: m.kickOffTime, status: m.status, blocked: m.blocked,
          league: m.leagueName, o1: m.odds && m.odds['1'], o2: m.odds && m.odds['2'], o3: m.odds && m.odds['3'],
        })),
      };
    } catch (e) { return { error: String(e.message || e) }; }
  }, code, hours);
}

function parse(matches, sportKey) {
  const out = [];
  const now = Date.now();
  const draw = DRAW.has(sportKey);
  for (const m of matches || []) {
    if (!m.home || !m.away || m.blocked || m.status !== 0 || !(m.t > now)) continue;
    const link = `${ORIGIN}/mk`;
    const odds = [];
    const push = (sel, price) => { if (price > 1) odds.push({ book: 'maxbet', market: 'h2h', point: null, sel, price: Number(price), link, updated: now }); };
    if (draw) {
      // Need the full 3-way (regulation) market, never a partial one.
      if (!(m.o1 > 1 && m.o2 > 1 && m.o3 > 1)) continue;
      push('1', m.o1); push('X', m.o2); push('2', m.o3);
    } else {
      push('1', m.o1); push('2', m.o3);
      if (odds.length !== 2) continue;
    }
    out.push({
      book: 'maxbet', sport: sportKey, league: m.league || null,
      home: String(m.home).trim(), away: String(m.away).trim(),
      start: m.t, live: false, link, odds,
    });
  }
  return out;
}

async function collect(settings, sportKeys) {
  const cfg = settings.bookmakers.maxbet || {};
  const page = await maxbetPage(cfg.port || 9330);
  const events = [];
  for (const key of sportKeys) {
    if (!SPORTS[key]) continue;
    const res = await fetchSport(page, SPORTS[key], settings.maxbetHours || 96);
    if (res.error) throw new Error(`maxbet ${key}: ${res.error}`);
    events.push(...parse(res.matches, key));
  }
  return events;
}

// Pre-match only (live odds are on a separate websocket feed, not verified): no collectLive.
module.exports = { SPORTS, collect, parse };
