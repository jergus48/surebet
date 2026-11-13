// One debug Chrome per bookmaker, same pattern as genScript:
// each book has its OWN --remote-debugging-port and its OWN persistent
// --user-data-dir, so the login you do by hand once stays. The bot never sees
// or stores your bookmaker passwords; it only drives the already-logged-in window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const PROFILE_ROOT = process.env.SUREBET_PROFILE_ROOT || path.join(os.homedir(), 'surebet-profiles');

function profileDir(bookKey) { return path.join(PROFILE_ROOT, `chrome-${bookKey}`); }

function findChromeExe() {
  const cands = process.platform === 'win32'
    ? [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  if (process.env.CHROME_PATH) cands.unshift(process.env.CHROME_PATH);
  return cands.find(p => p && fs.existsSync(p)) || null;
}

// Optional proxy for ONE bookmaker's window (settings.bookmakers.<book>.proxy, e.g. a North Macedonia
// exit for Megawin): "http://host:port", "https://host:port" or "socks5://host:port". No password in
// the address: if the proxy asks for one, Chrome shows its own sign-in box and you type it there.
// Every other window keeps the normal connection. WebRTC is kept from bypassing the proxy.
const PROXY_RE = /^(https?|socks5):\/\/[a-z0-9.-]+:\d{2,5}$/i;
function proxyArgs(bookKey) {
  let proxy;
  try { proxy = require('../config').load().bookmakers[bookKey]?.proxy; } catch { return []; }
  if (!proxy) return [];
  if (!PROXY_RE.test(proxy)) throw new Error(`${bookKey}: proxy "${proxy}" is not scheme://host:port (http, https or socks5, no password in it)`);
  return [`--proxy-server=${proxy}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
}

// Bot windows run without extensions: a profile signed in to Chrome pulls in every synced extension
// (ad blockers, site blockers, VPNs), and those blocked Cloudflare's check on Stake (white page,
// ERR_BLOCKED_BY_CLIENT, 2026-11-13). settings.bookmakers.<book>.extensions = true keeps them (e.g.
// Megawin with a VPN extension).
// extensions: true = all the profile's extensions; ["<extension id>", ...] = only those (e.g. the VPN,
// without the synced ad/site blockers that break Cloudflare checks); anything else = none.
function extensionArgs(bookKey) {
  let on = false;
  try { on = require('../config').load().bookmakers[bookKey]?.extensions; } catch { }
  if (on === true) return [];
  if (Array.isArray(on) && on.length) {
    const dirs = on.map(id => {
      const base = path.join(profileDir(bookKey), 'Default', 'Extensions', String(id).replace(/[^a-p]/g, ''));
      const ver = fs.existsSync(base) ? fs.readdirSync(base).sort().pop() : null;
      return ver ? path.join(base, ver) : null;
    }).filter(Boolean);
    if (dirs.length) return [`--disable-extensions-except=${dirs.join(',')}`, `--load-extension=${dirs.join(',')}`];
  }
  return ['--disable-extensions'];
}

function launchArgs(port, bookKey) {
  return [
    ...proxyArgs(bookKey),
    ...extensionArgs(bookKey),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir(bookKey)}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check',
    '--hide-crash-restore-bubble', // no "Restore pages?" popup after an unclean shutdown
    '--disable-features=Translate', // auto-translate rewrites names, prices and the page structure the bot reads
  ];
}

// Copy-paste command shown in the UI, for launching by hand.
function launchCommand(port, bookKey) {
  const exe = findChromeExe() || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
  return `"${exe}" ` + launchArgs(port, bookKey).map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');
}

async function isUp(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}

async function launch(port, bookKey, openUrl) {
  if (await isUp(port)) return true;
  const exe = findChromeExe();
  if (!exe) throw new Error('Chrome not found; set CHROME_PATH or launch it with the command from Nastavenia');
  fs.mkdirSync(profileDir(bookKey), { recursive: true });
  const args = launchArgs(port, bookKey);
  if (openUrl) args.push(openUrl);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await isUp(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Chrome for ${bookKey} did not open debug port ${port}. Another Chrome may hold that profile.`);
}

const browsers = new Map();
async function connect(port) {
  const b = browsers.get(port);
  if (b && b.connected) return b;
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 60000 });
  browser.on('disconnected', () => browsers.delete(port));
  browsers.set(port, browser);
  return browser;
}

// Reuse a tab already on the bookmaker's domain, else open one.
async function bookPage(port, domainRe) {
  const browser = await connect(port);
  let pages = await browser.pages();
  // A just-launched window may still be on about:blank; give it a moment.
  for (let i = 0; i < 10 && !pages.some(p => domainRe.test(p.url())); i++) {
    await new Promise(r => setTimeout(r, 300));
    pages = await browser.pages();
  }
  // The reading tab is never the betting tab, and an error page only if nothing else is left.
  const onSite = pages.filter(p => domainRe.test(p.url()) && ![...betTabs.values()].includes(p));
  return onSite.find(p => !/\/Error\//i.test(p.url())) || onSite[0]
    || pages.find(p => /^(about:blank|chrome:\/\/newtab)/.test(p.url()))
    || browser.newPage();
}

// A tab whose renderer froze answers no CDP call (every evaluate times out after 60 s, and
// puppeteer cannot even attach to it). Through the window's plain HTTP debug endpoints, which
// still work, open a fresh tab on the same address and close the frozen one. Cookies live in
// the profile, so the login stays. The betting tab is never replaced. At most once per 10 min.
const lastReplace = new Map();
async function replaceFrozenTab(port, domainRe) {
  if (Date.now() - (lastReplace.get(port) || 0) < 10 * 60 * 1000) return false;
  lastReplace.set(port, Date.now());
  const base = `http://127.0.0.1:${port}/json`;
  const list = await (await fetch(`${base}/list`, { signal: AbortSignal.timeout(5000) })).json();
  const betIds = new Set([...betTabs.entries()].filter(([p, pg]) => p === port && !pg.isClosed()).map(([, pg]) => pg.target()._targetId));
  const old = list.find(t => t.type === 'page' && domainRe.test(t.url) && !betIds.has(t.id));
  if (!old) return false;
  await fetch(`${base}/new?${old.url}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  await fetch(`${base}/close/${old.id}`, { signal: AbortSignal.timeout(5000) });
  return old.url;
}
const isTimeout = e => /timed out/i.test(e && e.message || '');

// Dedicated betting tab per window, separate from the tab the scanner reads,
// so placing a bet never fights with a scan reload.
const betTabs = new Map();
async function betPage(port) {
  const p = betTabs.get(port);
  if (p && !p.isClosed()) return p;
  const browser = await connect(port);
  const page = await browser.newPage();
  betTabs.set(port, page);
  return page;
}

const isBetPage = page => [...betTabs.values()].includes(page);

module.exports = { findChromeExe, launch, launchCommand, launchArgs, isUp, connect, bookPage, betPage, isBetPage, profileDir, replaceFrozenTab, isTimeout };
