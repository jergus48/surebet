// Auto login. When the login check (balances.js) or a bet finds a book logged out, the bot logs in by
// itself in that book's own window with the username and password you saved for it, then tells you on
// Telegram. A code the site texts you (Niké SMS) is asked for on Telegram: reply with the digits.
//
// Logins are kept in the macOS Keychain (service "surebet-<book>", account = username), written
// through `security -i` on stdin so the password is never on a command line, never in settings.json,
// never in git, and never sent back by the dashboard. Env SUREBET_LOGIN_<BOOK>_USER / _PASS work too.
//
// It never forces its way in: at most MAX_FAILS failed logins per book per FAIL_WINDOW_MS (a wrong
// password must not lock the account), and a site that says you reached a time / deposit limit or
// excluded yourself is never logged back in.
const { execFile } = require('child_process');
const chrome = require('./chrome');
const sites = require('./sites');
const db = require('../db');
const notify = require('../notify');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERVICE = book => `surebet-${book}`;

// Login form per book, read from the logged-out sites on 2026-11-14 (private tab in each window):
//   open: the header button that shows the form (none on Synottip: the form is in the header)
//   user / pass / submit: the form's fields and its submit button
//   code: Niké may ask for a code it texts you after the password
const FORMS = {
  tipsport: { open: '[data-atid="headerLogin"]', user: '[data-atid="txt-username"]', pass: '[data-atid="txt-password"]', submit: '[data-atid="btn-submit"]' },
  chance: { open: '[data-atid="headerLogin"]', user: '[data-atid="txt-username"]', pass: '[data-atid="txt-password"]', submit: '[data-atid="btn-submit"]' },
  nike: { open: '[data-atid="header-login-button"]', user: '#userName', pass: '#password', submit: '[data-atid="login-submit"]', code: true },
  doxxbet: { open: 'a[data-uk-modal]', openText: /prihl/i, user: '#modal-login-email', pass: '#modal-login-password', submit: '#login-submit-button' },
  tipos: { open: 'a[data-target="header__login-form__container"]', user: '[data-test-role="login__user-name"]', pass: '[data-test-role="login__password"]', submit: '[data-test-role="login__submit"]' },
  synottip: { open: null, user: '[data-test-role="login__user-name"]', pass: '[data-test-role="login__password"]', submit: '[data-test-role="login__submit"]' },
};
const supported = book => !!FORMS[book];

// ---- Keychain ----
const run = (cmd, args, input) => new Promise(res => {
  const p = execFile(cmd, args, { timeout: 15000 }, (e, out, err) => res({ ok: !e, out: String(out || ''), err: String(err || '') }));
  if (input != null) { p.stdin.end(input); }
});
const q = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function get(book) {
  const env = k => process.env[`SUREBET_LOGIN_${book.toUpperCase()}_${k}`];
  if (env('USER') && env('PASS')) return { user: env('USER'), pass: env('PASS'), from: 'env' };
  if (process.platform !== 'darwin') return null;
  const attrs = await run('security', ['find-generic-password', '-s', SERVICE(book)]);
  if (!attrs.ok) return null;
  const m = /"acct"<blob>="(.*)"\s*$/m.exec(attrs.out);
  const pw = await run('security', ['find-generic-password', '-s', SERVICE(book), '-w']);
  if (!m || !pw.ok) return null;
  return { user: m[1], pass: pw.out.replace(/\n$/, ''), from: 'keychain' };
}

async function set(book, user, pass) {
  if (!supported(book)) throw new Error(`${book}: auto login is not set up for this site`);
  if (!user || !pass) throw new Error('username and password are both needed');
  if (/[\r\n]/.test(user + pass)) throw new Error('no line breaks in the username or password');
  if (process.platform !== 'darwin') throw new Error('saving logins needs the macOS Keychain (use env SUREBET_LOGIN_<BOOK>_USER / _PASS)');
  await run('security', ['delete-generic-password', '-s', SERVICE(book)]); // a changed username replaces the old item
  const r = await run('security', ['-i'], `add-generic-password -U -s ${q(SERVICE(book))} -a ${q(user)} -l ${q(`Surebet bot: ${book}`)} -w ${q(pass)}\n`);
  const back = await get(book);
  if (!r.ok || !back || back.user !== user || back.pass !== pass) throw new Error(`could not save to the Keychain ${r.err.trim()}`);
  fails.delete(book);
  unpause(book);
  db.log('info', `auto login: login saved for ${book} (${user})`);
  return true;
}

async function remove(book) {
  await run('security', ['delete-generic-password', '-s', SERVICE(book)]);
  db.log('info', `auto login: login removed for ${book}`);
}

