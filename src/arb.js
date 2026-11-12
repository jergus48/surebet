// Surebet math. Pure functions, no I/O, covered by test/arb.test.js.
//
// Input: normalized events
//   { id, sport, sportTitle, league, home, away, start (ms), live (bool),
//     odds: [{ book, market, point, sel, price, link, updated }] }
//   market: 'h2h' | 'totals' | 'spreads'
//   sel:    h2h -> '1' | 'X' | '2'; totals -> 'O' | 'U'; spreads -> 'H' | 'A'
//   point:  null for h2h; line for totals; HOME line for spreads
//
// Output: one surebet per (event, market, point) whose best cross-book prices
// sum to an implied probability below 1.

function groupKey(o) { return `${o.market}|${o.point == null ? '' : o.point}`; }

// Which selections make a complete, mutually exclusive outcome set.
function outcomeSets(market, sels, drawPossible) {
  if (market === 'h2h') {
    if (!drawPossible && !sels.has('X')) return [['1', '2']];
    // 3-way, plus double-chance pairs (each covers every result exactly once).
    return [['1', 'X', '2'], ['1', 'X2'], ['2', '1X'], ['X', '12']];
  }
  if (market === 'totals') return [['O', 'U']];
  if (market === 'spreads') return [['H', 'A']];
  return [];
}

// Split `total` so every leg returns the same payout, rounded to `step`.
function stakes(prices, total, step = 1) {
  const inv = prices.reduce((a, p) => a + 1 / p, 0);
  const raw = prices.map(p => (total * (1 / p)) / inv);
  const rounded = raw.map(s => Math.max(step, Math.round(s / step) * step));
  const staked = rounded.reduce((a, b) => a + b, 0);
  const payouts = rounded.map((s, i) => s * prices[i]);
  const worst = Math.min(...payouts);
  return { stakes: rounded, staked, worstPayout: worst, worstProfit: worst - staked };
}

function findSurebets(events, opts = {}) {
  const { minProfitPct = 0, maxProfitPct = 100, books = null, bankroll = 100, step = 1, includeLive = true, maxAgeMs = 0, now = Date.now(), stakeTiers = null } = opts;
  const out = [];
  for (const ev of events) {
    if (!includeLive && ev.live) continue;
    const groups = new Map();
    for (const o of ev.odds) {
      if (books && !books.has(o.book)) continue;
      if (!(o.price > 1)) continue;
      if (maxAgeMs && o.updated && now - o.updated > maxAgeMs) continue; // stale price
      const k = groupKey(o);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    for (const [, list] of groups) {
      const { market, point } = list[0];
      const sels = new Set(list.map(o => o.sel));
      for (const set of outcomeSets(market, sels, ev.drawPossible)) {
        const legs = [];
        for (const sel of set) {
          const cands = list.filter(o => o.sel === sel);
          if (!cands.length) { legs.length = 0; break; }
          legs.push(cands.reduce((a, b) => (b.price > a.price ? b : a)));
        }
        if (legs.length !== set.length) continue;
        // One-book "arbs" are data errors or the same book's stale lines.
        if (new Set(legs.map(l => l.book)).size < 2) continue;
        const inv = legs.reduce((a, l) => a + 1 / l.price, 0);
        if (inv >= 1) continue;
        const profitPct = (1 / inv - 1) * 100;
        if (profitPct < minProfitPct || profitPct > maxProfitPct) continue;
        // Bigger edge, bigger bet: pick the total stake from the highest tier this profit reaches.
        const tier = (stakeTiers || []).filter(t => profitPct >= t.minProfitPct).sort((a, b) => b.minProfitPct - a.minProfitPct)[0];
        const total = tier ? tier.stake : bankroll;
        const st = stakes(legs.map(l => l.price), total, total < 30 ? Math.min(step, 0.5) : step);
        // Rounded stakes must still lock in at least the minimum profit, else it is not a real surebet.
        if (st.worstProfit / st.staked * 100 < minProfitPct * 0.5 || st.worstProfit <= 0) continue;
        const legOut = legs.map((l, i) => {
          // How far this price sits above what the other books offer for the same selection.
          // A big gap usually means one book has a stale line that is about to be corrected.
          const others = list.filter(o => o.sel === l.sel && o.book !== l.book).map(o => o.price).sort((a, b) => a - b);
          const ref = others.length ? others[Math.floor(others.length / 2)] : null;
          const outlier = ref != null && l.price >= ref * 1.2;
          const leg = { book: l.book, sel: l.sel, price: l.price, link: l.link || null, linkGeneric: !!l.linkGeneric, updated: l.updated || null, stake: st.stakes[i], ref, outlier };
          // The book's own spelling of the teams, when its reader gives one (bet365 is in German).
          if (l.home && l.away) Object.assign(leg, { home: l.home, away: l.away });
          return leg;
        });
        out.push({
          key: [ev.id, market, point ?? '', ...legs.map(l => `${l.book}:${l.sel}`)].join('|'),
          eventId: ev.id,
          sport: ev.sport,
          sportTitle: ev.sportTitle,
          league: ev.league,
          home: ev.home,
          away: ev.away,
          start: ev.start,
          live: !!ev.live,
          market,
          point: point ?? null,
          profitPct: Math.round(profitPct * 100) / 100,
          legs: legOut,
          // A leg far above the other books is usually a stale line, not a bettable edge.
          suspect: legOut.some(l => l.outlier),
          staked: st.staked,
          worstProfit: Math.round(st.worstProfit * 100) / 100,
        });
      }
    }
  }
  return out.sort((a, b) => b.profitPct - a.profitPct);
}

// Human label for the market column, e.g. "1 vs X2", "Over 2.5 vs Under 2.5".
function marketLabel(sb) {
  const sels = sb.legs.map(l => l.sel);
  if (sb.market === 'h2h') {
    if (sels.length === 3) return '1 / X / 2';
    return sels.join(' vs ');
  }
  if (sb.market === 'totals') return `Over ${sb.point} vs Under ${sb.point}`;
  if (sb.market === 'spreads') return `AH ${sb.point > 0 ? '+' : ''}${sb.point} vs ${-sb.point > 0 ? '+' : ''}${-sb.point}`;
  return sb.market;
}

module.exports = { findSurebets, stakes, marketLabel };
