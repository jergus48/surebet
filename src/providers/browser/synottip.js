// Synot Tip collector. Calls the sportsbook's own offer API from INSIDE a
// sport.synottip.sk tab (same origin, site cookies), the same request the site
// makes when you open a sport in the left menu:
//   POST /WebServices/Api/SportsBettingService.svc/GetWebStandardEvents
//   {"LanguageID":17,"Token":<session token>,"CategoryID":"<sportId>",
//    "Top":N,"Skip":K,"IncludeLiveCategories":true}
// The response is {"Result":1,"ReturnValue":"<base64 protobuf>"}; the message
// layout (GetWebStandardEventsResponse -> FirstLevelCategory -> sport ->
// country -> league -> Event -> GameGroup -> Game -> Detail -> Odds) is taken
// from the protobuf.js classes in the site's app.min.js (2026-11).
// The Token is the one the page itself receives from GetLiveInitData on load;
// we only read it from the page's own traffic (reload the tab if we have none).
// Sport (CategoryID) ids from GetWebStandardCategories / the sport menu, 2026-11.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://sport.synottip.sk';
const API = '/WebServices/Api/SportsBettingService.svc';
const LANG = 17; // sk

const SPORTS = {
  football: '28',
  tennis: '2',
  hockey: '31',
  basketball: '5',
  tabletennis: '43',
  esports: '97', // umbrella category (Counter-Strike, LoL, Dota 2, ...)
  volleyball: '41',
  handball: '54',
};

// Optional GameIds filter per sport (market type ids from AvailableGames):
// 19 = "Zápas" 1/0/2, 20 = "Dvojtip" 10/12/02, 25 = "Celkový počet gólov" (Nad/Pod).
// Without GameIds the API returns only each event's main market (1/0/2 or
// "Víťaz zápasu" 1/2), which is what the 2-way sports use.
const { marketsOf, GAME_IDS } = require('./platformMarkets'); // market ids shared with Tipos

// ---- minimal protobuf reader -------------------------------------------------
// Schemas: fieldNo -> [name, type, repeated?, subSchema]
const S = {};
S.Timestamp = { 1: ['Value', 'int'] };
S.Odds = { 1: ['TipID', 'str'], 2: ['Name', 'str'], 3: ['Rate', 'float'], 6: ['State', 'int'] };
S.Detail = { 1: ['ID', 'int'], 2: ['Name', 'str'], 4: ['OddsList', 'msg', true, 'Odds'], 9: ['State', 'int'], 10: ['Suspended', 'bool'], 11: ['Info', 'str'] };
S.Game = { 1: ['ID', 'str'], 2: ['Name', 'str'], 6: ['Details', 'msg', true, 'Detail'], 13: ['Info', 'str'] };
S.GameGroup = { 1: ['ID', 'int'], 2: ['Name', 'str'], 3: ['Games', 'msg', true, 'Game'] };
S.Competitor = { 1: ['Id', 'int'], 2: ['Name', 'str'] };
S.Event = {
  1: ['Id', 'int'], 2: ['Name', 'str'], 4: ['Date', 'msg', false, 'Timestamp'], 6: ['GameGroups', 'msg', true, 'GameGroup'],
  7: ['CategoryId', 'str'], 9: ['Competitors', 'msg', true, 'Competitor'], 13: ['CategoryPath', 'str'], 14: ['IsLive', 'bool'],
};
S.CategoryBase = { 1: ['Id', 'str'], 2: ['Name', 'str'], 3: ['ParentId', 'str'], 5: ['Events', 'msg', true, 'Event'] };
S.FourthLevelCategory = { 1: ['Base', 'msg', false, 'CategoryBase'] };
S.ThirdLevelCategory = { 1: ['Base', 'msg', false, 'CategoryBase'], 2: ['Categories', 'msg', true, 'FourthLevelCategory'] };
S.SecondLevelCategory = { 1: ['Base', 'msg', false, 'CategoryBase'], 2: ['DisciplineId', 'int'], 4: ['Categories', 'msg', true, 'ThirdLevelCategory'], 5: ['IsVirtual', 'bool'] };
S.FirstLevelCategory = { 1: ['Categories', 'msg', true, 'SecondLevelCategory'] };
S.GameFilterItem = { 1: ['Id', 'int'], 2: ['Name', 'str'], 3: ['Visible', 'bool'] };
S.GetWebStandardEventsResponse = { 1: ['EventTree', 'msg', false, 'FirstLevelCategory'], 2: ['AvailableGames', 'msg', true, 'GameFilterItem'], 3: ['UnpaginatedEventCount', 'int'] };
S.GetWebStandardCategoriesResponse = { 1: ['Categories', 'msg', false, 'FirstLevelCategory'] };

