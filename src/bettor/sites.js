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
    // Calibrated 2026-11-10 on a logged-in tipsport.sk account: filled a real match slip
    // (price, stake, slip odds) without placing. Rerun Calibrate if a step stops working.
    selectors: {
      loggedIn: 'span[class*="ClientMenu-styled__AccountState-sc-"]', // header balance, only when logged in
      balance: 'span[class*="ClientMenu-styled__AccountState-sc-"]',
      oddsButton: '[class*="BetButton-styled__BetButton-sc-"]', // list and match pages
      stakeInput: '[data-atid="txtAmountPaid"]',
      slipOdds: 'span.font-12sr.text-primary',
      placeButton: 'button[data-atid="btn-betTicket"]', // "Staviť x €"
      placedConfirm: null, // confirmed by the balance dropping instead
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
// Tipos and Synottip run on the same platform: same slip markup, own balance markup.
// Calibrated 2026-11-10 on logged-in accounts: filled real match slips (price, stake, slip odds)
// without placing. Place is "PODAŤ"; the "PREPOČÍTAŤ" (recalculate) button next to it is not used.
const TIPOS_SLIP = {
  oddsButton: 'span.tip-rate',
  stakeInput: '[data-test-role="summary__total-stake"]',
  slipOdds: 'div.tip-rate',
  placeButton: '[data-test-role="ticket-submit"]',
  placedConfirm: null,
};
const TIPOS_BAL = 'span.user-information__total-balance';
const SYNOT_BAL = 'span[data-test-role~="player-account__balance--money"]';
const NIKE_BAL = '[data-atid="infobox-deposit-value"]';
Object.assign(DEFAULTS, {
  fortuna: { home: 'https://www.ifortuna.sk/', domain: /ifortuna\.sk/, search: null, selectors: { ...EMPTY } },
  // Calibrated 2026-11-10 on a logged-in account: filled a real match slip without placing.
  // Two stake boxes exist; te-simple-stake-input is the selection's own, the mini one follows it.
  nike: {
    home: 'https://www.nike.sk/', domain: /nike\.sk/, search: null,
    selectors: {
      ...EMPTY, balance: NIKE_BAL, loggedIn: NIKE_BAL,
      oddsButton: 'span[data-atid="n1-bet-odd"]',
      stakeInput: '[data-atid="te-simple-stake-input"]',
      slipOdds: '[data-atid="te-pick-odds"]',
      placeButton: '[data-atid="te-submit-button"]', // "Staviť x €"
    },
  },
  // Calibrated 2026-11-10 on a logged-in account: filled a real slip without placing. Place is
  // "STAVIŤ TIKET" (not "Uložiť tiket"); it may open a confirmation step, check the first real bet.
  doxxbet: {
    home: 'https://www.doxxbet.sk/sk', domain: /doxxbet\.sk/, search: null,
    selectors: {
      ...EMPTY, balance: '#client-balance', loggedIn: '#client-balance',
      oddsButton: 'span.rate',
      stakeInput: 'input.input--stake',
      slipOdds: 'span.odd--ticket',
      placeButton: 'button[ng-click="tc.preSubmitTicket()"]',
    },
  },
  tipos: { home: 'https://tipkurz.etipos.sk/', domain: /etipos\.sk/, search: null, selectors: { ...TIPOS_SLIP, balance: TIPOS_BAL, loggedIn: TIPOS_BAL } },
  synottip: { home: 'https://www.synottip.sk/', domain: /synottip\.sk/, search: null, selectors: { ...TIPOS_SLIP, balance: SYNOT_BAL, loggedIn: SYNOT_BAL } },
  // Same platform as Tipsport, same selectors (filled a real slip 2026-11-10). Its slip has a
  // "€ / G" switch (G = Goldeny bonus coins) that opens on G: euroToggle flips it to € first,
  // and the bot still refuses any slip whose Place button is not in €.
  chance: {
    home: 'https://www.chance.sk/', domain: /chance\.sk/, search: null,
    selectors: { ...DEFAULTS.tipsport.selectors, euroToggle: '[data-atid="ticketBuilderCurrency-EUR"]' },
  },
  olybet: { home: 'https://www.olybet.lt/', domain: /olybet\.lt/, search: null, selectors: { ...EMPTY } },
  maxbet: { home: 'https://www.maxbet.mk/mk', domain: /maxbet\.mk/, search: null, selectors: { ...EMPTY } },
  mozzart: { home: 'https://www.mozzartbet.mk/mk', domain: /mozzartbet\.mk/, search: null, selectors: { ...EMPTY } },
  // Megawin North Macedonia (Sportinno sportsbook), in denars. Checked 2026-11-10 on a logged-in
  // account: filled a real slip without placing. The stake box is not an input: clicking it opens an
  // on-screen number pad (stakeKeypad). After a pick the slip may sit collapsed at the bottom of the
  // page (slipOpen expands it). Place is "УПЛАТИ x МКД".
  megawin: {
    home: 'https://megawin.mk/', domain: /megawin\.mk/, search: null, currency: 'MKD', stakeKeypad: true,
    // The cookie notice returns on every page load and covers the slip: the bot clicks its X
    // (closes it without accepting).
    closePopups: ['[data-popup-id="cookie_box"] [data-element-type="UIElementPopupClose"]'],
    selectors: {
      ...EMPTY,
      balance: '[data-element-id="money_amount"]', loggedIn: '[data-element-id="money_amount"]',
      oddsButton: '[data-action="selection-select"]',
      stakeInput: '[single-input-field-bet-amount]',
      slipOdds: '[data-item-type="selection"] a p', // one of its lines is the price
      slipOpen: '[minimised-section]',
      placeButton: 'button[single-place-bet-button]',
    },
  },
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
