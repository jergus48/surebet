// Two loops:
//  1) main scan (pollSeconds): all books, pre-match surebets
//  2) live loop (liveSeconds): only books with a fast live read; every leg of a
//     live surebet comes from the SAME poll (read within a second or two), and
//     it is only reported after it survives liveConfirmPolls polls in a row.
const config = require('./config');
const providers = require('./providers');
const { findSurebets } = require('./arb');
const db = require('./db');
const notify = require('./notify');
const bettor = require('./bettor');
const analytics = require('./analytics');

const state = {
  running: false,
  lastRun: null,
  lastError: null,
  lastEvents: 0,
  active: [], // pre-match surebets from the latest main scan
  live: { running: false, lastRun: null, lastError: null, events: 0, candidates: 0, active: [] },
};
let timer = null;
let liveTimer = null;
let liveBusy = false;
const liveSeen = new Map(); // key -> { count, lastSeen, alertedAt }

const lastAlert = new Map(); // key -> profit % in the last Telegram message (for "aktualizované")

function reportNew(s, sb, siblings = []) {
  const tag = sb.live ? 'LIVE ' : '';
  db.log('info', `NEW ${tag}+${sb.profitPct}% ${sb.home}-${sb.away} ${sb.market}${sb.point != null ? ' ' + sb.point : ''} [${sb.legs.map(l => `${l.book} ${l.sel}@${l.price}`).join(', ')}]`);
  lastAlert.set(sb.key, sb.profitPct);
  // Suspect (a leg far above the other books) stays in history and the dashboard, but no alert and never a bet.
  if (sb.suspect && !s.alertSuspect) return;
  // alertsOnlyBets: Telegram hears only from the bettor (slips ready, bets placed).
  if (!s.alertsOnlyBets) notify.send(s, notify.format(sb, { siblings }), { html: true }).then(sent => sent && db.markNotified(sb.key)).catch(e => db.log('warn', `telegram: ${e.message}`));
  if (s.betMode === 'off') return;
  const why = bettor.betAllowed(s, sb);
  if (why) return db.log('info', `no bet ${sb.home}-${sb.away}: ${why}`);
  bettor.execute(s, sb).catch(e => db.log('error', `bettor: ${e.message}`));
}

// Same surebet still there, profit moved by >= 0.5 points: send an update.
function maybeUpdate(s, sb, siblings = []) {
  const prev = lastAlert.get(sb.key);
  if (prev == null || Math.abs(sb.profitPct - prev) < 0.5) return;
  if (sb.suspect && !s.alertSuspect) return;
  db.log('info', `UPDATE ${sb.home}-${sb.away} ${prev}% -> ${sb.profitPct}%`);
  lastAlert.set(sb.key, sb.profitPct);
  if (s.alertsOnlyBets) return;
  notify.send(s, notify.format(sb, { siblings, previous: prev }), { html: true }).catch(e => db.log('warn', `telegram: ${e.message}`));
}

// A surebet that is still there after its bet attempt failed (a page timed out, odds moved for a
// moment) is tried again: at most RETRY_MAX attempts per match, RETRY_MS apart, never on a match
// that already has a bet (placed, partial, unconfirmed or still running).
const RETRY_MS = 5 * 60 * 1000, RETRY_MAX = 3;
function maybeRetry(s, sb) {
  if (s.betMode !== 'auto' || sb.live) return; // live surebets are re-reported by the live loop
  if (bettor.betAllowed(s, sb)) return;
  const ev = db.eventBets(sb.eventId || sb.key.split('|')[0]);
  if (!ev.n || ev.placed || ev.n >= RETRY_MAX || Date.now() - ev.last < RETRY_MS) return;
  db.log('info', `retry bet ${sb.home}-${sb.away} (+${sb.profitPct}%, attempt ${ev.n + 1})`);
  bettor.execute(s, sb).catch(e => db.log('error', `bettor: ${e.message}`));
}

const siblingsOf = (found, sb) => found.filter(x => x.eventId === sb.eventId && x.key !== sb.key);

