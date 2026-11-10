// Megawin North Macedonia (megawin.mk) collector. Its sportsbook is Sportinno's widget. The one
// public (no login token) offer call is the homepage's featured-matches feed:
//   GET https://cdn-mk-api.sportinno.net/api/v3/widgets/derby-events?bid=1014917589
// -> { sports:[{ id, identifier:"football"|"tennis"|..., categories:[{ name, tournaments:[{ name,
//      sportEvents:[{ id, name:"Home vs Away", startTime(ISO, UTC), isLive, status,
//        teams:[{name},{name}], marketTypes:[{ id, markets:[{ status, line, isMainLine,
//          selections:[{ name:"1"|"X"|"2"|"Над 2.5"|"Под 2.5", odds, isActive, status }] }] }] }] }] }] }] }
// (verified 2026-11-10: ~30 matches, football / tennis / basketball / handball).
// The full offer (widgets/events/<sport>) needs the logged-in widget's token and is not read.
// That matches what can be bet: megawin.mk/sport redirects to the homepage from outside North
// Macedonia, so only these featured matches have clickable odds (on the homepage).
// Market type ids: 23 = 1X2 (football/handball, regular time), 16 = tennis winner,
// 212 = basketball winner incl. overtime, 24 = football total goals (90 min).
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://megawin.mk';
const FEED = 'https://cdn-mk-api.sportinno.net/api/v3/widgets/derby-events?bid=1014917589';
const SPORTS = { football: 'football', tennis: 'tennis', basketball: 'basketball', handball: 'handball' };
const H2H = { football: 23, handball: 23, tennis: 16, basketball: 212 };
const TOTALS = { football: 24 };

async function megawinPage(port) {
  await chrome.launch(port, 'megawin', ORIGIN + '/');
  const page = await chrome.bookPage(port, /megawin\.mk/);
  if (!/megawin\.mk/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

async function fetchFeed(page) {
  return page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return await r.json();
    } catch (e) { return { error: String(e.message || e) }; }
  }, FEED);
}

const live = s => s && s.isActive !== false && s.status === 1 && Number(s.odds) > 1;
const r2 = n => Math.round(Number(n) * 100) / 100;

// Pure: feed JSON -> events for one of our sport keys.
function parse(json, sportKey, now = Date.now()) {
  const out = [];
  const sport = (json.sports || []).find(s => s.identifier === SPORTS[sportKey]);
  if (!sport) return out;
  for (const cat of sport.categories || []) {
    for (const t of cat.tournaments || []) {
      for (const ev of t.sportEvents || []) {
        const teams = ev.teams || [];
        const parts = String(ev.name || '').split(' vs ');
        const home = String((teams[0] && teams[0].name) || parts[0] || '').trim();
        const away = String((teams[1] && teams[1].name) || parts[1] || '').trim();
        const start = Date.parse(ev.startTime);
        if (!home || !away || !Number.isFinite(start)) continue;
        if (ev.isLive || start <= now) continue; // featured feed: pre-match only
        const odds = [];
        const add = (market, point, sel, price) => odds.push({ book: 'megawin', market, point, sel, price: r2(price), link: ORIGIN + '/', linkGeneric: true, updated: now });
        const types = ev.marketTypes || [];
        // Winner / 1X2: the whole market must be open, never part of it.
        const h = types.find(m => m.id === H2H[sportKey]);
        const hm = h && (h.markets || []).find(m => m.status === 1);
        if (hm) {
          const by = Object.fromEntries((hm.selections || []).map(s => [String(s.name).trim(), s]));
          const want = H2H[sportKey] === 23 ? ['1', 'X', '2'] : ['1', '2'];
          if (want.every(k => live(by[k]))) for (const k of want) add('h2h', null, k, by[k].odds);
        }
        // Totals: half lines only ("Над 2.5" / "Под 2.5"), both sides open.
        const tt = types.find(m => m.id === TOTALS[sportKey]);
        for (const m of (tt && tt.markets) || []) {
          if (m.status !== 1) continue;
          const line = Number(String(m.line).replace(',', '.'));
          if (!Number.isFinite(line) || line % 1 !== 0.5) continue;
          const over = (m.selections || []).find(s => /^Над/i.test(String(s.name)));
          const under = (m.selections || []).find(s => /^Под/i.test(String(s.name)));
          if (!live(over) || !live(under)) continue;
          add('totals', line, 'O', over.odds);
          add('totals', line, 'U', under.odds);
        }
        if (!odds.length) continue;
        out.push({
          book: 'megawin', sport: sportKey,
          league: [cat.name, t.name].filter(Boolean).join(' - ') || null,
          home, away, start, live: false, link: ORIGIN + '/', odds,
        });
      }
    }
  }
  return out;
}

async function collect(settings, sportKeys) {
  const cfg = settings.bookmakers.megawin || {};
  const page = await megawinPage(cfg.port || 9332);
  const keys = sportKeys.filter(k => SPORTS[k]);
  if (!keys.length) return [];
  const json = await fetchFeed(page);
  if (json.error) throw new Error(`megawin: ${json.error}`);
  return keys.flatMap(k => parse(json, k));
}

// Pre-match only (the featured feed is small and read every everySec): no collectLive.
module.exports = { SPORTS, collect, parse, FEED };
