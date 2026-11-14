// a frozen scan tab is swapped for a fresh one through the plain HTTP debug endpoints
const assert = require('assert');
const http = require('http');
const chrome = require('../src/bettor/chrome');
const calls = [];
const srv = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  if (req.url === '/json/list') return res.end(JSON.stringify([
    { id: 'X1', type: 'iframe', url: 'https://cdn.example/x' },
    { id: 'P1', type: 'page', url: 'https://sport.book.sk/sk/top' },
    { id: 'P2', type: 'page', url: 'https://sport.book.sk/moj-tiket/1' }, // the hung extra tab
  ]));
  res.end('{}');
});
srv.listen(0, '127.0.0.1', async () => {
  try {
    const port = srv.address().port;
    assert.ok(chrome.isTimeout(new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout')));
    assert.ok(!chrome.isTimeout(new Error('HTTP 500')));
    assert.strictEqual(await chrome.replaceFrozenTab(port, /book\.sk/), 'https://sport.book.sk/sk/top');
    assert.deepStrictEqual(calls, ['GET /json/list', 'PUT /json/new?https://sport.book.sk/sk/top', 'GET /json/close/P1', 'GET /json/close/P2']);
    assert.strictEqual(await chrome.replaceFrozenTab(port, /book\.sk/), false); // 10 min cooldown
    console.log('frozen tab tests passed');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { srv.close(); }
});

// per-book proxy: only that window, only scheme://host:port
{
  const assert2 = require('assert');
  const config = require('../src/config');
  const orig = config.load;
  config.load = () => ({ bookmakers: { megawin: { proxy: 'socks5://mk.example.net:1080' }, tipos: {}, bad: { proxy: 'http://user:pw@x:1' } } });
  const c = require('../src/bettor/chrome');
  assert2.ok(c.launchArgs(9332, 'megawin').includes('--proxy-server=socks5://mk.example.net:1080'));
  assert2.ok(!c.launchArgs(9306, 'tipos').some(a => a.startsWith('--proxy-server')));
  assert2.throws(() => c.launchArgs(1, 'bad'), /not scheme:\/\/host:port/);
  config.load = orig;
  console.log('proxy args tests passed');
}
