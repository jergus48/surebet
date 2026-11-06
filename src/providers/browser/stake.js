// Stake (stake.com) sportsbook collector. Read-only, public odds, no login.
// Calls Stake's own GraphQL endpoint from INSIDE a stake.com tab (same origin, the
// real Chrome has passed Cloudflare), the same query shape the sportsbook UI sends
// (SportIndex): POST /_api/v1/graphql
//   slugSport(sport:$slug){ tournamentList(type:$type,limit:300,offset){ id slug category{slug}
//     fixtureCount(type:$type) fixtureList(type:$type,limit:50,offset){ id slug status
//       data{... on SportFixtureDataMatch{startTime teams{name qualifier}}}
//       groups(groups:["winner"],status:[...]){ templates{ extId name markets{ status outcomes{ active odds name }}}}}}}
// type = upcoming | live (SportSearchEnum). fixtureList limit is capped at 50 by the API
// (more -> error numberLessEqual), so extra fixtures are paged with offset. Odds are
// decimal. Stake's own live/UI data also flows over wss://stake.com/_api/websockets but
// plain POST queries are enough for polling.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://stake.com';
// Our sport key -> Stake sport slug(s). Esports are one Stake sport per game.
const SPORTS = {
  football: ['soccer'], tennis: ['tennis'], hockey: ['ice-hockey'], basketball: ['basketball'],
  tabletennis: ['table-tennis'], volleyball: ['volleyball'], handball: ['handball'], esports: null,
};
const DRAW = new Set(['football', 'hockey', 'handball']);
const FIX_PAGE = 50; // API max for fixtureList limit
const TOUR_PAGE = 300;

const QUERY = `query Odds($sport:String!,$type:SportSearchEnum!,$toff:Int!,$foff:Int!){
 slugSport(sport:$sport){ slug tournamentList(type:$type,limit:${TOUR_PAGE},offset:$toff){
  id slug name category{ slug name }
  fixtureCount(type:$type)
  fixtureList(type:$type,limit:${FIX_PAGE},offset:$foff){
   id slug name status
   data{ __typename ... on SportFixtureDataMatch{ startTime isOutright teams{ name qualifier } competitors{ name } } }
   groups(groups:["winner"],status:[active,suspended,deactivated]){ name templates(limit:10,includeEmpty:false){
    extId name markets(limit:3){ status specifiers outcomes{ active odds name } } } }
  } } } }`;

