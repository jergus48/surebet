// DOXXbet collector. Calls DOXXbet's own offer API from INSIDE a doxxbet.sk tab
// (same origin, site cookies), the same request the site makes when you open a
// sport page (e.g. /sk/sportove-tipovanie-online/kurzy/tenis) and scroll it:
//   POST /offer/GetOfferList
//   {"sportEvent":-1,"sport":<SportID>,"region":-1,"leaugeCup":-1,"live":-1,
//    "date":-1,"top":-1,"streamOnly":-1}
// "top":1 returns only the first 50 events (initial page render); "top":-1 is
// what the page sends after scrolling and returns the whole sport, prematch + live.
// Response: { EventChanceTypes: [one row per event, main market only],
//             Odds: { "<EventChanceTypeID>_<TipType>": {OddsRate, Status, TipType} },
//             Labels: { "SP_<id>"|"RE_<id>"|"LC_<id>": {Name} }, ... }
// Main market: ChanceTypeID "uf:1" (TRIO: 1 X 2 1X 12 X2) or "uf:186" (DUO: 1 2).
// Sport ids from /offer/GetWholeMenu (Typ "SP"), 2026-11.
const chrome = require('../../bettor/chrome');

const ORIGIN = 'https://www.doxxbet.sk';
const SPORTS = {
  football: 54,    // Futbal
  hockey: 53,      // Ľadový hokej
  tennis: 58,      // Tenis
  basketball: 50,  // Basketbal
  tabletennis: 82, // Stolný tenis
  esports: 178,    // E-Sport
  handball: 52,    // Hádzaná
  volleyball: 55,  // Volejbal
};
const MAIN_MARKETS = new Set(['uf:1', 'uf:186']);
const SEL = { '1': '1', 'X': 'X', '2': '2', '1X': '1X', 'X2': 'X2', '12': '12' };
const TZ = 'Europe/Bratislava'; // EventDate is site-local time without offset

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd').replace(/[øØ]/g, 'o').replace(/ß/g, 'ss')
    .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
  // site drops punctuation without a dash: "Perez, Pablo/Wright, M" -> "perez-pablowright-m"
}

// "2026-11-06T21:00:00.0000000" in Europe/Bratislava -> ms epoch
function localToEpoch(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(s || '');
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const offset = (t) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = asUtc - offset(asUtc);
  t = asUtc - offset(t); // second pass handles DST edges
  return t;
}

async function doxxbetPage(port) {
  await chrome.launch(port, 'doxxbet', ORIGIN + '/sk');
  const page = await chrome.bookPage(port, /doxxbet\.sk/);
  if (!/doxxbet\.sk/.test(page.url())) await page.goto(ORIGIN + '/sk', { waitUntil: 'domcontentloaded', timeout: 45000 });
  return page;
}

async function fetchSport(page, sportId) {
  return page.evaluate(async (sport) => {
    const r = await fetch('/offer/GetOfferList', {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8', accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ sportEvent: -1, sport, region: -1, leaugeCup: -1, live: -1, date: -1, top: -1, streamOnly: -1 }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    try { return await r.json(); } catch { return { error: 'non-JSON response' }; }
  }, sportId);
}

// Pure: GetOfferList JSON -> events. sportKey is our key (e.g. 'football').
function parse(json, sportKey) {
  const out = [];
  const labels = json.Labels || {};
  const oddsMap = json.Odds || {};
  const name = (typ, id) => (labels[`${typ}_${id}`] || {}).Name || null;
  const seen = new Set();
  for (const ev of json.EventChanceTypes || []) {
    if (ev.EventType !== 'default' || !MAIN_MARKETS.has(ev.ChanceTypeID)) continue; // outrights/specials
    if (ev.EventChanceTypeStatus !== 'active') continue;
    const key = ev.EventChanceTypeID;
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = String(ev.EventName || '').split(' vs. ');
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) continue;
    const [home, away] = parts.map(s => s.trim());
    const sportName = name('SP', ev.SportID);
    const region = name('RE', ev.RegionID);
    const leagueName = name('LC', ev.LeagueCupID);
    const link = sportName && region && leagueName
      ? `${ORIGIN}/sk/sportove-tipovanie-online/kurzy/${slug(sportName)}/${slug(region)}/${slug(leagueName)}?event=${ev.EventID}&name=${slug(ev.EventName)}`
      : null;
    const odds = [];
    for (const tip of Object.keys(SEL)) {
      const o = oddsMap[`${key}_${tip}`];
      if (!o || o.Status !== 'active') continue;
      const price = Number(o.OddsRate);
      if (!(price > 1)) continue;
      odds.push({ book: 'doxxbet', market: 'h2h', point: null, sel: SEL[tip], price, link, updated: Date.now() });
    }
    if (!odds.length) continue;
    out.push({
      book: 'doxxbet',
      sport: sportKey,
      league: region && leagueName ? `${region} - ${leagueName}` : (leagueName || null),
      home,
      away,
      start: localToEpoch(ev.EventDate),
      live: ev.LiveBetting === 'Y',
      link,
      odds,
    });
  }
  return out;
}

async function collect(settings, sportKeys) {
  const port = settings.bookmakers.doxxbet.port;
  const page = await doxxbetPage(port);
  const events = [];
  let first = true;
  for (const key of sportKeys) {
    const id = SPORTS[key];
    if (!id) continue;
    if (!first) await new Promise(r => setTimeout(r, 400));
    first = false;
    const json = await fetchSport(page, id);
    if (json.error) throw new Error(`doxxbet ${key}: ${json.error}`);
    events.push(...parse(json, key));
  }
  return events;
}

// Live only (fast loop): same whole-sport call, keep in-play matches.
async function collectLive(settings, sportKeys) {
  return (await collect(settings, sportKeys)).filter(e => e.live);
}

module.exports = { collect, collectLive, parse, SPORTS, localToEpoch };
