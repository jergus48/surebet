// Bet365 In-Play pages (#/IP/B<sport>). Class names are scrambled per deploy, so this reads the
// page's visible text cells in order, the way the page lays them out:
//   league | column headers ("Sieger", "Satz", ...) | home | away | scores | prices | clock | ...
// Rule: a fixture is the LAST two name cells before its numbers; its first `n` prices are the
// match winner (football: 1 X 2 "Endergebnis", others: 2-way "Sieger" / "Sieg"). A price right
// after a line cell ("+14.5", "Ü 187.5") belongs to a handicap or total column and is skipped
// (basketball shows Handicap | Gesamt | Sieg). A fixture shown without prices is skipped.

// Runs INSIDE the page: visible leaf texts in document order.
function leafTexts() {
  const out = [];
  for (const e of document.body.querySelectorAll('*')) {
    if (e.children.length) continue;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const t = (e.textContent || '').trim();
    if (t) out.push(t);
  }
  return out;
}

const PRICE = /^\d{1,3}\.\d{2,3}$/;
const CLOCK = /^\d{1,3}:\d{2}$/;
const LINE = /^[+-]\d+(?:\.\d+)?$|^[ÜUO]\s+\d/;
const isName = t => t.length >= 2 && t.length <= 60 && /[A-Za-zÀ-ž]/.test(t)
  && !/^[ÜUOu]\s+\d/.test(t) && !CLOCK.test(t) && !/^[+\d\s.,:-]+$/.test(t);

// Pure: text cells -> [{ home, away, odds: [..n], clock }]
function parseCells(cells, n) {
  const out = [];
  let names = [];
  let cur = null;
  let prev = '';
  for (const t of cells) {
    const afterLine = LINE.test(prev);
    prev = t;
    if (PRICE.test(t)) {
      if (afterLine) continue;
      if (!cur && names.length >= 2) cur = { home: names[names.length - 2], away: names[names.length - 1], odds: [], clock: null };
      if (cur && cur.odds.length < n) cur.odds.push(Number(t));
      continue;
    }
    if (CLOCK.test(t)) { if (cur && !cur.clock) cur.clock = t; continue; }
    if (isName(t)) {
      if (cur) { if (cur.odds.length === n) out.push(cur); cur = null; names = []; }
      names.push(t);
      continue;
    }
    // scores and other numbers: part of the current fixture header
  }
  if (cur && cur.odds.length === n) out.push(cur);
  return out;
}

// Football clock "63:12" -> estimated kick-off (adds the 15 min half-time break after 45').
function footballStart(clock, now = Date.now()) {
  if (!CLOCK.test(clock || '')) return null;
  const m = Number(clock.split(':')[0]);
  return now - (m + (m > 45 ? 15 : 0)) * 60e3;
}

module.exports = { leafTexts, parseCells, footballStart, isName };