// Page-level GraphQL call; returns parsed JSON or {error}.
async function gql(page, query, variables) {
  return page.evaluate(async (query, variables) => {
    try {
      const r = await fetch('/_api/v1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { return { error: `HTTP ${r.status} non-JSON (Cloudflare challenge?)` }; }
      if (!r.ok && !j.data) return { error: `HTTP ${r.status}` };
      return j;
    } catch (e) { return { error: String(e.message || e) }; }
  }, query, variables);
}

async function stakePage(port) {
  await chrome.launch(port, 'stake', ORIGIN + '/sports/home');
  const page = await chrome.bookPage(port, /stake[.]com/);
  if (!/stake[.]com/.test(page.url())) await page.goto(ORIGIN + '/sports/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  // Let a Cloudflare interstitial clear by itself (never bypassed): wait until the API answers JSON.
  let last = '';
  for (let i = 0; i < 20; i++) {
    const r = await gql(page, '{ country }', {});
    if (!r.error && r.data) return page;
    last = r.error || 'no data';
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(`stake: API not reachable (${last})`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// All tournaments (with first 50 fixtures each) for one sport slug + type; pages tournaments
// and a tournament's fixtures when the API caps them.
async function fetchSport(page, slug, type) {
  const tours = [];
  for (let toff = 0; toff < TOUR_PAGE * 5; toff += TOUR_PAGE) {
    const j = await gql(page, QUERY, { sport: slug, type, toff, foff: 0 });
    if (j.error) throw new Error(j.error);
    if (j.errors && !j.data) throw new Error(String(j.errors[0] && j.errors[0].message));
    const sp = j.data && j.data.slugSport;
    if (!sp) return { sport: null, tours: [] }; // unknown / empty slug
    const list = sp.tournamentList || [];
    tours.push(...list);
    if (list.length < TOUR_PAGE) break;
  }
  // Tournaments with more fixtures than one page: one extra pass per fixture offset.
  const maxCount = Math.min(Math.max(0, ...tours.map(t => t.fixtureCount || 0)), 500);
  const byId = new Map(tours.map(t => [t.id, t]));
  for (let foff = FIX_PAGE; foff < maxCount; foff += FIX_PAGE) {
    for (let toff = 0; toff < tours.length; toff += TOUR_PAGE) {
      const j = await gql(page, QUERY, { sport: slug, type, toff, foff });
      const list = (j.data && j.data.slugSport && j.data.slugSport.tournamentList) || [];
      for (const x of list) { const t = byId.get(x.id); if (t && x.fixtureList.length) t.fixtureList.push(...x.fixtureList); }
      await sleep(100);
    }
  }
  return { sport: slug, tours };
}

const norm = s => String(s || '').trim().toLowerCase();

// Map one fixture's "winner" group to our odds. Draw sports: 1X2 (3 outcomes), else
// double chance (regulation time, e.g. hockey where Stake has no 1X2). Others: 2-way winner.
function fixtureOdds(f, sportKey, home, away, link, now) {
  const odds = [];
  const draw = DRAW.has(sportKey);
  const push = (sel, price) => odds.push({ book: 'stake', market: 'h2h', point: null, sel, price, link, updated: now });
  let hasMain = false;
  for (const g of f.groups || []) {
    if (g.name !== 'winner') continue;
    for (const tp of g.templates || []) {
      const m = (tp.markets || []).find(x => x.status === 'active') || null;
      if (!m) continue;
      const outs = (m.outcomes || []);
      const ok = o => o && o.active && Number(o.odds) > 1;
      const name = String(tp.name || '');
      if (draw && /^(1x2|match result)/i.test(name) && outs.length === 3) {
        const h = norm(home), a = norm(away);
        const map = { 0: '1', 1: 'X', 2: '2' };
        for (let i = 0; i < 3; i++) {
          const o = outs[i]; const n = norm(o.name);
          const sel = n === 'draw' || n === 'x' ? 'X' : n === h ? '1' : n === a ? '2' : map[i];
          if (ok(o)) push(sel, Number(o.odds));
        }
        hasMain = true;
      } else if (draw && /^double chance/i.test(name) && outs.length === 3) {
        for (const o of outs) {
          const n = norm(o.name);
          const hasD = /\bdraw\b/.test(n);
          const hasH = n.includes(norm(home)), hasA = n.includes(norm(away));
          const sel = hasD && hasH ? '1X' : hasD && hasA ? 'X2' : hasH && hasA ? '12' : null;
          if (sel && ok(o)) push(sel, Number(o.odds));
        }
      } else if (!draw && /^(winner|match winner)/i.test(name) && outs.length === 2) {
        // Order is home, away; confirm by name when possible.
        const swapped = norm(outs[0].name) === norm(away) && norm(outs[1].name) === norm(home);
        const [o1, o2] = swapped ? [outs[1], outs[0]] : [outs[0], outs[1]];
        if (ok(o1)) push('1', Number(o1.odds));
        if (ok(o2)) push('2', Number(o2.odds));
        hasMain = true;
      }
    }
  }
  // Keep DC only when no full 1X2 exists (index.js drops DC next to a 3-way anyway).
  return hasMain || !draw ? odds.filter(o => !/^(1X|X2|12)$/.test(o.sel)) : odds;
}

function parse(tours, sportKey, sportSlug) {
  const out = [];
  const now = Date.now();
  for (const t of tours || []) {
    for (const f of t.fixtureList || []) {
      const d = f.data;
      if (!d || d.__typename !== 'SportFixtureDataMatch' || d.isOutright) continue;
      if (f.status !== 'active' && f.status !== 'live') continue;
      const teams = d.teams || [];
      const homeT = teams.find(x => x.qualifier === 'home') || (d.competitors || [])[0];
      const awayT = teams.find(x => x.qualifier === 'away') || (d.competitors || [])[1];
      if (!homeT || !awayT) continue;
      const home = String(homeT.name).trim(), away = String(awayT.name).trim();
      const link = `${ORIGIN}/sports/${sportSlug}/${t.category.slug}/${t.slug}/${f.slug}`;
      const odds = fixtureOdds(f, sportKey, home, away, link, now);
      if (!odds.length) continue;
      out.push({
        book: 'stake',
        sport: sportKey,
        league: `${t.category.name ? t.category.name + ' ' : ''}${t.name}`.trim(),
        home, away,
        start: Date.parse(d.startTime),
        live: f.status === 'live',
        link,
        odds,
      });
    }
  }
  return out;
}

// Esports = one Stake sport per game; list them once per call.
async function esportSlugs(page) {
  const j = await gql(page, '{ sportList(type:active,sportType:esport,limit:60){ slug } }', {});
  if (j.error || !j.data) throw new Error(j.error || 'esport list failed');
  return j.data.sportList.map(s => s.slug);
}

async function run(settings, sportKeys, types) {
  const port = (settings.bookmakers.stake || {}).port || 9309;
  const page = await stakePage(port);
  const pace = settings.stakePaceMs ?? 150;
  const events = [];
  for (const key of sportKeys) {
    if (!(key in SPORTS)) continue;
    const slugs = SPORTS[key] || await esportSlugs(page);
    // A few games at a time (esports = ~18 slugs), still modest on the API.
    for (let i = 0; i < slugs.length; i += 3) {
      const chunk = slugs.slice(i, i + 3);
      const res = await Promise.all(chunk.map(async slug => {
        const evs = [];
        for (const type of types) {
          const { tours } = await fetchSport(page, slug, type);
          evs.push(...parse(tours, key, slug));
          await sleep(pace);
        }
        return evs;
      }));
      for (const r of res) events.push(...r);
    }
  }
  // A fixture can show in both upcoming and live; keep one (live wins).
  const byLink = new Map();
  for (const e of events) { const o = byLink.get(e.link); if (!o || (e.live && !o.live)) byLink.set(e.link, e); }
  return [...byLink.values()];
}

async function collect(settings, sportKeys) {
  return run(settings, sportKeys, ['upcoming', 'live']);
}

// Live only (fast loop): same query with type=live, so much smaller than collect().
async function collectLive(settings, sportKeys) {
  return (await run(settings, sportKeys, ['live'])).filter(e => e.live);
}

module.exports = { SPORTS, collect, collectLive, parse };
