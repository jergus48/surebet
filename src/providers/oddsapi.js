// the-odds-api.com v4 provider.
// Docs: https://the-odds-api.com/liveapi/guides/v4/
//   GET /v4/sports                         (free, no credits)
//   GET /v4/sports/{sport}/odds?apiKey&regions|bookmakers&markets&oddsFormat=decimal
// Cost per odds call = markets x regions (bookmakers param: each 10 books = 1 region).
// Credits are reported in x-requests-remaining / x-requests-used / x-requests-last.
//
// Coverage note (checked 2026-11): Tipsport and Stake are NOT on this API, and
// bet365 is only bet365_au for AFL/NRL. For bet365 EU + Tipsport you need a
// different feed; add it as another file in this folder with the same exports.
const BASE = 'https://api.the-odds-api.com/v4';

let credits = { remaining: null, used: null, last: null };

async function getJson(url) {
  const r = await fetch(url);
  const h = r.headers;
  if (h.get('x-requests-remaining') != null) {
    credits = {
      remaining: Number(h.get('x-requests-remaining')),
      used: Number(h.get('x-requests-used')),
      last: Number(h.get('x-requests-last')),
    };
  }
  if (!r.ok) throw new Error(`odds-api ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function listSports(s) {
  if (!s.oddsApiKey) throw new Error('Missing odds API key');
  const list = await getJson(`${BASE}/sports/?apiKey=${encodeURIComponent(s.oddsApiKey)}`);
  return list.map(x => ({ key: x.key, group: x.group, title: x.title, active: x.active, hasOutrights: x.has_outrights }));
}

function selFor(market, outcome, ev) {
  if (market === 'h2h') {
    if (outcome.name === ev.home_team) return '1';
    if (outcome.name === ev.away_team) return '2';
    if (/^draw$/i.test(outcome.name)) return 'X';
    return null;
  }
  if (market === 'totals') {
    if (/^over$/i.test(outcome.name)) return 'O';
    if (/^under$/i.test(outcome.name)) return 'U';
    return null;
  }
  if (market === 'spreads') {
    if (outcome.name === ev.home_team) return 'H';
    if (outcome.name === ev.away_team) return 'A';
  }
  return null;
}

function normalize(raw) {
  const now = Date.now();
  return raw.map(ev => {
    const start = Date.parse(ev.commence_time);
    const odds = [];
    for (const bk of ev.bookmakers || []) {
      for (const m of bk.markets || []) {
        for (const o of m.outcomes || []) {
          const sel = selFor(m.key, o, ev);
          if (!sel) continue;
          // Spreads: store the HOME line so both sides land in one group.
          let point = o.point ?? null;
          if (m.key === 'spreads' && sel === 'A' && point != null) point = -point;
          odds.push({
            book: bk.key,
            market: m.key,
            point,
            sel,
            price: Number(o.price),
            // includeLinks=true adds deep links; field name varies by level, take whatever exists.
            link: o.link || m.link || bk.link || null,
            updated: Date.parse(m.last_update || bk.last_update) || null,
          });
        }
      }
    }
    return {
      id: ev.id,
      sport: ev.sport_key,
      sportTitle: ev.sport_title || ev.sport_key,
      league: ev.sport_title || ev.sport_key,
      home: ev.home_team,
      away: ev.away_team,
      start,
      live: start <= now,
      drawPossible: /^soccer_/.test(ev.sport_key),
      odds,
    };
  });
}

async function fetchEvents(s) {
  if (!s.oddsApiKey) throw new Error('Missing odds API key (Nastavenia)');
  if (!s.sports.length) throw new Error('No sports selected (Nastavenia)');
  const all = [];
  for (const sport of s.sports) {
    const q = new URLSearchParams({
      apiKey: s.oddsApiKey,
      markets: s.oddsApiMarkets,
      oddsFormat: 'decimal',
      includeLinks: 'true',
    });
    if (s.oddsApiBookmakers) q.set('bookmakers', s.oddsApiBookmakers);
    else q.set('regions', s.oddsApiRegions);
    const raw = await getJson(`${BASE}/sports/${encodeURIComponent(sport)}/odds/?${q}`);
    all.push(...normalize(raw));
    if (credits.remaining != null && credits.remaining < s.minCreditsLeft) {
      throw new Error(`Credits low (${credits.remaining}), pausing`);
    }
  }
  return all;
}

// Rough credits/hour so the UI can warn before you burn the plan.
function estimateCreditsPerHour(s) {
  const markets = s.oddsApiMarkets.split(',').filter(Boolean).length;
  const regions = s.oddsApiBookmakers
    ? Math.ceil(s.oddsApiBookmakers.split(',').filter(Boolean).length / 10)
    : s.oddsApiRegions.split(',').filter(Boolean).length;
  return Math.round(markets * regions * s.sports.length * (3600 / Math.max(5, s.pollSeconds)));
}

module.exports = { name: 'oddsapi', fetchEvents, listSports, estimateCreditsPerHour, getCredits: () => credits };
