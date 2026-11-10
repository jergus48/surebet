// Per-bookmaker site profiles. Selectors are CSS and are NOT verified against
// the live sites yet: bookmakers change markup often and both sites need a
// logged-in session to show the bet slip. Calibrate them once in your own
// logged-in debug Chrome (DevTools > right click element > Copy selector) and
// save overrides in data/sites.json (same shape, merged over these defaults).
//
// Until a site has stakeInput + placeButton, the executor still opens the
// event in that book's own window and tells you the stake to type.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const DEFAULTS = {
  tipsport: {
    home: 'https://www.tipsport.sk/',
    domain: /tipsport\.(sk|cz)/,
    // {q} = url-encoded "home away". Verify this path on the site.
    search: null,
    selectors: {
      loggedIn: null,      // element only present when logged in
      balance: null,       // element showing your account balance (needed for auto)
      oddsButton: null,    // every clickable odds cell; matched by price text
      stakeInput: null,    // stake field on the bet slip
      slipOdds: null,      // odds shown on the slip (re-checked before placing)
      placeButton: null,   // "Podať tiket"
      placedConfirm: null, // element that appears after a successful bet
    },
  },
  bet365: {
    home: 'https://www.bet365.com/',
    domain: /bet365\./,
    search: null,
    selectors: {
      loggedIn: null, balance: null, oddsButton: null, stakeInput: null, slipOdds: null, placeButton: null, placedConfirm: null,
    },
  },
};
// Other Slovak books: open-the-match only until calibrated.
const EMPTY = { loggedIn: null, balance: null, oddsButton: null, stakeInput: null, slipOdds: null, placeButton: null, placedConfirm: null };
Object.assign(DEFAULTS, {
  fortuna: { home: 'https://www.ifortuna.sk/', domain: /ifortuna\.sk/, search: null, selectors: { ...EMPTY } },
  nike: { home: 'https://www.nike.sk/', domain: /nike\.sk/, search: null, selectors: { ...EMPTY } },
  doxxbet: { home: 'https://www.doxxbet.sk/sk', domain: /doxxbet\.sk/, search: null, selectors: { ...EMPTY } },
  tipos: { home: 'https://tipkurz.etipos.sk/', domain: /etipos\.sk/, search: null, selectors: { ...EMPTY } },
  synottip: { home: 'https://www.synottip.sk/', domain: /synottip\.sk/, search: null, selectors: { ...EMPTY } },
  chance: { home: 'https://www.chance.sk/', domain: /chance\.sk/, search: null, selectors: { ...EMPTY } },
  olybet: { home: 'https://www.olybet.lt/', domain: /olybet\.lt/, search: null, selectors: { ...EMPTY } },
  maxbet: { home: 'https://www.maxbet.mk/mk', domain: /maxbet\.mk/, search: null, selectors: { ...EMPTY } },
  mozzart: { home: 'https://www.mozzartbet.mk/mk', domain: /mozzartbet\.mk/, search: null, selectors: { ...EMPTY } },
  inbet: { home: 'https://inbet.com/sports', domain: /inbet\.com/, search: null, selectors: { ...EMPTY } },
  stake: { home: 'https://stake.com/sports/home', domain: /stake\.com/, search: null, selectors: { ...EMPTY } },
});

function load() {
  let over = {};
  try { over = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sites.json'), 'utf8').replace(/^﻿/, '')); } catch { }
  const out = {};
  for (const key of new Set([...Object.keys(DEFAULTS), ...Object.keys(over)])) {
    const d = DEFAULTS[key] || { home: null, domain: /$^/, search: null, selectors: {} };
    const o = over[key] || {};
    out[key] = {
      ...d, ...o,
      domain: o.domain ? new RegExp(o.domain) : d.domain,
      selectors: { ...d.selectors, ...(o.selectors || {}) },
    };
  }
  return out;
}

function calibrated(site) {
  const s = site.selectors || {};
  return !!(s.oddsButton && s.stakeInput && s.placeButton);
}

// Merge new selectors for one book into data/sites.json (scripts/calibrate.js).
function save(book, selectors) {
  const file = path.join(DATA_DIR, 'sites.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { }
  const prev = all[book] || {};
  all[book] = { ...prev, selectors: { ...(prev.selectors || {}), ...selectors }, calibratedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all[book];
}

module.exports = { load, calibrated, save };
