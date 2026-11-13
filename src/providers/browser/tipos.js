// TIPOS (tipkurz.etipos.sk) collector. Calls the site's own API from INSIDE a
// tipkurz.etipos.sk tab (same origin, site cookies), the same requests the page
// makes when you click a sport in the left tree (/zapasy/<id>?categoryId=<id>):
//   1) session token (the page sends this on load; no login, no captcha value):
//      POST /WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData
//      {"Version":"SK-I","LanguageID":17,"AppType":1,"CanGetRightBanner":false,"RecaptchaResponse":null}
//      -> { Result: 1, Token: "<hex>" }
//   2) prematch per sport (page sends Top:50; a bigger Top returns the whole sport):
//      POST /WebServices/Api/SportsBettingService.svc/GetWebStandardEvents
//      {"LanguageID":17,"Token":<t>,"CategoryID":"<sportId>","Top":5000,"IncludeLiveCategories":true}
//      -> { Result: 1, ReturnValue: "<base64 protobuf>" }  (prematch only, main market only)
//   3) live, all sports in one call (the page long-polls it; TimeStamp 0 = full snapshot):
//      POST /WebServices/Api/SportsBettingService.svc/GetLIPEvtsDsk
//      {"ActualEvents":true,"LanguageID":17,"Token":<t>,"UseLongPolling":false,"TimeStamp":0}
//      -> { Result: 1, ReturnValue: [{ DisciplineID, Events: [...] }] }  (JSON)
// Both need header accept: application/json (otherwise the service answers XML).
//
// Prematch protobuf layout (field numbers read from captured responses, 2026-11):
//   root.1 -> sport { 1 header{1 id, 2 name}, 4 region* }
//   region { 1 header{1 id, 2 name, 3 parentId}, 2 wrap* { 1 league{1 id, 2 name, 3 parentId, 5 event*} } }
//   event  { 1 id(varint), 2 "Home - Away", 3 tv, 4 {1 startMs}, 5 externalId, 6 group*, 7 leagueId }
//   group  { 1 id, 2 name ("Hlavné stávky"), 3 game* }
//   game   { 1 id, 2 name ("Zápas" | "Víťaz zápasu" | "Víťaz (vrátane predĺženia)"), 6 detail*, 11 state, 12 }
//   detail { 1 id, 2 name, 3 line, 4 odd* }      odd { 1 tipId, 2 name ("1"|"X"|"2"), 3 rate(float32) }
// Sport ids from GetWebStandardCategories (same protobuf tree), 2026-11.
const chrome = require('../../bettor/chrome');
const DRAW = require('./sports');
const { marketsOf, GAME_IDS } = require('./platformMarkets');

const ORIGIN = 'https://tipkurz.etipos.sk';
const SPORTS = {
  football: 28,    // Futbal
  hockey: 31,      // Hokej
  tennis: 2,       // Tenis
  basketball: 5,   // Basketbal
  handball: 54,    // Hádzaná
  volleyball: 41,  // Volejbal
  tabletennis: 43, // Stolný tenis
  // esports: none. TIPOS only has "Elektronický futbal" (164), no CS/LoL/Dota.
};
const BY_ID = Object.fromEntries(Object.entries(SPORTS).map(([k, v]) => [v, k]));
const SEL = { '1': '1', 'X': 'X', '2': '2', '1X': '1X', 'X2': 'X2', '12': '12' };

// ---- minimal protobuf wire decoder (no schema) ----
function readVarint(b, p) {
  let r = 0, mul = 1, x;
  do { x = b[p++]; r += (x & 127) * mul; mul *= 128; } while (x & 128);
  return [r, p];
}
function pb(b) {
  const out = []; let p = 0;
  while (p < b.length) {
    let k; [k, p] = readVarint(b, p);
    const f = Math.floor(k / 8), t = k % 8;
    if (t === 0) { let v; [v, p] = readVarint(b, p); out.push({ f, t, v }); }
    else if (t === 1) { out.push({ f, t, v: b.readDoubleLE(p) }); p += 8; }
    else if (t === 2) { let l; [l, p] = readVarint(b, p); out.push({ f, t, v: b.subarray(p, p + l) }); p += l; }
    else if (t === 5) { out.push({ f, t, v: b.readFloatLE(p) }); p += 4; }
    else throw new Error(`protobuf wire type ${t}`);
  }
  return out;
}
const all = (m, f) => m.filter(x => x.f === f);
const one = (m, f) => m.find(x => x.f === f);
const str = (m, f) => { const x = one(m, f); return x && x.t === 2 ? x.v.toString('utf8') : null; };
const num = (m, f) => { const x = one(m, f); return x && x.t !== 2 ? x.v : null; };

