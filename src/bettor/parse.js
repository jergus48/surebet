// "1 234,56 €" / "€1,234.56" / "12.5" -> number
function parseMoney(t) {
  let x = String(t).replace(/[^\d.,]/g, '');
  if (!x) return null;
  const lc = x.lastIndexOf(','), ld = x.lastIndexOf('.');
  if (lc > -1 && ld > -1) x = lc > ld ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, '');
  else if (lc > -1) x = /,\d{1,2}$/.test(x) ? x.replace(',', '.') : x.replace(/,/g, '');
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function parsePrice(t) { const m = String(t).replace(',', '.').match(/\d+\.\d+/); return m ? Number(m[0]) : null; }

module.exports = { parseMoney, parsePrice };