function pbDecode(buf, schemaName, start = 0, end = buf.length) {
  const schema = S[schemaName];
  const out = {};
  let i = start;
  const varint = () => {
    let r = 0, mul = 1, b;
    do { b = buf[i++]; r += (b & 127) * mul; mul *= 128; } while (b & 128 && i < end);
    return r;
  };
  while (i < end) {
    const key = varint();
    const f = Math.floor(key / 8), w = key & 7;
    const spec = schema[f];
    let val;
    if (w === 0) {
      const v = varint();
      if (!spec) continue;
      val = spec[1] === 'bool' ? v !== 0 : (v > 2 ** 63 ? v - 2 ** 64 : v);
    } else if (w === 1) {
      if (spec) val = buf.readDoubleLE(i);
      i += 8; if (!spec) continue;
    } else if (w === 5) {
      if (spec) val = buf.readFloatLE(i);
      i += 4; if (!spec) continue;
    } else if (w === 2) {
      const len = varint();
      const s = i; i += len;
      if (!spec) continue;
      val = spec[1] === 'msg' ? pbDecode(buf, spec[3], s, s + len) : buf.toString('utf8', s, s + len);
    } else {
      throw new Error(`synottip: unsupported protobuf wire type ${w}`);
    }
    if (spec[2]) (out[spec[0]] = out[spec[0]] || []).push(val);
    else out[spec[0]] = val;
  }
  return out;
}

function decodeReturnValue(b64, schemaName) {
  return pbDecode(Buffer.from(b64, 'base64'), schemaName);
}

// ---- parse --------------------------------------------------------------------
// Odds names on the site: 1 / 0 (draw) / 2, double chance 10 / 02 / 12.
const H2H = { '1': '1', '0': 'X', '2': '2' };
const DC = { '10': '1X', '1X': '1X', '02': 'X2', 'X2': 'X2', '12': '12' };
const r2 = x => Math.round(x * 100) / 100; // Rate is float32 (2.19 -> 2.190000057)

function teams(ev) {
  const c = (ev.Competitors || []).map(x => x.Name).filter(Boolean);
  if (c.length === 2) return c;
  const parts = String(ev.Name || '').split(' - ');
  return parts.length === 2 && parts[0].trim() && parts[1].trim() ? parts : null;
}

function eventLink(ev) {
  return `${ORIGIN}/${ev.IsLive ? 'live-zapas' : 'zapas'}/${ev.Id}`;
}

// Classify a Game (market) by its name. Only full-time markets are taken.
// Seen names (2026-11): "Zápas" (1/0/2), "Víťaz zápasu" (1/2, tennis, volleyball,
// table tennis, esports), "Víťaz (vrátane predĺženia)" (1/2, basketball),
// "Dvojtip" (10/12/02), "Celkový počet gólov" (lines "Nad (2.5)"/"Pod (2.5)").
function marketOf(game) {
  const n = String(game.Name || '').trim().toLowerCase();
  if (n === 'zápas' || n === 'víťaz zápasu' || n === 'víťaz (vrátane predĺženia)') return 'h2h';
  if (n === 'dvojtip') return 'dc';
  if (n === 'celkový počet gólov') return 'totals';
  return null;
}

function oddsOf(game, link, now) {
  const kind = marketOf(game);
  if (!kind) return [];
  const out = [];
  for (const d of game.Details || []) {
    if (d.Suspended || (d.State && d.State !== 2)) continue;
    for (const o of d.OddsList || []) {
      // Odds.State enum: 0 None (omitted in protobuf), 1 Created, 2 Opened, 3 Suspended, 4 Closed
      if (o.State && o.State !== 2) continue;
      const price = r2(Number(o.Rate));
      if (!(price > 1)) continue;
      const name = String(o.Name || '').trim();
      if (kind === 'h2h' || kind === 'dc') {
        const sel = kind === 'h2h' ? H2H[name] : DC[name.toUpperCase()];
        if (!sel) continue;
        out.push({ book: 'synottip', market: 'h2h', point: null, sel, price, link, updated: now });
      } else {
        // Totals: tip names "Nad (2.5)" / "Pod (2.5)". The game also lists whole
        // and quarter lines (2, 2.25, 2.75: Asian, with push/half-push); only
        // half lines are kept so they compare 1:1 with other books' O/U.
        const m = name.match(/^(nad|pod)\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)$/i);
        const line = m ? Number(m[2].replace(',', '.')) : NaN;
        if (!m || !Number.isFinite(line) || line % 1 !== 0.5) continue;
        const sel = /^(nad|over|\+)$/i.test(m[1]) ? 'O' : 'U';
        out.push({ book: 'synottip', market: 'totals', point: line, sel, price, link, updated: now });
      }
    }
  }
  return out;
}

