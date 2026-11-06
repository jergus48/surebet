// Side-by-side check of the two ways to get one bookmaker's odds:
// its browser window vs Odds-API.io. Runs both once for the same sports,
// pairs the fixtures, and reports coverage, speed and price differences.
const path = require('path');
const fs = require('fs');
const { mergeBooks } = require('./providers/browser/match');
const oddsapiio = require('./providers/oddsapiio');

async function compareBook(s, book, sportKeys) {
  const b = s.bookmakers[book];
  if (!b) throw new Error(`unknown bookmaker ${book}`);
  const file = path.join(__dirname, 'providers', 'browser', `${book}.js`);
  if (!fs.existsSync(file)) throw new Error(`${book}: no browser collector`);
  if (!b.apiName) throw new Error(`${book}: set bookmakers.${book}.apiName (its Odds-API.io name)`);

  const t0 = Date.now();
  const [br, api] = await Promise.all([
    require(file).collect(s, sportKeys).then(r => ({ r, ms: Date.now() - t0 })),
    oddsapiio.collect(s, sportKeys, [book]).then(r => ({ r: r[book] || [], ms: Date.now() - t0 })),
  ]);
  // Tag sources as different "books" so the matcher pairs browser vs api.
  const tag = (list, src) => list.map(e => ({ ...e, book: src, odds: e.odds.map(o => ({ ...o, src })) }));
  const groups = mergeBooks([tag(br.r, 'browser'), tag(api.r, 'api')]);

  let same = 0, diff = 0, sumAbs = 0, priced = 0;
  const samples = [];
  for (const g of groups) {
    for (const sel of ['1', 'X', '2']) {
      const a = g.odds.find(o => o.src === 'browser' && o.market === 'h2h' && o.sel === sel);
      const c = g.odds.find(o => o.src === 'api' && o.market === 'h2h' && o.sel === sel);
      if (!a || !c) continue;
      priced++;
      const d = Math.abs(a.price - c.price);
      sumAbs += d;
      if (d < 0.005) same++; else { diff++; if (samples.length < 10) samples.push(`${g.home}-${g.away} ${sel}: browser ${a.price} vs api ${c.price}`); }
    }
  }
  return {
    book, sports: sportKeys,
    browser: { events: br.r.length, ms: br.ms },
    api: { events: api.r.length, ms: api.ms, requests: oddsapiio.getRate().requests, rateRemaining: oddsapiio.getRate().remaining },
    pairedFixtures: groups.length,
    prices: { compared: priced, identical: same, different: diff, avgAbsDiff: priced ? Math.round((sumAbs / priced) * 1000) / 1000 : null },
    samples,
  };
}

module.exports = { compareBook };