// For the dashboard: who is saved per book (never the password).
async function status(books) {
  const out = {};
  for (const b of books) {
    const c = supported(b) ? await get(b) : null;
    const f = fails.get(b);
    out[b] = { supported: supported(b), user: c ? c.user : null, from: c ? c.from : null, last: last.get(b) || null, blocked: !!(pauses[b] || (f && f.length >= MAX_FAILS)), paused: pauses[b] || null };
  }
  return out;
}

// ---- Telegram code ----
// Waits for your next Telegram message to the bot holding a 4-8 digit code (sent after `since`).
async function waitForCode(settings, since, timeoutMs = 5 * 60e3) {
  if (!settings.telegramBotToken || !settings.telegramChatId) return null;
  const api = (m, qs) => fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/${m}?${qs}`).then(r => r.json());
  let offset = 0;
  // skip everything already there
  const head = await api('getUpdates', 'offset=-1&timeout=0').catch(() => null);
  if (head && head.ok && head.result.length) offset = head.result[head.result.length - 1].update_id + 1;
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; ) {
    const r = await api('getUpdates', `offset=${offset}&timeout=20`).catch(() => null);
    if (!r || !r.ok) { await sleep(3000); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || String(m.chat.id) !== String(settings.telegramChatId) || m.date * 1000 < since - 5000) continue;
      const code = /\b(\d{4,8})\b/.exec(m.text || '');
      if (code) return code[1];
    }
  }
  return null;
}

// ---- Login ----
const MAX_FAILS = 2, FAIL_WINDOW_MS = 6 * 3600e3;
const fails = new Map(); // book -> [ms of failed logins] (technical failures: timeouts, form not loaded)
// Paused books: the site refused the login (wrong password) or mentioned a limit. Never retried until a
// login is saved again: the same refused password can only lock the account (Synottip, 2026-11-14).
// Kept in data/ so a restart does not try again.
const PAUSE_FILE = require('path').join(require('../config').DATA_DIR, 'login-pauses.json');
const pauses = (() => { try { return JSON.parse(require('fs').readFileSync(PAUSE_FILE, 'utf8')); } catch { return {}; } })();
function pause(book, why) {
  pauses[book] = { at: Date.now(), why };
  try { require('fs').writeFileSync(PAUSE_FILE, JSON.stringify(pauses, null, 2)); } catch { }
}
function unpause(book) {
  delete pauses[book];
  try { require('fs').writeFileSync(PAUSE_FILE, JSON.stringify(pauses, null, 2)); } catch { }
}
const last = new Map();  // book -> { at, ok, why }
const running = new Set();
const LIMIT_RE = /limit|sebaobmedz|samovyl[uú][cč]|vyl[uú][cč]en|self.?exclu|pozastaven/i;
const WRONG_RE = /ne[uú]spe[sš]n|nespr[aá]vn|neplatn|chybn|invalid|incorrect|zl[eé] (meno|heslo)/i;

function canTry(book, now = Date.now()) {
  if (pauses[book]) return false;
  const f = (fails.get(book) || []).filter(t => now - t < FAIL_WINDOW_MS);
  fails.set(book, f);
  return f.length < MAX_FAILS;
}

// Text near the login form (error messages appear there), first 300 characters.
const formText = (page, sel) => page.$eval(sel, el => {
  let n = el;
  for (let i = 0; i < 8 && n.parentElement && (n.innerText || '').length < 300; i++) n = n.parentElement;
  return (n.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
}).catch(() => '');

async function visible(page, sel) {
  for (const h of await page.$$(sel)) if (await h.boundingBox()) return h;
  return null;
}
// Types into a field and checks it holds exactly that (a re-rendering form can drop keys): up to 3 tries.
async function typeInto(page, h, text) {
  for (let i = 0; i < 3; i++) {
    await h.click({ clickCount: 3 });
    await h.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.keyboard.type(text, { delay: 35 });
    if ((await h.evaluate(el => el.value)) === text) return;
    await sleep(700);
  }
  throw new Error('a login field did not keep what was typed');
}

// Clicks the innermost visible element whose whole text matches re (or the button / label around it).
// -> true when something was clicked.
async function clickText(page, re) {
  const h = await page.evaluateHandle(src => {
    const re = new RegExp(src, 'i');
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = [...document.querySelectorAll('button, a, label, [role=button], [role=radio], li, div, span, p')].filter(e => vis(e) && re.test((e.innerText || '').trim()));
    const inner = all.filter(e => !all.some(o => o !== e && e.contains(o)));
    const el = inner[0];
    return el ? (el.closest('button, a, label, [role=button], [role=radio]') || el) : null;
  }, re.source).catch(() => null);
  const el = h && h.asElement();
  if (!el) return false;
  await el.evaluate(e => { e.scrollIntoView({ block: 'center' }); e.click(); }).catch(() => { });
  return true;
}

// A field that asks for a code the site texted: a visible input that is not the login form's own.
async function codeField(page, form) {
  // one box per digit (4-8 inputs that take one character each): typing into the first moves on by itself
  const boxes = [];
  for (const h of await page.$$('input')) if ((await h.boundingBox()) && (await h.evaluate(el => el.maxLength === 1 && /text|tel|number|password/.test(el.type)))) boxes.push(h);
  if (boxes.length >= 4 && boxes.length <= 8) return { boxes };
  for (const h of await page.$$('input')) {
    if (!(await h.boundingBox())) continue;
    const info = await h.evaluate(el => ({ type: el.type, ac: el.autocomplete || '', name: `${el.name} ${el.id} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`, max: el.maxLength }));
    if (!/text|tel|number|password/.test(info.type)) continue;
    if (await h.evaluate((el, s) => el.matches(s), `${form.user}, ${form.pass}`)) continue;
    if (/one-time-code/.test(info.ac) || /k[oó]d|code|sms|otp|pin/i.test(info.name) || (info.max > 3 && info.max <= 8)) return h;
  }
  return null;
}

// Logs one book in (in its betting tab). -> { ok, why }
// opts.page: log in on this page instead of the betting tab (a private tab in tests); it is left as is.
async function loginOnce(settings, book, cred, opts = {}) {
  const bk = settings.bookmakers[book];
  const site = sites.load()[book];
  const form = FORMS[book];
  const S = site.selectors;
  const page = opts.page || await chrome.betPage(bk.port);
  // In front: a background tab paints no frames, and clicks wait for one (the login froze for 60 s).
  await page.bringToFront().catch(() => { });
  const isIn = () => page.$(S.loggedIn).then(h => !!h).catch(() => false);
  // A browser alert / confirm box freezes the page for every call until it is answered.
  let dialogText = null;
  const onDialog = d => { dialogText = d.message(); d.dismiss().catch(() => { }); };
  page.on('dialog', onDialog);
  try {
    await page.goto(site.home, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (await page.waitForSelector(S.loggedIn, { timeout: 8000 }).catch(() => null)) return { ok: true, why: 'already logged in' };
    // the form
    let user = await visible(page, form.user);
    if (!user && form.open) {
      for (const h of await page.$$(form.open)) {
        if (!(await h.boundingBox())) continue;
        if (form.openText && !form.openText.test(await h.evaluate(el => el.innerText || ''))) continue;
        await h.evaluate(el => el.click());
        break;
      }
      user = await page.waitForSelector(form.user, { visible: true, timeout: 10000 }).catch(() => null);
    }
    if (!user) return { ok: false, why: 'login form not found on the page' };
    await typeInto(page, user, cred.user);
    const pass = await visible(page, form.pass);
    if (!pass) return { ok: false, why: 'password field not found' };
    await typeInto(page, pass, cred.pass);
    const submit = await visible(page, form.submit);
    // Submitting can navigate away at once (Tipos goes through its login server): that is not an error.
    const bodyText = () => page.evaluate(() => document.body.innerText).catch(() => '');
    const before = (await bodyText()).match(new RegExp(WRONG_RE.source, 'gi')) || [];
    if (submit) await submit.evaluate(el => el.click()).catch(() => { }); else await page.keyboard.press('Enter').catch(() => { });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { });
    // logged in, a code asked for, or an error
    let codeAsked = false, smsChosen = false, nudged = false;
    for (let t0 = Date.now(); Date.now() - t0 < 30000; await sleep(1000)) {
      if (await isIn()) return { ok: true };
      if (LIMIT_RE.test(await formText(page, form.submit)) && !(await isIn())) return { ok: false, limit: true, why: `the site mentions a limit: "${(await formText(page, form.submit)).slice(0, 120)}"` };
      if (form.code && !codeAsked) {
        // Niké: "Overenie totožnosti ... Vyberte si spôsob vášho overenia: SMS overenie / Overenie GRID kartou"
        // (2026-11-14). The SMS way is chosen; the code it texts you is asked for on Telegram.
        if (!smsChosen && (await clickText(page, /^sms overenie$/i))) {
          smsChosen = true;
          db.log('info', `auto login: ${book} asks to verify, SMS chosen`);
          await sleep(2500);
        }
        const f = await codeField(page, form).catch(() => null);
        // after choosing SMS some sites want one more "send / continue" before the code box shows
        if (!f && smsChosen && !nudged && Date.now() - t0 > 5000) { nudged = true; await clickText(page, /^(odosla[tť]|posla[tť]|pokra[cč]ova[tť]|[dď]alej|potvrdi[tť]|overi[tť])( k[oó]d| sms)?$/i); continue; }
        if (f) {
          codeAsked = true;
          const since = Date.now();
          notify.send(settings, `🔑 ${notify.bookName(book)} texted you a login code. Reply here with the code (just the digits) within 5 minutes.`).catch(() => { });
          const code = await waitForCode(settings, since);
          if (!code) return { ok: false, why: 'no code received on Telegram within 5 minutes' };
          if (f.boxes) { await f.boxes[0].click(); await page.keyboard.type(code, { delay: 120 }); } else await typeInto(page, f, code);
          await sleep(800);
          if (!(await isIn())) {
            if (!(await clickText(page, /^(potvrdi[tť]|overi[tť]|prihl[aá]si[tť]( sa)?|odosla[tť]|pokra[cč]ova[tť]|[dď]alej|confirm|submit)$/i))) await page.keyboard.press('Enter').catch(() => { });
          }
          t0 = Date.now(); // 30 s more for the site to log in after the code
          continue;
        }
      }
      if (dialogText && WRONG_RE.test(dialogText)) return { ok: false, refused: true, why: `the site refused the login: "${dialogText.slice(0, 120)}"` };
      const now = (await bodyText()).replace(/\s+/g, ' ');
      const hits = now.match(new RegExp(WRONG_RE.source, 'gi')) || [];
      if (hits.length > before.length && /heslo|meno|password|login|prihl/i.test(now)) {
        const i = now.search(WRONG_RE);
        return { ok: false, refused: true, why: `the site refused the login: "${now.slice(Math.max(0, i - 20), i + 90).trim()}"` };
      }
    }
    return { ok: (await isIn()), why: 'no account shown 30 s after submitting' };
  } finally {
    page.off('dialog', onDialog);
    if (!opts.page) {
      await page.goto('about:blank').catch(() => { });
      await chrome.showSite(bk.port, site.domain).catch(() => { });
    }
  }
}

async function reloadSiteTabs(settings, book) {
  const site = sites.load()[book];
  const browser = await chrome.connect(settings.bookmakers[book].port);
  for (const p of await browser.pages()) {
    if (site.domain.test(p.url()) && !chrome.isBetPage(p)) await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
  }
}

// Called when a book is found logged out. -> 'ok' | 'no-login' | 'blocked' | 'failed' | 'busy'
async function auto(settings, book) {
  if (!supported(book)) return 'no-login';
  const cred = await get(book);
  if (!cred) return 'no-login';
  if (!canTry(book)) return 'blocked';
  if (running.has(book)) return 'busy';
  running.add(book);
  try {
    const r = await require('./index').withBook(book, () => loginOnce(settings, book, cred));
    if (r === undefined) return 'busy'; // a bet is using the window: the next check tries again
    last.set(book, { at: Date.now(), ok: r.ok, why: r.why || null });
    if (r.ok) {
      fails.delete(book);
      // The site tab still shows the old logged-out header (and some readers hold the old session):
      // reload it so the window shows the account (DOXXbet showed "Prihlásiť" after a re-login).
      if (r.why !== 'already logged in') await reloadSiteTabs(settings, book).catch(() => { });
      db.log('info', `auto login: ${book} logged in${r.why ? ` (${r.why})` : ''}`);
      return 'ok';
    }
    // refused (wrong login) or a limit you set: paused until a login is saved again; else one more try later
    if (r.refused || r.limit) pause(book, r.why); else fails.set(book, [...(fails.get(book) || []), Date.now()]);
    db.log('warn', `auto login: ${book} failed: ${r.why}`);
    notify.send(settings, `❌ ${notify.bookName(book)}: auto login failed (${r.why}).${canTry(book) ? ' It tries once more at the next check.' : r.refused ? ' Check the login saved in Settings > Auto login (no more tries until it is saved again), and log in by hand.' : ' No more tries for now: log in by hand in its window.'}`).catch(() => { });
    return 'failed';
  } catch (e) {
    if (chrome.isTimeout(e)) await chrome.dropBetPage(settings.bookmakers[book].port).catch(() => { });
    last.set(book, { at: Date.now(), ok: false, why: e.message });
    fails.set(book, [...(fails.get(book) || []), Date.now()]);
    db.log('warn', `auto login: ${book}: ${e.message}`);
    return 'failed';
  } finally {
    running.delete(book);
  }
}

module.exports = { pause, loginOnce, FORMS, supported, get, set, remove, status, auto, canTry, waitForCode, MAX_FAILS };
