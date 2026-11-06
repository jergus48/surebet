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

function launchArgs(port, bookKey) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir(bookKey)}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check',
    '--hide-crash-restore-bubble', // no "Restore pages?" popup after an unclean shutdown
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
  return pages.find(p => domainRe.test(p.url()))
    || pages.find(p => /^(about:blank|chrome:\/\/newtab)/.test(p.url()))
    || browser.newPage();
}

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

module.exports = { findChromeExe, launch, launchCommand, isUp, connect, bookPage, betPage, profileDir };
