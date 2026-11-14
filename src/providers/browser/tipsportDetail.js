// Extra markets for Tipsport and Chance (same platform, same match ids): one match detail per request
//   GET /rest/offer/v3/matches/<id>?fromResults=false  -> { match: { nameFull, eventTables[{ name,
//       boxes[{ name, cells[{ name, oppNumber, odd, active }] }] }] } }
// Table names and pick numbers checked 2026-11-13 (ported from the Python scanner's tipsport_markets):
//   "Výsledok zápasu bez remízy" 11 / 15, "Výsledok 1. polčasu" 10001 / 10003 / 10005,
//   "Počet gólov v zápase" / "Počet gólov v 1. polčase" "Viac ako 2.5" / "Menej ako 2.5"
//   (quarter lines "1.25 (1.0, 1.5)" left out), "Počet gólov tímu v zápase" (box = team),
//   "Handicap v zápase" box [home "-1.5", away "+1.5"], "Každý tím dá v zápase" box "1 a viac gólov".
// Football only (other sports' tables mean other things: hockey goals are regular time and
// overtime-inclusive in separate tables, not mapped yet).
const { createDetailQueue } = require('./detailQueue');

const num = s => { const m = /([+-]?\d+(?:[.,]\d+)?)\s*$/.exec(String(s || '').trim()); return m ? Number(m[1].replace(',', '.')) : NaN; };
const half = x => Number.isFinite(x) && Math.abs(Math.abs(x) % 1 - 0.5) < 1e-9;

function parseDetail(json, book, link, now = Date.now()) {
  const m = (json && json.match) || {};
  const [home, away] = String(m.nameFull || m.nameAbbr || '').split(' - ').map(x => (x || '').trim());
  if (!home || !away) return [];
  const sideOf = n => {
    const x = String(n || '').trim().toLowerCase();
    const h = home.toLowerCase().startsWith(x), a = away.toLowerCase().startsWith(x);
    return !x || h === a ? null : h ? 'home' : 'away';
  };
  const out = [];
  const seen = new Set();
  const put = (market, point, prices) => {
    const k = `${market}|${point ?? ''}`;
    if (seen.has(k) || Object.values(prices).some(c => !c || c.active === false || !(Number(c.odd) > 1))) return;
    seen.add(k);
    // pick: the button on the match page carries data-id = the cell id (same ids on Tipsport and Chance)
    for (const [sel, c] of Object.entries(prices)) out.push({ book, market, point: point ?? null, sel, price: Math.round(Number(c.odd) * 100) / 100, link, updated: now, ...(c.id ? { pick: { css: `[data-id="${c.id}"]` } } : {}) });
  };
  const overUnder = (cells, market) => {
    const lines = {};
    for (const c of cells) {
      const n = String(c.name || '').trim();
      if (n.includes('(')) continue; // quarter line
      const l = num(n);
      if (!half(l)) continue;
      lines[l] = lines[l] || {};
      if (/^viac ako/i.test(n)) lines[l].O = c;
      else if (/^menej ako/i.test(n)) lines[l].U = c;
    }
    for (const [l, v] of Object.entries(lines)) if (v.O && v.U) put(market, Number(l), { O: v.O, U: v.U });
  };
  for (const t of m.eventTables || []) {
    const name = String(t.name || '').trim();
    const boxes = t.boxes || [];
    const cells = boxes.flatMap(b => b.cells || []);
    if (name === 'Výsledok zápasu bez remízy') {
      if (cells.length === 2 && String(cells[0].oppNumber) === '11' && String(cells[1].oppNumber) === '15') put('dnb', null, { '1': cells[0], '2': cells[1] });
    } else if (name === 'Výsledok 1. polčasu') {
      const by = Object.fromEntries(cells.map(c => [String(c.oppNumber), c]));
      if (by['10001'] && by['10003'] && by['10005']) put('1h_h2h', null, { '1': by['10001'], X: by['10003'], '2': by['10005'] });
    } else if (name === 'Počet gólov v zápase') overUnder(cells, 'totals');
    else if (name === 'Počet gólov v 1. polčase') overUnder(cells, '1h_totals');
    else if (name === 'Počet gólov tímu v zápase') {
      for (const side of ['home', 'away']) overUnder(boxes.filter(b => sideOf(b.name) === side).flatMap(b => b.cells || []), `${side}_totals`);
    } else if (name === 'Handicap v zápase') {
      for (const b of boxes) {
        const cs = b.cells || [];
        if (cs.length !== 2 || String(cs[0].name || '').includes('(')) continue;
        const hl = num(cs[0].name), al = num(cs[1].name);
        if (half(hl) && Math.abs(hl + al) < 1e-9) put('spreads', hl, { H: cs[0], A: cs[1] });
      }
    } else if (name === 'Každý tím dá v zápase') {
      const b = boxes.find(x => String(x.name || '').trim() === '1 a viac gólov');
      const yes = b && (b.cells || []).find(c => String(c.name).trim() === 'Áno'), no = b && (b.cells || []).find(c => String(c.name).trim() === 'Nie');
      if (yes && no) put('btts', null, { Y: yes, N: no });
    }
  }
  return out;
}

// Chance answers HTTP 429 to detail requests even at 1 per 2.5 s, but it shows the same matches with
// the same ids and the same prices as Tipsport: its extra markets are Tipsport's details, re-labelled.
const queues = {};
function mirror(fromBook, toBook) {
  return async (settings, links, starts = new Map()) => {
    const q = queues[fromBook];
    const out = new Map();
    if (!q) return out;
    for (const link of links) {
      const id = (/\/(\d+)(?:[/?#]|$)/.exec(link) || [])[1];
      const c = id && q.cache.get(id);
      if (c && Date.now() - c.at < require('./detailQueue').ttlFor(starts.get(link), 170000)) out.set(link, c.odds.map(o => ({ ...o, book: toBook, link })));
    }
    return out;
  };
}

// One queue per book (each has its own window and its own pace).
function queueFor(book, pageOf) {
  return (queues[book] = createDetailQueue({
    name: book,
    keyOf: link => (/\/(\d+)(?:[/?#]|$)/.exec(link) || [])[1] || null,
    fetchOne: async (settings, id) => {
      const page = await pageOf(settings.bookmakers[book].port);
      return page.evaluate(async (id) => {
        const r = await fetch(`/rest/offer/v3/matches/${id}?fromResults=false`, { headers: { accept: 'application/json', platform: 'WEB' } });
        if (!r.ok) return { error: `HTTP ${r.status}`, status: r.status };
        try { return await r.json(); } catch { return { error: 'non-JSON response' }; }
      }, id);
    },
    parse: (j, link) => parseDetail(j, book, link),
    gapMs: 2500, // 1 per second got HTTP 429 (2026-11-13) on top of the regular offer reads
  }));
}

module.exports = { parseDetail, queueFor, mirror };
