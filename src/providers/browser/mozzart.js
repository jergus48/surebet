// Mozzart North Macedonia (mozzartbet.mk) pre-match collector. Public odds, no login.
// Same-origin calls from a mozzartbet.mk tab (the site is a hash-routed SPA; its own XHRs are
// replayed exactly as the UI sends them, verified 2026-11-06):
//   POST /betOffer2  {"date":"all","sportIds":[<id>],"competitionIds":[],"sort":"bycompetition","specials":false,
//        "subgames":[],"size":300,"mostPlayed":false,"type":"betting","numberOfGames":1,
//        "activeCompleteOffer":false,"lang":"mk","offset":<n>}
//      -> { matches:[{ id, startTime(ms), competition_name_mk, participants:[{name}x2] }], total }   (no odds)
//   POST /getBettingOdds {"matchIds":[<=50 ids>],"subgames":[<subGame ids>]}   (51+ ids returns [])
//      -> [{ id, kodds:{ "<subGameId>": { value:"1.70", winStatus:"ACTIVE", subGame:{gameId,gameName,subGameName} } } }]
// Headers: Content-Type application/json;charset=utf-8, Accept application/json, X-Requested-With XMLHttpRequest.
// Sport ids seen: 1 football, 2 basketball, 4 hockey, 5 tennis, 6 volleyball, 7 handball (only 1 and 5 are used).
// Main market = game "Конечен тип" (sub games 1 / X / 2; tennis and basketball 1 / 2). Football also asks for
// subgame ids 1001003002 / 1001003004 = "Вкупно голови" 0-2 / 3+ = Under / Over 2.5 (the UI's own list).
// Names are Latin-script ("Everton", "Van Assche L."): no transliteration needed.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.mozzartbet.mk';
// Only verified sports. Basketball (2) offers only a 3-way regulation 1X2 with a ~15 price draw; hockey (4),
// volleyball (6), handball (7) return no odds without the UI's per-sport subgame ids (not investigated).
const SPORTS = { football: 1, tennis: 5 };
const DRAW = new Set(['football']);
const MAIN_NAME = 'Конечен тип';
const FOOTBALL_SUBGAMES = [1001001001, 1001001002, 1001001003, 1001003002, 1001003004];
const OFFER_PAGE = 300;
const ODDS_PAGE = 50; // API limit per getBettingOdds call

async function mozzartPage(port) {
  await chrome.launch(port, 'mozzart', ORIGIN + '/mk');
  const page = await chrome.bookPage(port, /mozzartbet[.]mk/);
  if (!/mozzartbet[.]mk/.test(page.url())) await page.goto(ORIGIN + '/mk', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

// Whole sport (offer pages + odds batches) in one in-page call.
async function fetchSport(page, sportId, subgames) {
  return page.evaluate(async (sportId, subgames, OFFER_PAGE, ODDS_PAGE) => {
    const H = { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' };
    const post = async (u, body) => {
      const r = await fetch(u, { method: 'POST', headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${u} HTTP ${r.status}`);
      return r.json();
    };
    try {
      const matches = [];
      let total = Infinity;
      for (let offset = 0; offset < total && offset < 3000; offset += OFFER_PAGE) {
        const j = await post('/betOffer2', {
          date: 'all', sportIds: [sportId], competitionIds: [], sort: 'bycompetition', specials: false, subgames: [],
          size: OFFER_PAGE, mostPlayed: false, type: 'betting', numberOfGames: 1, activeCompleteOffer: false, lang: 'mk', offset,
        });
        total = j.total || 0;
        const list = j.matches || [];
        for (const m of list) matches.push({ id: m.id, t: m.startTime, league: m.competition_name_mk, p: (m.participants || []).map(p => p.name), special: m.specialType });
        if (list.length < OFFER_PAGE) break;
      }
      const odds = {};
      for (let i = 0; i < matches.length; i += ODDS_PAGE) {
        const ids = matches.slice(i, i + ODDS_PAGE).map(m => m.id);
        const body = { matchIds: ids };
        if (subgames) body.subgames = subgames;
        const arr = await post('/getBettingOdds', body);
        for (const m of arr || []) {
          const rows = [];
          for (const k of Object.values(m.kodds || {})) {
            if (!k || !k.subGame || k.winStatus !== 'ACTIVE') continue;
            rows.push([k.subGame.gameName, k.subGame.gameId, k.subGame.subGameName, k.specialOddValue, Number(k.value)]);
          }
          odds[m.id] = rows;
        }
      }
      return { matches, odds };
    } catch (e) { return { error: String(e.message || e) }; }
  }, sportId, subgames, OFFER_PAGE, ODDS_PAGE);
}

function parse(res, sportKey) {
  const out = [];
  const now = Date.now();
  const draw = DRAW.has(sportKey);
  for (const m of res.matches || []) {
    if (m.p.length !== 2 || !(m.t > now)) continue; // outrights, specials, already started
    const link = `${ORIGIN}/mk#/betting`;
    const odds = [];
    const push = (market, point, sel, price) => { if (price > 1) odds.push({ book: 'mozzart', market, point, sel, price, link, updated: now }); };
    const main = {};
    for (const [gameName, gameId, sub, , value] of res.odds[m.id] || []) {
      if (gameName === MAIN_NAME && /^(1|X|2)$/.test(sub)) main[sub] = value;
      else if (sportKey === 'football' && gameId === 3 && sub === '0-2') push('totals', 2.5, 'U', value);
      else if (sportKey === 'football' && gameId === 3 && sub === '3+') push('totals', 2.5, 'O', value);
    }
    if (draw ? (main['1'] && main.X && main['2']) : (main['1'] && main['2'] && !main.X)) {
      push('h2h', null, '1', main['1']);
      if (draw) push('h2h', null, 'X', main.X);
      push('h2h', null, '2', main['2']);
    }
    if (!odds.length) continue;
    out.push({
      book: 'mozzart', sport: sportKey, league: m.league || null,
      home: String(m.p[0]).trim(), away: String(m.p[1]).trim(),
      start: m.t, live: false, link, odds,
    });
  }
  return out;
}

async function collect(settings, sportKeys) {
  const cfg = settings.bookmakers.mozzart || {};
  const page = await mozzartPage(cfg.port || 9331);
  const events = [];
  for (const key of sportKeys) {
    if (!SPORTS[key]) continue;
    const res = await fetchSport(page, SPORTS[key], key === 'football' ? FOOTBALL_SUBGAMES : null);
    if (res.error) throw new Error(`mozzart ${key}: ${res.error}`);
    events.push(...parse(res, key));
  }
  return events;
}

// Pre-match only: live odds were not investigated, so no collectLive.
module.exports = { SPORTS, collect, parse };
