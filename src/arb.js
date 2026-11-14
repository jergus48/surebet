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
  // 1st half 1X2 always has a draw.
  if (market === '1h_h2h') return [['1', 'X', '2'], ['1', 'X2'], ['2', '1X'], ['X', '12']];
  // Two-way winners: draw no bet (stake back on a draw at every book), hockey incl. overtime, 1st set.
  if (market === 'dnb' || market === 'ot_h2h' || market === 'set1_h2h') return [['1', '2']];
  if (market === 'btts') return [['Y', 'N']];
  // Cross-market pairs (CROSS below): leg A from one market, leg B from another.
  if (market.startsWith('x_')) return [['A', 'B']];
  // Over / under and handicaps, also for the 1st half, one team, overtime-inclusive and sets.
  if (/^(?:(?:1h|home|away|ot)_)?totals$/.test(market)) return [['O', 'U']];
  if (/^(?:(?:ot|sets)_)?spreads$/.test(market)) return [['H', 'A']];
  return [];
}

// Split at most `total` in `step` units so the worst payout beats the stake by the most. Plain
// rounding of the ideal split breaks small uneven surebets (4 EUR on 1.30 / 4.60 rounds to 3 / 1 and
// loses on one side), so for every total from `total` down, each leg tries the unit below and
// above its ideal stake, and the split with the biggest locked-in profit wins.
function bestSplit(prices, total, step = 1, minLeg = step) {
  const inv = prices.reduce((a, p) => a + 1 / p, 0);
  const maxU = Math.floor(total / step + 1e-9);
  const minU = Math.max(1, Math.ceil(minLeg / step - 1e-9));
  let best = null;
  for (let T = maxU; T >= prices.length * minU; T--) {
    const raw = prices.map(p => (T / p) / inv);
    const opts = raw.map(r => [...new Set([Math.max(minU, Math.floor(r)), Math.max(minU, Math.ceil(r))])]);
    const walk = (i, cur) => {
      if (i === prices.length) {
        const units = cur.reduce((a, b) => a + b, 0);
        if (units > maxU) return;
        const staked = units * step;
        const worst = Math.min(...cur.map((u, j) => u * step * prices[j]));
        const profit = worst - staked;
        if (!best || profit > best.profit + 1e-9 || (Math.abs(profit - best.profit) < 1e-9 && staked > best.staked)) best = { cur: [...cur], staked, worst, profit };
        return;
      }
      for (const u of opts[i]) { cur.push(u); walk(i + 1, cur); cur.pop(); }
    };
    walk(0, []);
  }
  if (!best) return { stakes: prices.map(() => step), staked: step * prices.length, worstPayout: 0, worstProfit: -1 };
  const r2 = x => Math.round(x * 100) / 100;
  return { stakes: best.cur.map(u => r2(u * step)), staked: r2(best.staked), worstPayout: best.worst, worstProfit: best.profit };
}
const stakes = bestSplit;
// Small totals (under 30) are split in 0.10 steps with at least 0.50 on a leg: 0.50 steps leave a
// 4 EUR surebet on uneven odds with almost no locked-in profit.
const SMALL_STEP = 0.1, SMALL_MIN_LEG = 0.5;

// Stale-odds filters ported from the Python scanner. Pure: odds list -> odds list without the quotes
// that are most likely stale lines, not real edges.
//  - stale double chance: a book's 1X / X2 / 12 more than 5% above what its own 1X2 implies
//    (1X implied = 1 / (1/p1 + 1/pX)); books move 1X2 first and leave double chance behind.
//  - flipped favourite: a book whose 2-way / 3-way favourite (lower of 1 and 2) is the other side
//    from at least two other books that agree with each other: its 1/X/2 prices are dropped.
const DC_PARTS = { '1X': ['1', 'X'], X2: ['X', '2'], '12': ['1', '2'] };
function dropStale(odds) {
  const h2h = odds.filter(o => o.market === 'h2h');
  const at = (book, sel) => h2h.find(o => o.book === book && o.sel === sel);
  const drop = new Set();
  for (const o of h2h) {
    const parts = DC_PARTS[o.sel];
    if (!parts) continue;
    const a = at(o.book, parts[0]), b = at(o.book, parts[1]);
    if (a && b && o.price > 1.05 / (1 / a.price + 1 / b.price)) drop.add(o);
  }
  const fav = {};
  for (const book of new Set(h2h.map(o => o.book))) {
    const p1 = at(book, '1'), p2 = at(book, '2');
    if (p1 && p2 && p1.price !== p2.price) fav[book] = p1.price < p2.price ? '1' : '2';
  }
  const books = Object.keys(fav);
  for (const book of books) {
    const others = books.filter(b => b !== book);
    const against = others.filter(b => fav[b] !== fav[book]).length;
    if (against >= 2 && others.every(b => fav[b] !== fav[book])) for (const o of h2h) if (o.book === book && ['1', 'X', '2'].includes(o.sel)) drop.add(o);
  }
  // Side check against the book's OWN 1X2: when one side is the clear favourite (20 %+ apart), that side
  // must also be the cheaper one in draw no bet and in the +-0.5 handicap at the same book. A market
  // that says the opposite has its sides turned (a match listed the other way round and not turned
  // with it: Brasília - Japonsko showed 7-20 % "surebets" with one team on both legs, 2026-11-13).
  for (const book of Object.keys(fav)) {
    const p1 = at(book, '1').price, p2 = at(book, '2').price;
    const clear = p1 * 1.2 <= p2 ? '1' : p2 * 1.2 <= p1 ? '2' : null;
    if (!clear) continue;
    const mine = odds.filter(o => o.book === book);
    const dnb1 = mine.find(o => o.market === 'dnb' && o.sel === '1'), dnb2 = mine.find(o => o.market === 'dnb' && o.sel === '2');
    if (dnb1 && dnb2 && (clear === '1' ? dnb1.price > dnb2.price : dnb2.price > dnb1.price)) { drop.add(dnb1); drop.add(dnb2); }
    for (const l of [0.5, -0.5]) {
      const h = mine.find(o => o.market === 'spreads' && o.point === l && o.sel === 'H'), a = mine.find(o => o.market === 'spreads' && o.point === l && o.sel === 'A');
      if (h && a && (clear === '1' ? h.price > a.price : a.price > h.price)) {
        for (const o of mine) if (/^(spreads|home_totals|away_totals|dnb)$/.test(o.market)) drop.add(o); // the whole side-based set is suspect
      }
    }
  }
  return drop.size ? odds.filter(o => !drop.has(o)) : odds;
}

