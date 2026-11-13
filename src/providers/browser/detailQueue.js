// Background queue for books whose extra markets come per match (one "detail" request per match).
// The scan names the matches it wants (details(settings, links)); a loop fetches them one at a time,
// gapMs apart, never-fetched first (in the given order = soonest kick-off), then the oldest. The
// scan only reads the cache: every detail younger than ttlMs (the arb drops prices older than
// maxOddsAgeSec). HTTP 403 / 429 stops the queue for 30 min; nothing is retried around it.
const db = require('../../db');

const PAUSE_MS = 30 * 60 * 1000;

function createDetailQueue({ name, keyOf, fetchOne, parse, gapMs = 900, ttlMs = 170000 }) {
  const cache = new Map(); // key -> { at, odds }
  let wanted = [];         // [{ key, link }]
  let running = false, pausedUntil = 0, settings = null;

  function next() {
    let best = null, bestAge = -1;
    for (const w of wanted) {
      const c = cache.get(w.key);
      if (!c) return w;
      const age = Date.now() - c.at;
      if (age > bestAge) { best = w; bestAge = age; }
    }
    return bestAge > ttlMs * 0.6 ? best : null; // everything fresh: idle
  }

  async function loop() {
    for (;;) {
      if (!wanted.length) return;
      if (Date.now() < pausedUntil) { await new Promise(r => setTimeout(r, 30000)); continue; }
      const w = next();
      if (!w) { await new Promise(r => setTimeout(r, 2000)); continue; }
      try {
        const j = await fetchOne(settings, w.key);
        if (j && (j.status === 403 || j.status === 429)) { pausedUntil = Date.now() + PAUSE_MS; db.log('warn', `${name} details: HTTP ${j.status}, pausing 30 min`); continue; }
        cache.set(w.key, { at: Date.now(), odds: !j || j.error ? [] : parse(j, w.link) });
      } catch (e) {
        db.log('warn', `${name} details: ${e.message}`);
        await new Promise(r => setTimeout(r, 10000));
      }
      if (cache.size > 3000) for (const [k, v] of cache) if (Date.now() - v.at > ttlMs) cache.delete(k);
      await new Promise(r => setTimeout(r, gapMs));
    }
  }

  // Map(link -> extra odds) for the fresh cached details of these links; (re)queues them all.
  async function details(s, links) {
    settings = s;
    wanted = links.map(link => ({ key: keyOf(link), link })).filter(x => x.key);
    if (!running) { running = true; loop().catch(() => { }).finally(() => { running = false; }); }
    const out = new Map();
    for (const w of wanted) {
      const c = cache.get(w.key);
      if (c && Date.now() - c.at < ttlMs) out.set(w.link, c.odds);
    }
    return out;
  }

  return { details, cache };
}

module.exports = { createDetailQueue };
