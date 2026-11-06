// Offline demo feed: random events where Tipsport and Bet365 disagree enough
// to produce an occasional surebet. Lets you test the dashboard, alerts and the
// bet executor flow without spending API credits.
const SPORTS = [
  { sport: 'soccer_demo', title: 'Futbal', league: 'Demo liga', draw: true, teams: ['Slovan', 'Spartak', 'Žilina', 'Košice', 'Dunajská Streda', 'Ružomberok'] },
  { sport: 'tennis_demo', title: 'Tenis', league: 'ATP Demo', draw: false, teams: ['Novak', 'Rafa', 'Carlos', 'Jannik', 'Daniil', 'Alex'] },
  { sport: 'esports_demo', title: 'Esporty', league: 'CS2 Demo', draw: false, teams: ['NAVI', 'FaZe', 'G2', 'Vitality', 'Spirit', 'MOUZ'] },
  { sport: 'icehockey_demo', title: 'Hokej', league: 'Tipos extraliga', draw: true, teams: ['Nitra', 'Zvolen', 'Trenčín', 'Poprad'] },
];
const BOOKS = ['tipsport', 'bet365', 'pinnacle'];

function rnd(a, b) { return a + Math.random() * (b - a); }
function r2(x) { return Math.round(x * 100) / 100; }

// Fair probabilities -> each book applies a margin plus noise.
function priced(probs, margin) {
  return probs.map(p => r2(1 / (p * (1 + margin) * rnd(0.93, 1.04))));
}

let tick = 0;
async function fetchEvents() {
  tick++;
  const now = Date.now();
  const events = [];
  for (const s of SPORTS) {
    for (let i = 0; i + 1 < s.teams.length; i += 2) {
      const home = s.teams[i], away = s.teams[i + 1];
      const id = `${s.sport}-${i}`;
      const start = now + (i - 1) * 3600e3 + (tick % 5) * 60e3;
      const pHome = rnd(0.3, 0.6);
      const pDraw = s.draw ? rnd(0.2, 0.3) : 0;
      const fair = s.draw ? [pHome, pDraw, 1 - pHome - pDraw] : [pHome, 1 - pHome];
      const sels = s.draw ? ['1', 'X', '2'] : ['1', '2'];
      const odds = [];
      for (const book of BOOKS) {
        const prices = priced(fair, book === 'pinnacle' ? 0.025 : 0.06);
        prices.forEach((price, k) => odds.push({ book, market: 'h2h', point: null, sel: sels[k], price, link: null, updated: now }));
        const pOver = rnd(0.4, 0.6);
        const [o, u] = priced([pOver, 1 - pOver], 0.05);
        odds.push({ book, market: 'totals', point: 2.5, sel: 'O', price: o, link: null, updated: now });
        odds.push({ book, market: 'totals', point: 2.5, sel: 'U', price: u, link: null, updated: now });
      }
      events.push({ id, sport: s.sport, sportTitle: s.title, league: s.league, home, away, start, live: start <= now, drawPossible: s.draw, odds });
    }
  }
  return events;
}

module.exports = {
  name: 'mock',
  fetchEvents,
  listSports: async () => SPORTS.map(s => ({ key: s.sport, group: s.title, title: s.league, active: true })),
  estimateCreditsPerHour: () => 0,
  getCredits: () => ({ remaining: null, used: null, last: null }),
};
