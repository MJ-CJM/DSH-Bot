import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { allowLoopbackFixturePort } from './network-guard.mjs';

test('owned fixture ports permit only exact HTTP loopback and close on disposal', async () => {
  const server = createServer((_request, response) => response.end('offline'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, url = `http://127.0.0.1:${port}/`;
  let release;
  try {
    assert.throws(() => fetch(url), /DP_NETWORK_BLOCKED/);
    release = allowLoopbackFixturePort(port);
    assert.equal(await (await fetch(url)).text(), 'offline');
    assert.throws(() => fetch(`https://127.0.0.1:${port}/`), /DP_NETWORK_BLOCKED/);
    assert.throws(() => fetch(`http://localhost:${port}/`), /DP_NETWORK_BLOCKED/);
    assert.throws(() => fetch('https://api.github.com/'), /DP_NETWORK_BLOCKED/);
    release(); release = undefined;
    assert.throws(() => fetch(url), /DP_NETWORK_BLOCKED/);
    assert.throws(() => allowLoopbackFixturePort(0), /Invalid fixture port/);
  } finally {
    release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
