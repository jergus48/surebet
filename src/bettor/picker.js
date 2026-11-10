// Functions that run INSIDE a bookmaker page (page.evaluate) for scripts/calibrate.js.
// The picked element is kept in window.__sbPick between calls.

// Starts the picker: highlight under the mouse, banner with the instruction. The next click
// is recorded. block = swallow that click so the site never sees it (used for Place).
// field = the target is a text box: a click on its wrapper picks the input inside.
function startPick(label, block, field) {
  const old = window.__sbPick;
  if (old && old.cleanup) old.cleanup();
  const st = { done: false, result: null };
  window.__sbPick = st;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:3px solid #ff00c8;background:rgba(255,0,200,.08);transition:all .05s';
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;background:#111;color:#fff;font:600 16px/1.4 sans-serif;padding:10px 14px;border-bottom:3px solid #ff00c8';
  bar.textContent = `Surebet calibration: click ${label}${block ? ' (this click is blocked, nothing happens on the site)' : ''}`;
  document.documentElement.append(box, bar);
  const over = e => { const r = e.target.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
  const describe = e => ({
    tag: e.tagName.toLowerCase(), id: e.id || '', classes: [...e.classList],
    attrs: Object.fromEntries([...e.attributes].filter(a => /^(data-[\w-]+|aria-label|name|role|type|placeholder)$/.test(a.name)).map(a => [a.name, a.value.slice(0, 80)])),
  });
  const swallow = e => { if (!block) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const click = e => {
    swallow(e);
    if (st.done) return;
    let el = e.target;
    if (field && !el.matches('input,textarea,[contenteditable="true"]')) {
      el = el.querySelector('input,textarea,[contenteditable="true"]')
        || (el.parentElement && el.parentElement.querySelector('input,textarea,[contenteditable="true"]')) || el;
    }
    const chain = [];
    for (let n = el; n && n.nodeType === 1 && chain.length < 7; n = n.parentElement) chain.push(describe(n));
    window.__sbPicked = el;
    st.result = { chain, text: (el.innerText || el.value || '').trim().slice(0, 120) };
    st.done = true;
    setTimeout(st.cleanup, 300);
  };
  const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'auxclick', 'submit'];
  st.cleanup = () => {
    removeEventListener('mouseover', over, true);
    removeEventListener('click', click, true);
    for (const t of types) removeEventListener(t, swallow, true);
    box.remove(); bar.remove();
  };
  addEventListener('mouseover', over, true);
  addEventListener('click', click, true);
  for (const t of types) addEventListener(t, swallow, true);
  return true;
}

// null = picker gone (page navigated), false = waiting, object = picked.
function pollPick() {
  const st = window.__sbPick;
  if (!st) return null;
  return st.done ? st.result : false;
}

function stopPick() {
  const st = window.__sbPick;
  if (st && st.cleanup) st.cleanup();
  window.__sbPick = null;
}

// First selector that matches the picked element (or an ancestor up to 3 levels above it).
// many = must match several elements, mostly prices.
function chooseSelector(list, many) {
  const picked = window.__sbPicked;
  if (!picked) return null;
  const visible = n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const isPrice = t => /^\d{1,3}[.,]\d{1,3}$/.test((t || '').trim());
  for (const sel of list) {
    let nodes;
    try { nodes = [...document.querySelectorAll(sel)].filter(visible); } catch { continue; }
    const hit = nodes.find(n => n === picked || (n.contains(picked) && (() => { let d = 0; for (let x = picked; x && x !== n; x = x.parentElement) d++; return d <= 3; })()));
    if (!hit) continue;
    if (!many && nodes.length !== 1) continue;
    if (many) {
      if (nodes.length < 2) continue;
      const share = nodes.filter(n => isPrice(n.innerText)).length / nodes.length;
      if (share < 0.7) continue;
    }
    return { selector: sel, count: nodes.length, text: (hit.innerText || hit.value || '').trim().slice(0, 80) };
  }
  return null;
}

// For --check: what each saved selector finds on the current page.
function inspect(selectors) {
  const out = {};
  for (const [k, sel] of Object.entries(selectors)) {
    if (!sel) { out[k] = { count: 0, missing: true }; continue; }
    try {
      const nodes = [...document.querySelectorAll(sel)];
      out[k] = { count: nodes.length, sample: nodes.slice(0, 3).map(n => (n.innerText || n.value || '').trim().slice(0, 40)) };
    } catch (e) { out[k] = { error: e.message }; }
  }
  return out;
}

module.exports = { startPick, pollPick, stopPick, chooseSelector, inspect };