async function pollOnce() {
  const s = config.load();
  const provider = providers.get(s.provider);
  const t0 = Date.now();
  try {
    const events = await provider.fetchEvents(s);
    // Restrict to books you actually hold accounts at, when any are enabled.
    const enabled = Object.entries(s.bookmakers).filter(([, b]) => b.enabled).map(([k]) => k);
    const books = enabled.length ? new Set(enabled) : null;
    // The slow scan reads books one after another, so live events are left to the live loop.
    const found = findSurebets(events, {
      minProfitPct: s.minProfitPct, maxProfitPct: s.maxProfitPct, books,
      bankroll: s.bankrollPerBet, step: s.roundStakeTo, stakeTiers: s.stakeTiers, includeLive: false,
      maxAgeMs: (s.maxOddsAgeSec || 0) * 1000,
    });
    for (const sb of found) {
      if (db.upsertSurebet(sb)) reportNew(s, sb, siblingsOf(found, sb));
      else { maybeUpdate(s, sb, siblingsOf(found, sb)); maybeRetry(s, sb); }
    }
    analytics.record(events, { live: false, books, maxAgeMs: (s.maxOddsAgeSec || 0) * 1000, maxProfitPct: s.maxProfitPct });
    state.active = found;
    state.events = events; // latest pre-match read (the bettor looks up covers here)
    state.lastEvents = events.length;
    state.lastError = null;
    state.lastRun = Date.now();
    db.log('debug', `poll ok: ${events.length} events, ${found.length} surebets, ${Date.now() - t0} ms`);
  } catch (e) {
    state.lastError = e.message;
    state.lastRun = Date.now();
    db.log('error', `poll: ${e.message}`);
    if (/Credits low/.test(e.message)) stop();
  }
}

async function livePollOnce() {
  if (liveBusy) return; // previous live poll still running: skip this tick
  liveBusy = true;
  const s = config.load();
  const provider = providers.get(s.provider);
  const t0 = Date.now();
  try {
    if (typeof provider.fetchLive !== 'function') throw new Error('this provider has no live read');
    const events = await provider.fetchLive(s);
    const now = Date.now();
    const found = findSurebets(events, {
      minProfitPct: s.liveMinProfitPct ?? s.minProfitPct,
      maxProfitPct: s.liveMaxProfitPct ?? 10,
      bankroll: s.bankrollPerBet, step: s.roundStakeTo, stakeTiers: s.stakeTiers, includeLive: true,
      maxAgeMs: (s.liveMaxAgeSec || 20) * 1000, now,
    });
    const liveBooks = new Set(Object.entries(s.bookmakers).filter(([, b]) => b.enabled).map(([k]) => k));
    analytics.record(events, { live: true, books: liveBooks.size ? liveBooks : null, maxAgeMs: (s.liveMaxAgeSec || 20) * 1000, maxProfitPct: s.liveMaxProfitPct ?? 10, now });
    const need = Math.max(1, s.liveConfirmPolls || 2);
    const confirmed = [];
    const present = new Set();
    for (const sb of found) {
      present.add(sb.key);
      const seen = liveSeen.get(sb.key) || { count: 0, alertedAt: 0 };
      seen.count += 1; seen.lastSeen = now;
      liveSeen.set(sb.key, seen);
      if (seen.count < need) continue; // not confirmed yet
      confirmed.push(sb);
      db.upsertSurebet(sb); // history (insert once, then updates last seen / max profit)
      // Alert once per appearance; again only if it vanished for 2+ minutes.
      if (!seen.alertedAt || now - seen.alertedAt > 120000) { seen.alertedAt = now; reportNew(s, sb, siblingsOf(found, sb)); }
      else maybeUpdate(s, sb, siblingsOf(found, sb));
    }
    // A candidate missing from this poll loses its streak.
    for (const [k, v] of liveSeen) if (!present.has(k)) { v.count = 0; if (now - v.lastSeen > 600000) liveSeen.delete(k); }
    state.live = { running: state.live.running, lastRun: now, lastError: null, events: events.length, candidates: found.length, active: confirmed };
    state.liveEvents = events;
    db.log('debug', `live ok: ${events.length} live matches, ${found.length} candidates, ${confirmed.length} confirmed, ${Date.now() - t0} ms | ${Object.entries(provider.getLiveStats ? provider.getLiveStats() : {}).map(([k, v]) => `${k} ${v.events}${v.ok ? '' : ' ERR'} ${v.ms}ms`).join(', ')}`);
  } catch (e) {
    state.live = { ...state.live, lastRun: Date.now(), lastError: e.message };
    db.log('error', `live: ${e.message}`);
  } finally {
    liveBusy = false;
  }
}

async function loop() {
  if (!state.running) return;
  await pollOnce();
  if (state.running) timer = setTimeout(loop, Math.max(5, config.load().pollSeconds) * 1000);
}

async function liveLoop() {
  if (!state.live.running) return;
  const s = config.load();
  if (s.includeLive) await livePollOnce();
  if (state.live.running) liveTimer = setTimeout(liveLoop, Math.max(5, s.liveSeconds || 15) * 1000);
}

function start() {
  if (state.running) return;
  state.running = true;
  state.live.running = true;
  db.log('info', 'scanner started');
  loop();
  liveLoop();
}
function stop() {
  state.running = false;
  state.live.running = false;
  clearTimeout(timer);
  clearTimeout(liveTimer);
  db.log('info', 'scanner stopped');
}

module.exports = { start, stop, pollOnce, livePollOnce, state };
