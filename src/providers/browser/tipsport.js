// Tipsport collector. Calls Tipsport's own offer API from INSIDE your logged-in
// Tipsport tab (same origin, your cookies, Cloudflare already passed), the same
// request the site makes when you open a sport page:
//   POST /rest/offer/v2/offer?limit=N
//   {"results":false,"highlightAnyTime":false,"limit":N,"order":"DATESTART",
//    "type":"SUPERSPORT","id":<superSportId>,"matchViewFilters":[],"withLive":true}
// Super sport ids (from /rest/offer/v6/sports, 2026-11): 16 Futbal, 23 Hokej,
// 43 Tenis, 7 Basketbal, 40 Stolný tenis, 188 Ešporty, 47 Volejbal, 20 Hádzaná.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.tipsport.sk';
// Our sport key -> Tipsport super sport id.
const SPORTS = { football: 16, tennis: 43, hockey: 23, basketball: 7, tabletennis: 40, esports: 188, volleyball: 47, handball: 20 };
const SEL = { '1': '1', 'x': 'X', '2': '2', '1x': '1X', 'x2': 'X2', '12': '12' };

async function tipsportPage(port) {
  await chrome.launch(port, 'tipsport', ORIGIN + '/');
  const page = await chrome.bookPage(port, /tipsport\.sk/);
  if (!/tipsport\.sk/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

async function fetchSport(page, superSportId, limit) {
  return page.evaluate(async (id, limit) => {
    const r = await fetch(`/rest/offer/v2/offer?limit=${limit}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=utf-8', accept: 'application/json', platform: 'WEB' },
      body: JSON.stringify({ results: false, highlightAnyTime: false, limit, order: 'DATESTART', type: 'SUPERSPORT', id, matchViewFilters: [], withLive: true }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return r.json();
  }, superSportId, limit);
}

function parse(json, sportKey) {
  const out = [];
  for (const ss of json.offerSuperSports || []) {
    for (const tab of ss.tabs || []) {
      for (const comp of tab.offerCompetitionAnnuals || []) {
        for (const m of comp.matches || []) {
          if (!m.participantHome || !m.participantVisiting) continue; // outrights, specials
          const odds = [];
          for (const row of m.oppRows || []) {
            for (const o of row.oppsTab || []) {
              if (!o) continue; // empty slot (outcome not offered)
              const sel = SEL[String(o.type).toLowerCase()];
              if (!sel || !o.bettingEnabled || !(o.odd > 1)) continue;
              odds.push({ book: 'tipsport', market: 'h2h', point: null, sel, price: Number(o.odd), link: ORIGIN + m.url, updated: Date.now(), oppId: o.id });
            }
          }
          if (!odds.length) continue;
          out.push({
            book: 'tipsport',
            sport: sportKey,
            league: m.competition || comp.name,
            home: m.participantHome.trim(),
            away: m.participantVisiting.trim(),
            start: Date.parse(m.dateClosed),
            live: !!m.inLive,
            link: ORIGIN + m.url,
            odds,
          });
        }
      }
    }
  }
  return out;
}

async function collect(settings, sportKeys) {
  const port = settings.bookmakers.tipsport.port;
  const page = await tipsportPage(port);
  const events = [];
  for (const key of sportKeys) {
    if (!SPORTS[key]) continue;
    const json = await fetchSport(page, SPORTS[key], settings.tipsportLimit || 300);
    if (json.error) throw new Error(`tipsport ${key}: ${json.error}`);
    events.push(...parse(json, key));
  }
  return events;
}

// Live only (fast loop): same call (withLive), keep in-play matches.
async function collectLive(settings, sportKeys) {
  return (await collect(settings, sportKeys)).filter(e => e.live);
}

module.exports = { SPORTS, collect, collectLive, parse };