function splitTeams(name) {
  const i = String(name || '').indexOf(' - ');
  if (i < 0) return null;
  const home = name.slice(0, i).trim(), away = name.slice(i + 3).trim();
  return home && away ? { home, away } : null;
}

// Pick the main-market odds that fit our model for this sport: draw sports take
// the 3-way game (has X), others the 2-way winner game (1/2 only).
// games: [{ name, odds: [{ name, price }] }]
function mainOdds(games, sportKey, link, book = 'tipos') {
  const draw = !!DRAW[sportKey]?.draw;
  const g = games.find(x => draw ? x.odds.some(o => o.name === 'X') : !x.odds.some(o => o.name === 'X'));
  if (!g) return [];
  const now = Date.now();
  return g.odds
    .filter(o => SEL[o.name] && Number.isFinite(o.price) && o.price > 1)
    .map(o => ({ book, market: 'h2h', point: null, sel: SEL[o.name], price: Math.round(o.price * 100) / 100, link, updated: now }));
}

// Prematch: GetWebStandardEvents JSON ({Result, ReturnValue: base64}) -> events.
function parse(json, sportKey) {
  if (!json || json.Result !== 1 || !json.ReturnValue) return [];
  const out = [];
  const root = pb(Buffer.from(json.ReturnValue, 'base64'));
  for (const wrap of all(root, 1)) {
    for (const sport of all(pb(wrap.v), 1)) {
      for (const reg of all(pb(sport.v), 4)) {
        const rm = pb(reg.v);
        const rh = one(rm, 1);
        const region = rh ? str(pb(rh.v), 2) : null;
        for (const lw of all(rm, 2)) {
          for (const lg of all(pb(lw.v), 1)) {
            const lm = pb(lg.v);
            const lname = str(lm, 2);
            const league = [region, lname].filter(Boolean).join(' / ') || null;
            for (const ev of all(lm, 5)) {
              const e = pb(ev.v);
              const id = num(e, 1);
              const teams = splitTeams(str(e, 2));
              const when = one(e, 4);
              if (!id || !teams || !when) continue;
              const start = num(pb(when.v), 1);
              const link = `${ORIGIN}/zapas/${id}`;
              const games = [];
              for (const grp of all(e, 6)) {
                for (const gm of all(pb(grp.v), 3)) {
                  const g = pb(gm.v);
                  const state = num(g, 11);
                  if (state != null && state !== 1 && state !== 2) continue; // 2 = open (main market), 1 = the extra markets (also bettable)
                  const odds = [];
                  const rows = []; // one row per detail: an over/under line keeps its own pair
                  for (const d of all(g, 6)) {
                    const row = [];
                    for (const o of all(pb(d.v), 4)) {
                      const om = pb(o.v);
                      const x = { name: str(om, 2), price: num(om, 3) };
                      odds.push(x);
                      if (Number.isFinite(x.price) && x.price > 1) row.push(x);
                    }
                    if (row.length) rows.push(row);
                  }
                  games.push({ name: str(g, 2), odds, rows });
                }
              }
              // All markets the list carries (GameIds), mapped like Synottip; the old main-market pick
              // stays as the fallback for sports the mapper does not know.
              const now = Date.now();
              let odds = marketsOf(sportKey, teams.home, teams.away, games).map(o => ({ book: 'tipos', ...o, link, updated: now }));
              if (!odds.some(o => o.market === 'h2h')) odds = [...mainOdds(games, sportKey, link), ...odds];
              if (!odds.length) continue;
              out.push({ book: 'tipos', sport: sportKey, league, home: teams.home, away: teams.away, start, live: false, link, odds, tiposId: id });
            }
          }
        }
      }
    }
  }
  return out;
}

