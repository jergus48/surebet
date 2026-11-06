// Settings live in data/settings.json and are editable from the Nastavenia tab.
// Secrets (API key, Telegram token, dashboard password) can also come from env
// vars so they never need to be written to disk on a server.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULTS = {
  // Dashboard
  host: '127.0.0.1', // this computer only. Use 0.0.0.0 (or env HOST) for phone access, and set a dashboardPassword
  port: 8080,
  dashboardPassword: '', // empty = first visit asks you to set one

  // Odds source: 'mock' (offline demo data) or 'oddsapi' (the-odds-api.com v4)
  provider: 'mock',
  oddsApiKey: '',
  oddsApiRegions: 'eu,uk',
  oddsApiBookmakers: '', // comma list of bookmaker keys; overrides regions when set
  oddsApiMarkets: 'h2h,totals',
  sports: [], // sport keys to scan (load list in Nastavenia). Empty = nothing for oddsapi.
  // 'browser' provider (hybrid): sports to scan, keys from src/providers/browser/sports.js
  scanSports: ['football', 'tennis'],
  tipsportLimit: 300,
  bet365WaitSec: 20,
  bet365Routes: {}, // extra/override bet365 routes per sport, e.g. { "football": ["#/AS/B1/", ...] }
  // Odds-API.io (used by bookmakers with source 'api', and by the compare tool)
  oddsApiIoKey: '',
  apiHoursAhead: 36,
  apiMaxEventsPerSport: 300,
  pollSeconds: 60,
  minCreditsLeft: 200, // scanner pauses itself below this many API credits

  // Surebet filter
  minProfitPct: 1.0,
  maxProfitPct: 25.0, // above this it is almost always a data error / palpable odds
  maxOddsAgeSec: 180, // ignore prices read longer ago than this (paced books reuse old reads)
  includeLive: true, // live loop on/off (separate fast loop, see below)
  liveSeconds: 15, // live poll interval
  liveMaxAgeSec: 20, // every live leg must have been read this recently
  liveConfirmPolls: 2, // a live surebet must survive this many polls in a row before it is reported
  liveMinProfitPct: 1.0,
  liveMaxProfitPct: 10.0, // live arbs above this are almost always errors / suspended markets
  stakeTiers: [{ minProfitPct: 2, stake: 10 }, { minProfitPct: 3.5, stake: 15 }, { minProfitPct: 5, stake: 20 }, { minProfitPct: 8, stake: 30 }], // total stake per surebet by profit; [] = flat bankrollPerBet
  bankrollPerBet: 100, // total stake split across legs, in your currency
  roundStakeTo: 1, // round each leg's stake to this step (bookies flag odd cents)

  // Alerts
  telegramBotToken: '',
  telegramChatId: '',

  // Bet execution through debug Chrome (see src/bettor)
  // off  = only scan + alert
  // fill = open both events, put stakes on the slips, YOU click Place
  // auto = place automatically within the limits below
  betMode: 'off',
  autoMinProfitPct: 2.0,
  autoMaxStakeTotal: 50,
  autoDailyMaxBets: 10,
  autoPrematchOnly: true,
  maxOddsDropPct: 0.0, // abort a leg if slip odds are lower than scanned odds by more than this
  bookmakers: {
    // port = its own debug Chrome. source = 'browser' (read its window) or 'api' (Odds-API.io).
    // apiName = the book's name on Odds-API.io (for source 'api' and the compare tool).
    tipsport: { name: 'Tipsport', port: 9301, enabled: false, source: 'browser', apiName: 'Tipsport.cz' },
    bet365: { name: 'Bet365', port: 9302, enabled: false, source: 'browser', apiName: 'Bet365' },
    // everySec: re-read this site at most this often (Fortuna ~245 requests/football scan,
    // Niké's Cloudflare challenges bursts of requests).
    fortuna: { name: 'Fortuna', port: 9303, enabled: false, source: 'browser', apiName: 'iFortuna CZ', everySec: 120 },
    nike: { name: 'Niké', port: 9304, enabled: false, source: 'browser', everySec: 120 },
    doxxbet: { name: 'DOXXbet', port: 9305, enabled: false, source: 'browser' },
    tipos: { name: 'Tipos', port: 9306, enabled: false, source: 'browser' },
    synottip: { name: 'Synottip', port: 9307, enabled: false, source: 'browser', apiName: 'Synottip' },
    chance: { name: 'Chance', port: 9308, enabled: false, source: 'browser' },
    olybet: { name: 'OlyBet', port: 9310, enabled: false, source: 'browser' },
    maxbet: { name: 'Maxbet MK', port: 9330, enabled: false, source: 'browser', everySec: 60 },
    mozzart: { name: 'Mozzart MK', port: 9331, enabled: false, source: 'browser', everySec: 30 },
    inbet: { name: 'Inbet', port: 9320, enabled: false, source: 'browser', everySec: 60 },
    stake: { name: 'Stake', port: 9309, enabled: false, source: 'browser', everySec: 60 },
  },
};

function envOverrides(s) {
  if (process.env.ODDS_API_KEY) s.oddsApiKey = process.env.ODDS_API_KEY;
  if (process.env.ODDS_API_IO_KEY) s.oddsApiIoKey = process.env.ODDS_API_IO_KEY;
  if (process.env.TELEGRAM_BOT_TOKEN) s.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) s.telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (process.env.DASHBOARD_PASSWORD) s.dashboardPassword = process.env.DASHBOARD_PASSWORD;
  if (process.env.PORT) s.port = Number(process.env.PORT);
  if (process.env.HOST) s.host = process.env.HOST;
  return s;
}

let cache = null;
function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')); } catch { }
  // Per-book merge so new default fields (source, apiName) reach saved books.
  const books = {};
  for (const k of new Set([...Object.keys(DEFAULTS.bookmakers), ...Object.keys(saved.bookmakers || {})])) {
    books[k] = { ...(DEFAULTS.bookmakers[k] || {}), ...((saved.bookmakers || {})[k] || {}) };
  }
  cache = envOverrides({ ...DEFAULTS, ...saved, bookmakers: books });
  return cache;
}
function save(patch) {
  const next = { ...load(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
// What the UI may see: secrets masked.
function publicView() {
  const s = { ...load() };
  for (const k of ['oddsApiKey', 'oddsApiIoKey', 'telegramBotToken', 'dashboardPassword']) s[k] = s[k] ? '********' : '';
  return s;
}

module.exports = { load, save, publicView, DATA_DIR };
