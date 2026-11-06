// Runs INSIDE the bet365 page (page.evaluate). Bet365 class names are hashed
// and change with deploys, so this finds fixtures by structure instead:
//   odds cell  = leaf element whose text is a decimal price (e.g. "1.22")
//   fixture    = smallest ancestor of an odds cell that holds 2-3 odds cells
//                and exactly two "name-like" text leaves (the teams/players)
//   time       = a leaf like "19:30" inside the fixture
//   date       = nearest preceding header text like "Fr 06 Nov" / "Sat 07 Nov"
// Returns [{ home, away, odds: [n, n, (n)], time, dateLabel, live }]
module.exports = function extractBet365() {
  const PRICE = /^\d{1,3}\.\d{2,3}$/;
  const TIME = /^\d{1,2}:\d{2}$/;
  // Coupon pages show weekday + time in one leaf: "Fr 21:00", "Sat 13:30".
  const DAYTIME = /^([A-Za-zÄÖÜäöü]{2,3})\.? (\d{1,2}:\d{2})$/;
  const DATE = /^[A-Za-zÄÖÜäöüß]{2,4}\.? \d{1,2} [A-Za-zÄÖÜäöüß]{3,5}\.?$/;
  const leafText = e => (e.children.length === 0 ? (e.textContent || '').trim() : '');
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const leaves = root => [...root.querySelectorAll('*')].filter(e => e.children.length === 0 && visible(e));
  const isName = t => t.length >= 2 && t.length <= 60 && /[A-Za-zÀ-ž]/.test(t) && !PRICE.test(t) && !TIME.test(t) && !DAYTIME.test(t)
    && !/^(Statisti[kc]s?|Stats|\d+ ?»?|\+\d+|LIVE|Live|Bet Builder|1|X|2|SP)$/i.test(t);

  const priceCells = leaves(document.body).filter(e => PRICE.test(leafText(e)));
  const fixtures = new Map();
  for (const cell of priceCells) {
    let node = cell.parentElement;
    for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
      const ls = leaves(node);
      const prices = ls.filter(e => PRICE.test(leafText(e)));
      if (prices.length > 3) break; // went past one fixture
      const names = ls.map(leafText).filter(isName);
      if (prices.length >= 2 && names.length >= 2) {
        if (!fixtures.has(node)) {
          // Kick-off time may sit in a sibling: climb while still inside one fixture.
          const isTime = e => TIME.test(leafText(e)) || DAYTIME.test(leafText(e));
          let timeLeaf = ls.find(isTime);
          for (let up = node.parentElement, k = 0; !timeLeaf && up && k < 3; up = up.parentElement, k++) {
            const ul = leaves(up);
            if (ul.filter(e => PRICE.test(leafText(e))).length > prices.length) break;
            timeLeaf = ul.find(isTime);
          }
          const dt = timeLeaf ? leafText(timeLeaf).match(DAYTIME) : null;
          fixtures.set(node, {
            home: names[0], away: names[1],
            odds: prices.map(e => Number(leafText(e))),
            time: dt ? dt[2] : timeLeaf ? leafText(timeLeaf) : null,
            day: dt ? dt[1] : null,
            live: !timeLeaf && /\d+'|\d+-\d+/.test(node.innerText || ''),
            y: node.getBoundingClientRect().top + window.scrollY,
          });
        }
        break;
      }
    }
  }
  // Date headers, in page order, to label fixtures below them.
  const headers = leaves(document.body).filter(e => DATE.test(leafText(e)))
    .map(e => ({ label: leafText(e), y: e.getBoundingClientRect().top + window.scrollY }));
  const out = [];
  for (const f of fixtures.values()) {
    const h = headers.filter(x => x.y <= f.y).pop();
    out.push({ home: f.home, away: f.away, odds: f.odds, time: f.time, day: f.day, dateLabel: h ? h.label : null, live: f.live });
  }
  return out;
};
