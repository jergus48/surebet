// Markets of the Tipos / Synottip betting platform (same API, same market names and ids), mapped to
// our odds model. Ported from the Python scanner's tipos.markets_of (2026-11), verified market names:
//   "Zápas" 1/X/2 (Synottip writes the draw "0"), "Dvojtip" 1X/X2/12 (Synottip 10/02/12),
//   "Stávka bez remízy" 1/2, "Celkový počet gólov" rows "Pod (2.5)" / "Nad (2.5)",
//   "1. polčas - Počet gólov", "Obaja dajú gól" Áno/Nie, "Handicap" rows "Tím 1 (-0.5)" / "Tím 2 (+0.5)",
//   "1. polčas" 1/X/2, "<team> celkový počet gólov", hockey "Víťaz (vrátane predĺženia a nájazdov)",
//   "Počet gólov (vrátane predĺženia a nájazdov)", "Handicap (vrátane predĺženia a nájazdov)",
//   tennis/volleyball "Víťaz zápasu", "1. set - Víťaz", volleyball "Celkový počet bodov", "Sety - Handicap".
// Our market keys (src/arb.js outcomeSets):
//   h2h (1/X/2 + double chance; hockey = regular time), dnb (1/2), totals (O/U, point = line),
//   spreads (H/A, point = HOME line), btts (Y/N), 1h_h2h, 1h_totals, home_totals, away_totals,
//   ot_h2h / ot_totals / ot_spreads (hockey incl. overtime and shoot-out), set1_h2h, sets_spreads.
// Only complete markets (every outcome open) and half lines (x.5: no push) are kept.
// The list call returns these when its GameIds name them (GAME_IDS below, same on both books).
const SPORTS = require('./sports');

// Market (game) ids for GetWebStandardEvents' GameIds, by our sport key.
const GAME_IDS = {
  football: [19, 20, 21, 24, 25, 27, 28, 36, 64, 69],
  hockey: [19, 20, 24, 25, 100, 101, 102],
  handball: [19, 20],
  tennis: [2, 6],
  volleyball: [2, 6, 9, 197],
};

const X12 = { '1': '1', X: 'X', '0': 'X', '2': '2' };
const DC = { '1X': '1X', X2: 'X2', '12': '12', '10': '1X', '02': 'X2' };
const TEAM_GOALS = ' celkový počet gólov';
const lineOf = name => { const m = /\(\s*([+-]?\d+(?:[.,]\d+)?)\s*\)\s*$/.exec(name || ''); return m ? Number(m[1].replace(',', '.')) : null; };
const half = x => Number.isFinite(x) && Math.abs(Math.abs(x) % 1 - 0.5) < 1e-9;

// One market row -> { sel: price } with exactly these names, else null (unknown name = not used).
function named(row, names) {
  const out = {};
  for (const o of row) {
    const sel = names[String(o.name || '').trim()];
    if (!sel || out[sel]) return null;
    out[sel] = o.price;
  }
  return out;
}

