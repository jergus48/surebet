// Odds-API.io v3 collector (https://docs.odds-api.io, checked 2026-11).
//   GET /v3/events?apiKey&sport&status=pending&from&to&limit   -> [{ id, home, away, date, status, sport, league }]
//   GET /v3/odds/multi?apiKey&eventIds(<=10)&bookmakers(<=30)&markets -> [{ ..., urls{book}, bookmakers{book:[{name, odds:[...]}]} }]
//   Markets: ML {home,draw?,away}, Totals {hdp,over,under}. Prices are strings.
//   Limits: paid 5000 req/h; rate headers x-ratelimit-remaining / x-ratelimit-reset.
//   Your account's "selected bookmakers" decide what odds you get (plan caps 2/5/10/15).
// Returns one event list per bookmaker, same shape as the browser collectors.
const BASE = 'https://api.odds-api.io/v3';
const SLUG = { football: 'football', tennis: 'tennis', hockey: 'ice-hockey', basketball: 'basketball', tabletennis: 'table-tennis', esports: 'esports', volleyball: 'volleyball', handball: 'handball' };
const TOTALS_SPORTS = new Set(['football']); // tennis/others "Totals" can mean games/sets; skip

let rate = { remaining: null, reset: null, requests: 0 };

async function get(path, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${BASE}${path}?${q}`);
  rate.requests++;
  if (r.headers.get('x-ratelimit-remaining') != null) {
    rate.remaining = Number(r.headers.get('x-ratelimit-remaining'));
    rate.reset = r.headers.get('x-ratelimit-reset');
  }
  if (!r.ok) throw new Error(`odds-api.io ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function parseEvent(ev, sportKey, nameToKey) {
  const perBook = {};
  const start = Date.parse(ev.date);
  for (const [bookName, markets] of Object.entries(ev.bookmakers || {})) {
    const key = nameToKey[bookName];
    if (!key) continue;
    const link = (ev.urls && ev.urls[bookName] && ev.urls[bookName] !== 'N/A') ? ev.urls[bookName] : null;
    const odds = [];
    for (const m of markets || []) {
      for (const o of m.odds || []) {
        if (m.name === 'ML') {
          const sels = o.draw != null ? [['1', o.home], ['X', o.draw], ['2', o.away]] : [['1', o.home], ['2', o.away]];
          for (const [sel, p] of sels) if (Number(p) > 1) odds.push({ book: key, market: 'h2h', point: null, sel, price: Number(p), link, updated: Date.parse(m.updatedAt) || Date.now() });
        } else if (m.name === 'Totals' && TOTALS_SPORTS.has(sportKey) && o.hdp != null) {
          if (Number(o.over) > 1) odds.push({ book: key, market: 'totals', point: Number(o.hdp), sel: 'O', price: Number(o.over), link, updated: Date.now() });
          if (Number(o.under) > 1) odds.push({ book: key, market: 'totals', point: Number(o.hdp), sel: 'U', price: Number(o.under), link, updated: Date.now() });
        }
      }
    }
    if (odds.length) {
      perBook[key] = { book: key, sport: sportKey, league: ev.league?.name || null, home: ev.home, away: ev.away, start, live: ev.status === 'live', link, odds, src: 'api' };
    }
  }
  return perBook;
}

// books: our keys whose settings.bookmakers[k].source === 'api'
async function collect(settings, sportKeys, books) {
  if (!settings.oddsApiIoKey) throw new Error('odds-api.io: missing API key (Nastavenia)');
  const nameToKey = {};
  for (const k of books) nameToKey[settings.bookmakers[k].apiName || k] = k;
  const bookParam = Object.keys(nameToKey).join(',');
  const out = Object.fromEntries(books.map(k => [k, []]));
  const now = new Date();
  const to = new Date(now.getTime() + (settings.apiHoursAhead || 36) * 3600e3);
  for (const key of sportKeys) {
    if (!SLUG[key]) continue;
    const events = await get('/events', {
      apiKey: settings.oddsApiIoKey, sport: SLUG[key], status: 'pending',
      from: now.toISOString().replace(/\.\d+Z$/, 'Z'), to: to.toISOString().replace(/\.\d+Z$/, 'Z'), limit: '1000',
    });
    const ids = events.map(e => e.id).slice(0, settings.apiMaxEventsPerSport || 300);
    for (let i = 0; i < ids.length; i += 10) {
      const batch = await get('/odds/multi', { apiKey: settings.oddsApiIoKey, eventIds: ids.slice(i, i + 10).join(','), bookmakers: bookParam, markets: 'ML,Totals' });
      for (const ev of batch) {
        const per = parseEvent(ev, key, nameToKey);
        for (const [k, e] of Object.entries(per)) out[k].push(e);
      }
    }
  }
  return out;
}

module.exports = { collect, parseEvent, getRate: () => ({ ...rate }) };