// Between the books of one surebet: a book whose 1/2 prices make home the clear favourite (20 %+
// apart) while another book makes away the clear favourite.
function flippedFavourite(odds, books) {
  const fav = [];
  for (const b of new Set(books)) {
    const p1 = odds.find(o => o.book === b && o.market === 'h2h' && o.sel === '1');
    const p2 = odds.find(o => o.book === b && o.market === 'h2h' && o.sel === '2');
    if (!p1 || !p2) continue;
    if (p1.price * 1.2 <= p2.price) fav.push('1'); else if (p2.price * 1.2 <= p1.price) fav.push('2');
  }
  return fav.includes('1') && fav.includes('2');
}

// Does every one of these books name the same two teams/players, exactly? A book may list them the other way
// round ("B - A"): then its prices must have been turned (swapped) by the matcher, and only then, so each leg
// is on the side the surebet means. -> true when the pairing is certain.
const foldName = t => String(t || '').replace(/\s*\([^)]*\)\s*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9-]+/g, ' ').trim();
function sameNames(ev, books) {
  const names = ev.names || {};
  let ref = null;
  for (const b of new Set(books)) {
    const sides = foldName(names[b]).split(/\s+-\s+/);
    if (sides.length !== 2 || !sides[0] || !sides[1]) return false;
    const turned = ev.odds.some(o => o.book === b && o.market === 'h2h' && o.swapped);
    const [h, a] = turned ? [sides[1], sides[0]] : sides; // in the surebet's order
    if (!ref) ref = [h, a];
    else if (ref[0] !== h || ref[1] !== a) return false;
  }
  return !!ref;
}

// Cross-market surebets (ported from the Python scanner): two legs from different markets that still
// cover every result with one winner each, so the 2-way formula holds:
//   draw no bet 1 + double chance X2: home wins -> DNB pays; draw -> X2 pays and DNB is refunded
//   (a bonus on top); away wins -> X2 pays. Same the other way round (DNB 2 + 1X).
//   hockey: winner incl. overtime 1 + regular-time X2: home wins in regular time -> OT winner pays;
//   draw after 60 min -> X2 pays (and the OT winner may pay too); away wins -> X2 pays.
const CROSS = [
  ['x_dnb1_X2', ['dnb', '1'], ['h2h', 'X2']],
  ['x_dnb2_1X', ['dnb', '2'], ['h2h', '1X']],
  ['x_ot1_X2', ['ot_h2h', '1'], ['h2h', 'X2']],
  ['x_ot2_1X', ['ot_h2h', '2'], ['h2h', '1X']],
];
function addCross(groups) {
  for (const [key, [ma, sa], [mb, sb]] of CROSS) {
    const a = (groups.get(`${ma}|`) || []).filter(o => o.sel === sa);
    const b = (groups.get(`${mb}|`) || []).filter(o => o.sel === sb);
    if (!a.length || !b.length) continue;
    groups.set(`${key}|`, [...a.map(o => ({ ...o, market: key, sel: 'A', realMarket: ma, realSel: sa })), ...b.map(o => ({ ...o, market: key, sel: 'B', realMarket: mb, realSel: sb }))]);
  }
}

// Matches far from kick-off move slowly: their prices may be older (FAR_MAX_AGE_MS instead of maxOddsAgeSec).
// The per-match detail readers keep them fresh that long, so they cover 2-3x more matches with the same
// requests (only ~70 of ~950 Niké matches had goals / handicap prices, 2026-11-14). Every slip's price is
// re-checked before Place, so an old price never bets: at worst the attempt stops.
const FAR_START_MS = 6 * 3600e3, FAR_MAX_AGE_MS = 10 * 60e3;
const maxAgeFor = (ev, maxAgeMs, now) => (maxAgeMs && !ev.live && ev.start && ev.start - now > FAR_START_MS ? Math.max(maxAgeMs, FAR_MAX_AGE_MS) : maxAgeMs);

