import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
it('I03 refuses remote endpoints, wrong ports, and redirects before the destination receives bytes', async () => {
  const base = resolve('../../.dsh-dev/deepening');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(resolve(base, 'network-'));
  let unexpected = 0;
  const other = createServer((_req, res) => { unexpected++; res.end('UNEXPECTED'); });
  const server = createServer((req, res) => {
    if (req.url === '/redirect') res.writeHead(302, { location: `http://127.0.0.1:${otherPort}` });
    res.end('OK');
  });
  let otherPort = 0;
  try {
    await new Promise<void>(accept => other.listen(0, '127.0.0.1', accept));
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
    const address = server.address(), otherAddress = other.address();
    if (!address || typeof address === 'string' || !otherAddress || typeof otherAddress === 'string') throw Error('No port');
    otherPort = otherAddress.port;
    const port = address.port;
    const code = `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      assert.equal(await (await fetch('http://127.0.0.1:${port}/')).text(), 'OK');
      assert.throws(() => fetch('https://remote.invalid'), /DP_NETWORK_BLOCKED/);
      assert.throws(() => net.connect({ host: 'remote.invalid', port: 443 }), /DP_NETWORK_BLOCKED/);
      assert.throws(() => net.connect({ host: '127.0.0.1', port: ${otherPort} }), /DP_NETWORK_BLOCKED/);
      await assert.rejects(fetch('http://127.0.0.1:${port}/redirect'));
      console.log('DP_NETWORK_PASS');
    `;
    const receipt = resolve(dir, 'denials.jsonl');
    const result = await promisify(execFile)(process.execPath, ['--input-type=module',
      `--import=${resolve('../../scripts/deepening/network-guard.mjs')}`, '-e', code], {
      timeout: 10000, env: { PATH: process.env.PATH, DP_MOCK_PORT: String(port), DP_NETWORK_RECEIPT: receipt },
    });
    expect(result.stdout.trim()).toBe('DP_NETWORK_PASS');
    expect(unexpected).toBe(0);
    expect((await readFile(receipt, 'utf8')).trim().split('\n')).toHaveLength(3);
  } finally {
    server.closeAllConnections(); other.closeAllConnections();
    await Promise.all([new Promise<void>(accept => server.close(() => accept())),
      new Promise<void>(accept => other.close(() => accept()))]);
    await rm(dir, { recursive: true, force: true });
  }
});