// games: [{ name, rows: [[{ name, price }]] }] (only open odds) -> [{ market, point, sel, price }]
function marketsOf(sportKey, home, away, games) {
  const draw = !!(SPORTS[sportKey] && SPORTS[sportKey].draw);
  const out = [];
  const have = new Set();
  const put = (market, point, prices, need) => {
    const k = `${market}|${point ?? ''}`;
    if (!prices || have.has(k) || need.some(s => !(prices[s] > 1)) || Object.keys(prices).length !== need.length) return;
    have.add(k);
    for (const s of need) out.push({ market, point: point ?? null, sel: s, price: Math.round(prices[s] * 100) / 100 });
  };
  const overUnder = (rows, market) => {
    for (const row of rows) {
      if (row.length !== 2) continue;
      const u = row.find(o => /^pod/i.test(o.name)), o = row.find(x => /^nad/i.test(x.name));
      const lu = u && lineOf(u.name), lo = o && lineOf(o.name);
      if (!u || !o || lu !== lo || !half(lu)) continue;
      put(market, lu, { O: o.price, U: u.price }, ['O', 'U']);
    }
  };
  const handicap = (rows, market) => {
    for (const row of rows) {
      if (row.length !== 2) continue;
      const h = row.find(o => /^tím 1/i.test(o.name)), a = row.find(o => /^tím 2/i.test(o.name));
      const hl = h && lineOf(h.name), al = a && lineOf(a.name);
      if (!h || !a || hl == null || al == null || Math.abs(hl + al) > 1e-9 || !half(hl)) continue;
      put(market, hl, { H: h.price, A: a.price }, ['H', 'A']);
    }
  };
  for (const g of games) {
    const name = String(g.name || '').trim();
    const rows = g.rows || [];
    const first = rows[0] || [];
    if (sportKey === 'football' || sportKey === 'handball') {
      if (name === 'Zápas') put('h2h', null, named(first, X12), ['1', 'X', '2']);
      else if (name === 'Dvojtip') put('h2h', 'dc', named(first, DC), ['1X', 'X2', '12']);
      else if (name === 'Stávka bez remízy') put('dnb', null, named(first, { '1': '1', '2': '2' }), ['1', '2']);
      else if (name === 'Celkový počet gólov') overUnder(rows, 'totals');
      else if (name === '1. polčas - Počet gólov') overUnder(rows, '1h_totals');
      else if (name === 'Obaja dajú gól') put('btts', null, named(first, { 'Áno': 'Y', Nie: 'N' }), ['Y', 'N']);
      else if (name === 'Handicap') handicap(rows, 'spreads');
      else if (name === '1. polčas') put('1h_h2h', null, named(first, X12), ['1', 'X', '2']);
      else if (name.toLowerCase().endsWith(TEAM_GOALS) && home !== away) {
        const team = name.slice(0, -TEAM_GOALS.length).trim().toLowerCase();
        // Tipos names the team, Synottip writes "Tím1" / "Tím2".
        const side = team === home.toLowerCase() || team === 'tím1' ? 'home_totals' : team === away.toLowerCase() || team === 'tím2' ? 'away_totals' : null;
        if (side) overUnder(rows, side);
      }
    } else if (sportKey === 'hockey') {
      if (name === 'Zápas') put('h2h', null, named(first, X12), ['1', 'X', '2']); // regular time
      else if (name === 'Dvojtip') put('h2h', 'dc', named(first, DC), ['1X', 'X2', '12']);
      else if (name === 'Víťaz (vrátane predĺženia a nájazdov)') put('ot_h2h', null, named(first, { '1': '1', '2': '2' }), ['1', '2']);
      else if (name === 'Celkový počet gólov') overUnder(rows, 'totals'); // regular time
      else if (name === 'Počet gólov (vrátane predĺženia a nájazdov)') overUnder(rows, 'ot_totals');
      else if (name === 'Handicap') handicap(rows, 'spreads');
      else if (name === 'Handicap (vrátane predĺženia a nájazdov)') handicap(rows, 'ot_spreads');
    } else if (!draw) {
      if (name === 'Víťaz zápasu' || name === 'Víťaz (vrátane predĺženia)') put('h2h', null, named(first, { '1': '1', '2': '2' }), ['1', '2']);
      else if (name === '1. set - Víťaz') put('set1_h2h', null, named(first, { '1': '1', '2': '2' }), ['1', '2']);
      else if (sportKey === 'volleyball' && name === 'Celkový počet bodov') overUnder(rows, 'totals');
      else if (sportKey === 'volleyball' && name === 'Sety - Handicap') handicap(rows, 'sets_spreads');
    }
  }
  // Double chance shares the h2h market (point null) with 1/X/2 in our model.
  return out.map(o => (o.point === 'dc' ? { ...o, point: null } : o));
}

module.exports = { marketsOf, GAME_IDS };
