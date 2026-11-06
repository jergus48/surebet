// Odds providers share one interface:
//   fetchEvents(settings) -> normalized events (see src/arb.js header)
//   listSports(settings)  -> [{ key, group, title, active }]
//   estimateCreditsPerHour(settings), getCredits()
const providers = {
  mock: require('./mock'),
  oddsapi: require('./oddsapi'),
  browser: require('./browser'),
};

function get(name) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown provider "${name}"`);
  return p;
}

module.exports = { get, names: Object.keys(providers) };
