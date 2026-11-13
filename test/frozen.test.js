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
  ]));
  res.end('{}');
});
srv.listen(0, '127.0.0.1', async () => {
  try {
    const port = srv.address().port;
    assert.ok(chrome.isTimeout(new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout')));
    assert.ok(!chrome.isTimeout(new Error('HTTP 500')));
    assert.strictEqual(await chrome.replaceFrozenTab(port, /book\.sk/), 'https://sport.book.sk/sk/top');
    assert.deepStrictEqual(calls, ['GET /json/list', 'PUT /json/new?https://sport.book.sk/sk/top', 'GET /json/close/P1']);
    assert.strictEqual(await chrome.replaceFrozenTab(port, /book\.sk/), false); // 10 min cooldown
    console.log('frozen tab tests passed');
  } catch (e) { console.error(e); process.exitCode = 1; } finally { srv.close(); }
});