function collectEvents(base, path, acc) {
  if (!base) return;
  for (const ev of base.Events || []) acc.push({ ev, path });
}

// json: decoded GetWebStandardEventsResponse (object), or the raw API JSON
// {"Result":1,"ReturnValue":"<base64>"}.
function parse(json, sportKey) {
  const resp = json && typeof json.ReturnValue === 'string' ? decodeReturnValue(json.ReturnValue, 'GetWebStandardEventsResponse') : json;
  const now = Date.now();
  const out = [];
  const found = [];
  for (const sp of (resp && resp.EventTree && resp.EventTree.Categories) || []) {
    collectEvents(sp.Base, [], found);
    for (const c3 of sp.Categories || []) {
      const p3 = [c3.Base && c3.Base.Name].filter(Boolean);
      collectEvents(c3.Base, p3, found);
      for (const c4 of c3.Categories || []) collectEvents(c4.Base, [...p3, c4.Base && c4.Base.Name].filter(Boolean), found);
    }
  }
  const seen = new Set();
  for (const { ev, path } of found) {
    if (seen.has(ev.Id)) continue;
    seen.add(ev.Id);
    const t = teams(ev);
    if (!t) continue; // outrights, specials
    const link = eventLink(ev);
    // Every market the list carries (GameIds), mapped by the shared Tipos/Synottip mapper; the old
    // reader (1X2, double chance, totals) stays as the fallback when the mapper finds no main market.
    const games = [];
    for (const gg of ev.GameGroups || []) for (const g of gg.Games || []) {
      const rows = [];
      for (const d of g.Details || []) {
        if (d.Suspended || (d.State && d.State !== 2)) continue;
        const row = (d.OddsList || []).filter(o => !o.State || o.State === 2).map(o => ({ name: String(o.Name || '').trim(), price: Number(o.Rate) })).filter(o => o.price > 1);
        if (row.length) rows.push(row);
      }
      games.push({ name: g.Name, rows });
    }
    let odds = marketsOf(sportKey, t[0].trim(), t[1].trim(), games).map(o => ({ book: 'synottip', ...o, link, updated: now }));
    if (!odds.some(o => o.market === 'h2h')) {
      odds = [];
      for (const gg of ev.GameGroups || []) for (const g of gg.Games || []) odds.push(...oddsOf(g, link, now));
    }
    if (!odds.length) continue;
    out.push({
      book: 'synottip',
      sport: sportKey,
      league: ev.CategoryPath || (path.length ? path.join(' / ') : null),
      home: t[0].trim(),
      away: t[1].trim(),
      start: ev.Date && ev.Date.Value ? Number(ev.Date.Value) : null,
      live: !!ev.IsLive,
      link,
      odds,
    });
  }
  return out;
}

// ---- browser side ---------------------------------------------------------------
const tokens = new Map(); // port -> token the page itself obtained

async function synottipPage(port) {
  await chrome.launch(port, 'synottip', ORIGIN + '/');
  const page = await chrome.bookPage(port, /sport\.synottip\.sk/);
  return page;
}

// Reload the sport tab and read the session Token from the page's own
// GetLiveInitData response (the site gets it on every load).
// The slow scan and the live loop can both need a token at once: share one reload.
const refreshing = new Map();
function refreshToken(page, port) {
  if (!refreshing.has(port)) refreshing.set(port, doRefresh(page, port).finally(() => refreshing.delete(port)));
  return refreshing.get(port);
}

