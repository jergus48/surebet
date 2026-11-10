// Turns a picked element (plus its ancestors, as described by picker.js) into CSS
// selectors that survive site deploys: data-* attributes, readable ids/classes and
// roles first, never hashed CSS-in-JS class names like "sc-b8dd6735-3" or "iZFHKG".

const STATE = /^(is-|has-)?(active|selected|hover|hovered|focus|focused|disabled|enabled|open|opened|closed|visible|hidden|loading|checked|current|odd|even|first|last|new)$/i;
const CSS_IN_JS = /(^|[-_])(sc|css|jsx|emotion|styled|chakra|mui|makestyles|tw)[-_]/i;
const MIXED_RUN = /(?=[a-z\d]*\d)(?=[a-z\d]*[a-z])[a-z\d]{5,}/i; // "b8dd6735", "x7k2p"
const RANDOM_CASE = /[a-z][A-Z]{2,}|^[A-Z]{5,}$/; // "iZFHKG", "KQWER"
const TRANSITION = /(^|-)(enter|exit|appear)(ed|ing)?(-(active|done))?$|-(active|done)$/i; // "t-doubleBlink-exited-active"
// styled-components: "ClientMenu-styled__AccountState-sc-25b23cbb-4". The component name before
// "-sc-" survives deploys; only the hash after it changes.
const STYLED = /^([A-Za-z][\w]*-styled__[A-Za-z][\w]*)-sc-[a-z0-9]+-\d+$/i;

function stableToken(t) {
  if (!t || t.length < 2 || t.length > 40) return false;
  if (STATE.test(t) || CSS_IN_JS.test(t) || RANDOM_CASE.test(t) || TRANSITION.test(t)) return false;
  return !MIXED_RUN.test(t);
}

const styledNames = classes => (classes || []).map(c => (STYLED.exec(c) || [])[1]).filter(Boolean);

function stableId(id) {
  return stableToken(id) && !/\d{3,}/.test(id);
}

// Attribute values that name a role, not one particular match/odd.
function stableValue(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 40 && !/\d{3,}/.test(v) && !MIXED_RUN.test(v) && !/[\s"]{2}/.test(v);
}

const cssEsc = s => String(s).replace(/([^\w-])/g, '\\$1');
const q = v => JSON.stringify(String(v));
const ATTR = /^(data-[\w-]+|aria-label|name|role|type|placeholder)$/;

// Selectors for one node. many = the selector must match every element of this kind
// (all odds buttons), so per-item values are dropped and only attribute presence is used.
function own(node, many) {
  const out = [];
  const tag = node.tag;
  if (!many && node.id && stableId(node.id)) out.push(`#${cssEsc(node.id)}`);
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (!ATTR.test(k)) continue;
    if (k.startsWith('data-')) {
      if (!many && stableValue(v)) out.push(`[${k}=${q(v)}]`);
      if (many && stableValue(v)) out.push(`${tag}[${k}=${q(v)}]`);
      // "oddButton-2737395469": the name part is shared by every button of that kind
      const pre = /^([A-Za-z][\w]*[-_])\d+$/.exec(v);
      if (pre) out.push(`${tag}[${k}^=${q(pre[1])}]`);
      // "player-account__balance player-account__balance--money": match one word of the list
      if (/\s/.test(v.trim())) {
        for (const w of v.trim().split(/\s+/).filter(stableToken).reverse()) out.push(`${tag}[${k}~=${q(w)}]`);
      }
      out.push(`${tag}[${k}]`);
    } else if (k === 'aria-label' || k === 'placeholder') {
      if (!many && stableValue(v)) out.push(`${tag}[${k}=${q(v)}]`);
    } else if (stableValue(v)) {
      out.push(`${tag}[${k}=${q(v)}]`);
    }
  }
  const cls = (node.classes || []).filter(stableToken);
  for (const c of cls) out.push(`${tag}.${cssEsc(c)}`);
  for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) out.push(`${tag}.${cssEsc(cls[i])}.${cssEsc(cls[j])}`);
  for (const n of styledNames(node.classes)) out.push(`${tag}[class*=${q(n + '-sc-')}]`);
  return out;
}

// Anchors on an ancestor, used as "anchor descendant".
function anchor(node) {
  const out = [];
  if (node.id && stableId(node.id)) out.push(`#${cssEsc(node.id)}`);
  for (const [k, v] of Object.entries(node.attrs || {})) {
    if (k.startsWith('data-') && stableValue(v)) out.push(`[${k}=${q(v)}]`);
    else if (k === 'role' && stableValue(v)) out.push(`[role=${q(v)}]`);
  }
  for (const c of (node.classes || []).filter(stableToken)) out.push(`.${cssEsc(c)}`);
  for (const n of styledNames(node.classes)) out.push(`[class*=${q(n + '-sc-')}]`);
  if (node.tag === 'header' || node.tag === 'nav' || node.tag === 'aside') out.push(node.tag);
  return out;
}

// chain[0] = picked element, chain[1..] = its ancestors. Most specific first.
function candidates(chain, { many = false } = {}) {
  const self = chain[0];
  const mine = own(self, many);
  const out = [...mine];
  // A click often lands on the text inside the real button: try the button itself (up to 3 levels).
  for (let i = 1; i <= 3 && i < chain.length; i++) out.push(...own(chain[i], many));
  const simple = [...mine.slice(0, 4), self.tag];
  for (let i = 1; i < chain.length; i++) {
    for (const a of anchor(chain[i]).slice(0, 3)) for (const s of simple) out.push(`${a} ${s}`);
  }
  return [...new Set(out)];
}

module.exports = { stableToken, stableId, stableValue, candidates };