// Live: GetLIPEvtsDsk JSON -> events for the requested sport keys.
// Odds/Details/Games State 2 = open; 3 = locked (Rate 0).
// Same platform/format is used by Synottip: pass book + link builder.
function parseLive(json, sportKeys, book = 'tipos', linkFor = id => `${ORIGIN}/live-zapas/${id}`) { // live match page (/zapas/ shows no live odds)
  if (!json || json.Result !== 1 || !Array.isArray(json.ReturnValue)) return [];
  const want = new Set(sportKeys);
  const out = [];
  for (const disc of json.ReturnValue) {
    const sportKey = BY_ID[disc.DisciplineID];
    if (!sportKey || !want.has(sportKey)) continue;
    for (const e of disc.Events || []) {
      const teams = splitTeams(e.Name);
      if (!e.ID || !teams || e.State !== 2) continue;
      const link = linkFor(e.ID);
      const games = [];
      for (const grp of e.GameGroups || []) for (const g of grp.Games || []) {
        if (g.State !== 2) continue;
        const odds = [];
        for (const d of g.Details || []) {
          if (d.State !== 2) continue;
          for (const o of d.OddsList || []) if (o.State === 2) odds.push({ name: o.Name, price: Number(o.Rate) });
        }
        games.push({ name: g.Name, odds });
      }
      const odds = mainOdds(games, sportKey, link, book);
      if (!odds.length) continue;
      const m = /\/Date\((\d+)/.exec(e.Date || '');
      out.push({
        book, sport: sportKey, league: e.CategoryPath || null,
        home: teams.home, away: teams.away, start: m ? Number(m[1]) : Date.parse(e.Date),
        live: true, link, odds, tiposId: e.ID,
      });
    }
  }
  return out;
}

async function tiposPage(port) {
  await chrome.launch(port, 'tipos', ORIGIN + '/');
  const page = await chrome.bookPage(port, /tipkurz\.etipos\.sk/);
  if (!/tipkurz\.etipos\.sk/.test(page.url())) await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// In-page POST to a same-origin JSON service.
function post(page, url, body) {
  return page.evaluate(async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    try { return await r.json(); } catch { return { error: 'non-JSON response' }; }
  }, url, body);
}

const tokens = new Map(); // port -> token
async function getToken(page, port, fresh) {
  if (!fresh && tokens.get(port)) return tokens.get(port);
  const j = await post(page, '/WebServices/ApiSession/SportsBettingSessionService.svc/GetLiveInitData',
    { Version: 'SK-I', LanguageID: 17, AppType: 1, CanGetRightBanner: false, RecaptchaResponse: null });
  if (j.error || j.Result !== 1 || !j.Token) throw new Error(`tipos token: ${j.error || 'Result ' + j.Result}`);
  tokens.set(port, j.Token);
  return j.Token;
}

// Calls a token-bearing service; refreshes the token once if the service rejects it.
async function call(page, port, url, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const Token = await getToken(page, port, attempt > 0);
    const j = await post(page, url, { ...body, Token });
    if (j.error) throw new Error(j.error);
    if (j.Result === 1) return j;
  }
  throw new Error('service returned Result != 1 after token refresh');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function collect(settings, sportKeys) {
  const port = settings.bookmakers.tipos.port;
  const top = settings.tiposTop || 5000;
  const keys = (sportKeys || []).map(k => (typeof k === 'string' ? k : k.key)).filter(k => SPORTS[k]);
  if (!keys.length) return [];
  const page = await tiposPage(port);
  const events = [];
  for (const key of keys) {
    const j = await call(page, port, '/WebServices/Api/SportsBettingService.svc/GetWebStandardEvents',
      { LanguageID: 17, CategoryID: String(SPORTS[key]), Top: top, IncludeLiveCategories: true, ...(GAME_IDS[key] ? { GameIds: GAME_IDS[key] } : {}) })
      .catch(e => { throw new Error(`tipos ${key}: ${e.message}`); });
    events.push(...parse(j, key));
    await sleep(400);
  }
  if (settings.tiposLive !== false) {
    const j = await call(page, port, '/WebServices/Api/SportsBettingService.svc/GetLIPEvtsDsk',
      { ActualEvents: true, LanguageID: 17, UseLongPolling: false, TimeStamp: 0 })
      .catch(e => { throw new Error(`tipos live: ${e.message}`); });
    const seen = new Set(events.map(e => e.tiposId));
    for (const e of parseLive(j, keys)) if (!seen.has(e.tiposId)) events.push(e);
  }
  return events;
}

// Live only (fast loop): one call for all sports.
async function collectLive(settings, sportKeys) {
  const port = settings.bookmakers.tipos.port;
  const page = await tiposPage(port);
  const j = await call(page, port, '/WebServices/Api/SportsBettingService.svc/GetLIPEvtsDsk',
    { ActualEvents: true, LanguageID: 17, UseLongPolling: false, TimeStamp: 0 });
  return parseLive(j, sportKeys);
}

module.exports = { collect, collectLive, parse, parseLive, SPORTS, pb };
