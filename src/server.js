// Dashboard + JSON API. Plain node:http, no framework.
//   node src/server.js   ->  http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const scanner = require('./scanner');
const providers = require('./providers');
const bettor = require('./bettor');
const chrome = require('./bettor/chrome');
const sites = require('./bettor/sites');
const notify = require('./notify');
const analytics = require('./analytics');
const compare = require('./compare');
const { marketLabel } = require('./arb');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const sessions = new Set();

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function decorate(row) {
  const sb = JSON.parse(row.json || '{}');
  return { ...sb, firstSeen: row.first_seen, lastSeen: row.last_seen, seenCount: row.seen_count, maxProfit: row.max_profit, notified: !!row.notified, label: marketLabel(sb) };
}

function csv(rows) {
  const head = ['first_seen', 'sport', 'league', 'home', 'away', 'start', 'live', 'market', 'label', 'max_profit_pct', 'legs'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(r => {
    const d = decorate(r);
    return [new Date(r.first_seen).toISOString(), d.sportTitle, d.league, d.home, d.away, new Date(d.start).toISOString(), d.live, d.market, d.label, r.max_profit,
      d.legs.map(l => `${l.book} ${l.sel}@${l.price} x${l.stake}`).join('; ')].map(esc).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}

const SETTABLE = new Set(['provider', 'oddsApiKey', 'oddsApiRegions', 'oddsApiBookmakers', 'oddsApiMarkets', 'sports', 'pollSeconds', 'minCreditsLeft',
  'minProfitPct', 'maxProfitPct', 'maxOddsAgeSec', 'liveSeconds', 'liveMaxAgeSec', 'liveConfirmPolls', 'liveMinProfitPct', 'liveMaxProfitPct', 'includeLive', 'bankrollPerBet', 'stakeTiers', 'roundStakeTo', 'telegramBotToken', 'telegramChatId',
  'scanSports', 'tipsportLimit', 'bet365WaitSec', 'bet365Routes', 'oddsApiIoKey', 'apiHoursAhead', 'apiMaxEventsPerSport',
  'betMode', 'autoMinProfitPct', 'autoMaxStakeTotal', 'autoDailyMaxBets', 'autoPrematchOnly', 'maxOddsDropPct', 'bookmakers', 'dashboardPassword']);

async function api(req, res, url) {
  const p = url.pathname;
  const s = config.load();

  if (p === '/api/login' && req.method === 'POST') {
    const { password } = await readBody(req);
    if (!s.dashboardPassword) return send(res, 200, { ok: true }); // login is off
    if (!safeEq(password || '', s.dashboardPassword)) {
      return send(res, 401, { error: 'Wrong password' });
    }
    const tok = crypto.randomBytes(24).toString('hex');
    sessions.add(tok);
    res.setHeader('set-cookie', `sb=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return send(res, 200, { ok: true });
  }
  // No dashboardPassword = no login (the dashboard only listens on localhost by default).
  if (p === '/api/session') return send(res, 200, { loggedIn: !s.dashboardPassword || sessions.has(cookie(req, 'sb')), needsSetup: false, authOn: !!s.dashboardPassword });
  if (s.dashboardPassword && !sessions.has(cookie(req, 'sb'))) return send(res, 401, { error: 'login' });

  if (p === '/api/logout' && req.method === 'POST') { sessions.delete(cookie(req, 'sb')); return send(res, 200, { ok: true }); }

  if (p === '/api/status') {
    const prov = providers.get(s.provider);
    const books = {};
    for (const [k, b] of Object.entries(s.bookmakers)) {
      books[k] = { ...b, chromeUp: await chrome.isUp(b.port), calibrated: sites.calibrated(sites.load()[k] || {}), launchCommand: chrome.launchCommand(b.port, k) };
    }
    return send(res, 200, {
      running: scanner.state.running, lastRun: scanner.state.lastRun, lastError: scanner.state.lastError,
      lastEvents: scanner.state.lastEvents, activeCount: scanner.state.active.length + scanner.state.live.active.length,
      live: { ...scanner.state.live, active: scanner.state.live.active.length },
      provider: s.provider, credits: prov.getCredits(), creditsPerHour: prov.estimateCreditsPerHour(s),
      betMode: s.betMode, autoBetsToday: db.autoBetsToday(), books,
    });
  }
  if (p === '/api/surebets') return send(res, 200, [...scanner.state.live.active, ...scanner.state.active].map(sb => ({ ...sb, label: marketLabel(sb) })));
  if (p === '/api/history') return send(res, 200, db.history(Number(url.searchParams.get('n')) || 300).map(decorate));
  if (p === '/api/stats') return send(res, 200, db.stats());
  if (p === '/api/analytics') return send(res, 200, analytics.report(Object.entries(s.bookmakers).filter(([, b]) => b.enabled).map(([k]) => k)));
  if (p === '/api/log') return send(res, 200, db.logTail(Number(url.searchParams.get('n')) || 300));
  if (p === '/api/bets') return send(res, 200, db.bets());
  if (p === '/api/export.csv') {
    res.setHeader('content-disposition', 'attachment; filename="surebets.csv"');
    return send(res, 200, csv(db.history(100000)), 'text/csv');
  }

  if (p === '/api/scanner/start' && req.method === 'POST') { scanner.start(); return send(res, 200, { ok: true }); }
  if (p === '/api/scanner/stop' && req.method === 'POST') { scanner.stop(); return send(res, 200, { ok: true }); }
  if (p === '/api/scanner/poll' && req.method === 'POST') { await scanner.pollOnce(); return send(res, 200, { ok: true }); }

  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, { ...config.publicView(), providers: providers.names });
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!SETTABLE.has(k)) continue;
      if (v === '********') continue; // masked secret left unchanged
      patch[k] = v;
    }
    if (patch.dashboardPassword !== undefined && String(patch.dashboardPassword).length < 8) delete patch.dashboardPassword;
    if (patch.betMode && !['off', 'fill', 'auto'].includes(patch.betMode)) delete patch.betMode;
    config.save(patch);
    db.log('info', `settings changed: ${Object.keys(patch).join(', ')}`);
    return send(res, 200, config.publicView());
  }
  if (p === '/api/sports') {
    try { return send(res, 200, await providers.get(s.provider).listSports(s)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/telegram/chatid' && req.method === 'POST') {
    try {
      const r = await notify.findChatId(s);
      config.save({ telegramChatId: r.chatId });
      db.log('info', `telegram chat id set (${r.name})`);
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === '/api/telegram/test' && req.method === 'POST') {
    try {
      const me = await notify.whoAmI(s); // validates the token first
      if (!s.telegramChatId) return send(res, 400, { error: `Token OK (@${me.username}). Now send your bot "hi" in Telegram and click "Find chat ID".` });
      const ok = await notify.send(s, notify.format(notify.sample(), { test: true }), { html: true });
      return send(res, 200, { ok, bot: me.username });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // Browser vs Odds-API.io for one bookmaker (costs API requests).
  if (p === '/api/compare' && req.method === 'POST') {
    const { book, sports } = await readBody(req);
    try {
      const r = await compare.compareBook(s, book, sports && sports.length ? sports : (s.scanSports || ['football']));
      db.log('info', `compare ${book}: ${JSON.stringify(r)}`);
      return send(res, 200, r);
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  // Open one bookmaker's own debug Chrome (to log in once by hand).
  let m = p.match(/^\/api\/chrome\/([\w-]+)\/launch$/);
  if (m && req.method === 'POST') {
    const b = s.bookmakers[m[1]];
    if (!b) return send(res, 404, { error: 'unknown bookmaker' });
    try { await chrome.launch(b.port, m[1], (sites.load()[m[1]] || {}).home); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  // Open / place a surebet's legs, each in its own bookmaker window.
  m = p.match(/^\/api\/bet$/);
  if (m && req.method === 'POST') {
    const { key, mode } = await readBody(req);
    const sb = scanner.state.active.find(x => x.key === key) || (db.byKey(key) && JSON.parse(db.byKey(key).json));
    if (!sb) return send(res, 404, { error: 'surebet not found' });
    const r = await bettor.execute(s, sb, { mode: mode === 'auto' ? 'auto' : 'fill', manual: true });
    return send(res, 200, r);
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html');
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    db.log('error', `http ${url.pathname}: ${e.message}`);
    send(res, 500, { error: e.message });
  }
});

const s = config.load();
server.listen(s.port, s.host, () => {
  db.log('info', `dashboard on http://${s.host === '0.0.0.0' ? 'localhost' : s.host}:${s.port} (provider: ${s.provider}, betMode: ${s.betMode})`);
  if (process.env.AUTOSTART !== '0') scanner.start();
});