async function doRefresh(page, port) {
  let resolve;
  const got = new Promise(r => { resolve = r; });
  const onResp = async r => {
    if (!/\/GetLiveInitData$/.test(r.url())) return;
    try { const j = await r.json(); if (j && j.Result === 1 && j.Token) resolve(j.Token); } catch { }
  };
  page.on('response', onResp);
  try {
    // An error page (/Error/500) or a single match (that may have ended) never brings a token back:
    // reload the sport homepage instead.
    const u = page.url();
    const url = /sport\.synottip\.sk/.test(u) && !/\/Error\/|live-zapas|\/zapas\//i.test(u) ? u : ORIGIN + '/';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const token = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 30000))]);
    if (!token) throw new Error('synottip: page did not receive a session token (GetLiveInitData)');
    tokens.set(port, token);
    return token;
  } finally {
    page.off('response', onResp);
  }
}

async function fetchPage(page, token, categoryId, gameIds, top, skip) {
  return page.evaluate(async (api, lang, token, id, gameIds, top, skip) => {
    const r = await fetch(`${api}/GetWebStandardEvents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ LanguageID: lang, Token: token, CategoryID: id, GameIds: gameIds || undefined, Top: top, Skip: skip, IncludeLiveCategories: true }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return r.json();
  }, API, LANG, token, categoryId, gameIds, top, skip);
}

async function fetchSport(page, port, categoryId, gameIds, opts) {
  const top = opts.top, maxPages = opts.maxPages;
  const merged = { EventTree: { Categories: [] }, UnpaginatedEventCount: 0 };
  let skip = 0;
  for (let p = 0; p < maxPages; p++) {
    let token = tokens.get(port) || await refreshToken(page, port);
    let json = await fetchPage(page, token, categoryId, gameIds, top, skip);
    if (json && !json.error && json.Result !== 1) { // token rejected/expired: get a fresh one once
      token = await refreshToken(page, port);
      json = await fetchPage(page, token, categoryId, gameIds, top, skip);
    }
    if (json.error) throw new Error(json.error);
    if (json.Result !== 1 || typeof json.ReturnValue !== 'string') throw new Error(`API Result ${json.Result}`);
    const resp = decodeReturnValue(json.ReturnValue, 'GetWebStandardEventsResponse');
    const cats = (resp.EventTree && resp.EventTree.Categories) || [];
    merged.EventTree.Categories.push(...cats);
    merged.UnpaginatedEventCount = resp.UnpaginatedEventCount || 0;
    let n = 0;
    for (const sp of cats) for (const c3 of sp.Categories || []) {
      n += ((c3.Base && c3.Base.Events) || []).length;
      for (const c4 of c3.Categories || []) n += ((c4.Base && c4.Base.Events) || []).length;
    }
    skip += n;
    if (n < top || skip >= merged.UnpaginatedEventCount) break;
    await new Promise(r => setTimeout(r, 400));
  }
  return merged;
}

async function collect(settings, sportKeys) {
  const cfg = settings.bookmakers.synottip;
  const port = cfg.port;
  const page = await synottipPage(port);
  if (!/sport\.synottip\.sk/.test(page.url())) await refreshToken(page, port);
  const opts = { top: cfg.pageSize || 500, maxPages: cfg.maxPages || 6 };
  const events = [];
  for (const key of sportKeys) {
    const id = SPORTS[key];
    if (!id) continue;
    let resp;
    try { resp = await fetchSport(page, port, id, GAME_IDS[key], opts); } catch (e) { throw new Error(`synottip ${key}: ${e.message}`); }
    events.push(...parse(resp, key));
    await new Promise(r => setTimeout(r, 300));
  }
  return events;
}

// Live only (fast loop). Synottip runs the same betting platform as Tipos
// (same service paths and sport ids), so its live call GetLIPEvtsDsk returns the
// same JSON and is parsed with Tipos' parseLive.
async function collectLive(settings, sportKeys) {
  const port = settings.bookmakers.synottip.port;
  const page = await synottipPage(port);
  const call = token => page.evaluate(async (api, lang, token) => {
    const r = await fetch(`${api}/GetLIPEvtsDsk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ ActualEvents: true, LanguageID: lang, Token: token, UseLongPolling: false, TimeStamp: 0 }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    try { return await r.json(); } catch { return { error: 'non-JSON response' }; }
  }, API, LANG, token);
  let j = await call(tokens.get(port) || await refreshToken(page, port));
  if (!j.error && j.Result !== 1) j = await call(await refreshToken(page, port));
  if (j.error) throw new Error(`synottip live: ${j.error}`);
  return require('./tipos').parseLive(j, sportKeys, 'synottip', id => `${ORIGIN}/live-zapas/${id}`);
}

module.exports = { SPORTS, collect, collectLive, parse, decodeReturnValue, pbDecode };
