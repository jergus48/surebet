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

// Units each currency is written in. A balance or Place label naming any other unit
// ("2 000 G" on Chance's coin mode, "0.00 NIK" points, € on a denar site) is not that currency.
const UNITS = {
  EUR: { only: /^(€|EUR)$/i, any: /€|EUR/i },
  MKD: { only: /^(МКД|MKD|ДЕН\.?|ДЕНАРИ)$/i, any: /МКД|MKD|ден/i }, // Macedonian denar
};
const unitsOf = cur => UNITS[cur || 'EUR'] || { only: new RegExp(`^${cur}$`, 'i'), any: new RegExp(cur, 'i') };

// "12,50 €" / "0,00 МКД" / "0,00" -> number, or null when the text names another unit.
function parseAmount(t, cur = 'EUR') {
  const s = String(t ?? '');
  const unit = s.replace(/[\d\s.,  ]/g, '');
  if (unit && !unitsOf(cur).only.test(unit)) return null;
  return parseMoney(s);
}
const parseEuro = t => parseAmount(t, 'EUR');

// Place button label after the stake is typed: an amount without the currency means another unit.
function placeLabelIn(label, cur = 'EUR') {
  const s = String(label ?? '');
  return !/\d/.test(s) || unitsOf(cur).any.test(s);
}
const placeLabelInEuro = label => placeLabelIn(label, 'EUR');

// Euro stake -> the site's currency. Denar stakes are whole denars.
function localStake(stake, cur, fx) {
  if (!cur || cur === 'EUR') return stake;
  const rate = Number((fx || {})[cur]);
  if (!(rate > 0)) throw new Error(`no exchange rate for ${cur} (settings fx.${cur})`);
  return Math.round(stake * rate);
}

module.exports = { parseMoney, parsePrice, parseAmount, parseEuro, placeLabelIn, placeLabelInEuro, localStake };
