// OlyBet Lithuania (olybet.lt) collector. The sportsbook (iframe nw.olybet.lt) is a
// BetConstruct "Swarm" site (site_id 313): odds come over a WebSocket, not HTTP.
// Read-only, logged out. From inside an olybet.lt tab (Cloudflare passed by the real
// Chrome) we open our own WebSocket to the same endpoint the UI uses:
//   wss://eu-swarm-newm.betconstruct.com
//   -> {command:'request_session', params:{language:'eng', site_id:313, source:42}, rid}
//   -> {command:'get', params:{source:'betting', what:{...}, where:{...}, subscribe:false}, rid}
// Response is a tree sport > region > competition > game > market > event (dict mode).
// game.type: 0/2 = pre-match, 1 = live. Market types seen: P1XP2 (1X2, events P1/X/P2),
// P1P2 (tennis match winner), OverUnder (full-time total goals, `base` = line).
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.olybet.lt';
const WS_URL = 'wss://eu-swarm-newm.betconstruct.com';
const SITE_ID = 313;
// Our sport key -> Swarm sport id (from the `sport` listing, 2026-11).
const SPORTS = { football: 1, tennis: 4, hockey: 2, basketball: 3, volleyball: 5, handball: 29, tabletennis: 41 };
const DRAW = new Set(['football', 'hockey', 'handball']);
const SEL = { P1: '1', X: 'X', P2: '2' };

async function olybetPage(port) {
  await chrome.launch(port, 'olybet', ORIGIN + '/');
  const page = await chrome.bookPage(port, /olybet[.]lt/);
  if (!/olybet[.]lt/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// One session + one `get` over a fresh WebSocket opened inside the page.
async function swarmGet(page, sportId, types, marketTypes) {
  return page.evaluate((WS_URL, SITE_ID, sportId, types, marketTypes) => new Promise(resolve => {
    let done = false;
    const fin = v => { if (!done) { done = true; clearTimeout(t); try { ws.close(); } catch { } resolve(v); } };
    const t = setTimeout(() => fin({ error: 'timeout' }), 40000);
    const ws = new WebSocket(WS_URL);
    ws.onerror = () => fin({ error: 'websocket error' });
    ws.onopen = () => ws.send(JSON.stringify({ command: 'request_session', params: { language: 'eng', site_id: SITE_ID, source: 42 }, rid: 's' }));
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.rid === 's') {
        if (m.code !== 0) return fin({ error: 'session code ' + m.code });
        ws.send(JSON.stringify({
          command: 'get', rid: 'g',
          params: {
            source: 'betting',
            what: {
              sport: ['id', 'alias'], region: ['id', 'name', 'alias'], competition: ['id', 'name'],
              game: ['id', 'type', 'start_ts', 'team1_name', 'team2_name', 'is_blocked'],
              market: ['id', 'type', 'base'],
              event: ['id', 'price', 'type', 'base'],
            },
            where: { sport: { id: sportId }, game: { type: { '@in': types } }, market: { type: { '@in': marketTypes } } },
            subscribe: false,
          },
        }));
      } else if (m.rid === 'g') {
        if (m.code !== 0) return fin({ error: 'get code ' + m.code });
        fin({ data: m.data && m.data.data });
      }
    };
  }), WS_URL, SITE_ID, sportId, types, marketTypes);
}

const slug = s => encodeURIComponent(String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

function parse(data, sportKey, now = Date.now()) {
  const out = [];
  const draw = DRAW.has(sportKey);
  for (const sp of Object.values((data && data.sport) || {})) {
    for (const reg of Object.values(sp.region || {})) {
      for (const comp of Object.values(reg.competition || {})) {
        for (const g of Object.values(comp.game || {})) {
          if (!g.team1_name || !g.team2_name || g.is_blocked) continue;
          const link = `https://nw.olybet.lt/lt/sports/${g.type === 1 ? 'live' : 'pre-match'}/event-view/${sp.alias}/${reg.alias}/${comp.id}-${slug(comp.name)}/${g.id}-${slug(g.team1_name + '-' + g.team2_name)}`;
          const odds = [];
          for (const m of Object.values(g.market || {})) {
            const evs = Object.values(m.event || {});
            if ((m.type === 'P1XP2' && draw) || (m.type === 'P1P2' && !draw)) {
              for (const e of evs) {
                const sel = SEL[e.type];
                if (sel && Number(e.price) > 1) odds.push({ book: 'olybet', market: 'h2h', point: null, sel, price: Number(e.price), link, updated: now });
              }
            } else if (m.type === 'OverUnder' && sportKey === 'football') {
              const line = Number(m.base);
              for (const e of evs) {
                const sel = /^over/i.test(e.type) ? 'O' : /^under/i.test(e.type) ? 'U' : null;
                if (sel && line > 0 && Number(e.price) > 1) odds.push({ book: 'olybet', market: 'totals', point: line, sel, price: Number(e.price), link, updated: now });
              }
            }
          }
          if (!odds.length) continue;
          out.push({
            book: 'olybet',
            sport: sportKey,
            league: `${reg.name} ${comp.name}`.trim(),
            home: String(g.team1_name).trim(),
            away: String(g.team2_name).trim(),
            start: g.start_ts * 1000,
            live: g.type === 1,
            link,
            odds,
          });
        }
      }
    }
  }
  return out;
}

async function run(settings, sportKeys, types) {
  const port = ((settings.bookmakers || {}).olybet || {}).port || 9310;
  const page = await olybetPage(port);
  const events = [];
  for (const key of sportKeys) {
    if (!SPORTS[key]) continue;
    const mts = DRAW.has(key) ? ['P1XP2', 'OverUnder'] : ['P1P2'];
    const r = await swarmGet(page, SPORTS[key], types, mts);
    if (r.error) throw new Error(`olybet ${key}: ${r.error}`);
    events.push(...parse(r.data, key));
  }
  return events;
}

async function collect(settings, sportKeys) { return run(settings, sportKeys, [0, 1, 2]); }
async function collectLive(settings, sportKeys) { return (await run(settings, sportKeys, [1])).filter(e => e.live); }

module.exports = { SPORTS, collect, collectLive, parse };