function findSurebets(events, opts = {}) {
  const { minProfitPct = 0, maxProfitPct = 100, books = null, bankroll = 100, step = 1, includeLive = true, maxAgeMs = 0, now = Date.now(), stakeTiers = null } = opts;
  const out = [];
  for (const ev of events) {
    if (!includeLive && ev.live) continue;
    const groups = new Map();
    const maxAge = maxAgeFor(ev, maxAgeMs, now);
    for (const o of dropStale(ev.odds)) {
      if (books && !books.has(o.book)) continue;
      if (!(o.price > 1)) continue;
      if (maxAge && o.updated && now - o.updated > maxAge) continue; // stale price
      const k = groupKey(o);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    addCross(groups);
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
        const st = total < 30 ? bestSplit(legs.map(l => l.price), total, SMALL_STEP, SMALL_MIN_LEG) : bestSplit(legs.map(l => l.price), total, step);
        // Rounded stakes must still lock in at least the minimum profit, else it is not a real surebet.
        if (st.worstProfit / st.staked * 100 < minProfitPct * 0.5 || st.worstProfit <= 0) continue;
        const legOut = legs.map((l, i) => {
          // How far this price sits above what the other books offer for the same selection.
          // A big gap usually means one book has a stale line that is about to be corrected.
          const others = list.filter(o => o.sel === l.sel && o.book !== l.book).map(o => o.price).sort((a, b) => a - b);
          const ref = others.length ? others[Math.floor(others.length / 2)] : null;
          const outlier = ref != null && l.price >= ref * 1.2;
          const leg = { book: l.book, sel: l.sel, price: l.price, link: l.link || null, linkGeneric: !!l.linkGeneric, updated: l.updated || null, stake: st.stakes[i], ref, outlier };
          // pick: the exact button of this price on the book's match page (extra markets from match details)
          if (l.pick) leg.pick = l.pick;
          // cross-market surebet: this leg's own market and pick (the bettor clicks that)
          if (l.realMarket) Object.assign(leg, { market: l.realMarket, sel: l.realSel, point: null });
          // listed the other way round at this book: its own name for the pick (bettor clicks that)
          if (l.swapped) Object.assign(leg, { bookSel: l.bookSel, bookPoint: l.bookPoint, swapped: true });
          // The book's own spelling of the teams, when its reader gives one (bet365 is in German).
          if (l.home && l.away) Object.assign(leg, { home: l.home, away: l.away });
          return leg;
        });
        out.push({
          key: [ev.id, market, point ?? '', ...legs.map(l => `${l.book}:${l.realSel || l.sel}`)].join('|'),
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
          // The books in this surebet clearly disagree who the favourite is: almost always two different
          // teams paired as one match ("Japonsko 1" vs "Japonsko 2") or swapped home/away. Never bet.
          // Exception: a LIVE match that every one of these books names exactly the same, same order: then it
          // is one match for sure, and one book has simply not moved its odds after the score changed yet
          // (Filbrandt - Chrzescian, TT Elite Series, Tipsport vs DOXXbet +9.94 %, 2026-11-14).
          flipped: flippedFavourite(ev.odds, legOut.map(l => l.book)) && !(ev.live && sameNames(ev, legOut.map(l => l.book))),
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
  const PRE = { '1h': '1st half ', home: 'home team ', away: 'away team ', ot: 'incl. OT ', sets: 'sets ', set1: '1st set ' };
  const m = /^(?:(1h|home|away|ot|sets|set1)_)?(.+)$/.exec(sb.market);
  const pre = m[1] ? PRE[m[1]] : '';
  const sign = x => `${x > 0 ? '+' : ''}${x}`;
  if (m[2] === 'h2h') return pre + (sels.length === 3 ? '1 / X / 2' : sels.join(' vs '));
  if (m[2] === 'totals') return `${pre}Over ${sb.point} vs Under ${sb.point}`;
  if (m[2] === 'spreads') return `${pre}AH ${sign(sb.point)} vs ${sign(-sb.point)}`;
  if (m[2] === 'dnb') return 'Draw no bet 1 vs 2';
  if (sb.market === 'x_dnb1_X2') return 'Draw no bet 1 vs X2';
  if (sb.market === 'x_dnb2_1X') return 'Draw no bet 2 vs 1X';
  if (sb.market === 'x_ot1_X2') return 'Winner incl. OT 1 vs X2 (60 min)';
  if (sb.market === 'x_ot2_1X') return 'Winner incl. OT 2 vs 1X (60 min)';
  if (m[2] === 'btts') return 'Both teams score: yes vs no';
  return sb.market;
}

module.exports = { FAR_START_MS, FAR_MAX_AGE_MS, maxAgeFor, sameNames, findSurebets, stakes, bestSplit, marketLabel, dropStale, flippedFavourite, SMALL_STEP, SMALL_MIN_LEG };
