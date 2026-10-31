#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home, 'Use repository DSH_HOME');
assert.deepEqual(process.argv.slice(2), ['--suite', 'spike', '--mock-only']);
const runId = `b1-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const dir = resolve(home, 'deepening', runId);
await mkdir(resolve(dir, 'receipts'), { recursive: true });
const requests = [], commands = [], children = new Set();
const canary = 'DP_B1_SYNTHETIC_CANARY_7d56e3';
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/capture'); assert.equal(req.method, 'POST');
    let body = ''; for await (const chunk of req) body += chunk;
    const record = { index: requests.length + 1, request: JSON.parse(body) };
    requests.push(record);
    await appendFile(resolve(dir, 'requests.jsonl'), `${JSON.stringify(record)}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((accept, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', accept); });
const endpoint = `http://127.0.0.1:${server.address().port}/capture`;
const profile = runId;
const env = {
  PATH: process.env.PATH, HOME: resolve(dir, 'environment-home'), USER: 'synthetic', SHELL: process.env.SHELL,
  DSH_HOME: resolve(dir, 'home'), DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: resolve(dir, 'agents-home'),
  XDG_STATE_HOME: resolve(dir, 'state'), NODE_COMPILE_CACHE: resolve(home, 'node-compile-cache'),
  TMPDIR: resolve(home, 'tmp'), pnpm_config_store_dir: resolve(home, 'pnpm-store'),
  pnpm_config_cache_dir: resolve(home, 'pnpm-cache'), pnpm_config_offline: 'true',
  DP_MOCK_PORT: String(server.address().port), DP_NETWORK_RECEIPT: resolve(dir, 'network-denials.jsonl'),
};
await mkdir(env.HOME, { recursive: true });
const save = (name, data) => writeFile(resolve(dir, name), `${JSON.stringify(data, null, 2)}\n`);
async function command(args, name, live = false) {
  const child = spawn(resolve(root, 'scripts/dsh'), args, {
    cwd: root, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '', closed = false;
  const done = new Promise((accept, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { closed = true; children.delete(child); accept({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 100000);
  try {
    if (live) {
      while (!closed && !/DP_B1_(DONE|FAILED)/.test(output)) await delay(50);
      child.kill('SIGTERM');
    }
    const result = await done;
    await writeFile(resolve(dir, `${name}.log`), output.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[redacted]'));
    commands.push({ args, name, ...result });
    assert.equal(result.code, 0, `see ${name}.log`);
    if (live) assert.match(output, /DP_B1_DONE/, `see ${name}.log`);
    console.log(`${name}: PASS`);
  } finally { clearTimeout(timeout); if (!closed) child.kill('SIGKILL'); }
}
try {
  await save('manifest.json', { runId, baseline: '0ffff2acccb7ebabb29cf842fa1e00e1001f28a1', source: 'synthetic', seed: 1,
    suite: 'spike', endpoint, realModelRequests: 0, credentialsInherited: false, adapter: 'test-only LoopbackAdapter' });
  await command(['--version'], 'version');
  await command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  for (const phase of ['first', 'cold']) {
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
      '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
      '- id: dsh-bot', '  config:', '    seedExamples: false', '    messagingEnabled: false',
      `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
      '- id: agent-default-model', '  config:', '    provider: dp-loopback', '    model: fixture',
      ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
        'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry']
        .flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: dp-b1-probe',
      `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/deepening/host-profile.mjs'))}`,
      '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        endpoint: ${JSON.stringify(endpoint)}`,
      `        phase: ${phase}`,
    ].join('\n');
    await writeFile(resolve(env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await command(['--profile', profile, '--dump-config'], `${phase}-dump`);
    const start = requests.length;
    await command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
    if (phase === 'cold') {
      assert.ok(requests.length > start);
      for (const r of requests.slice(start)) {
        const wire = JSON.stringify(r);
        for (const token of [canary, Buffer.from(canary).toString('base64'), encodeURIComponent(canary)])
          assert.ok(!wire.includes(token));
      }
    }
  }
  assert.ok(requests.some(r => JSON.stringify(r).includes(canary)), 'Baseline detects canary');
  assert.ok(requests.some(r => JSON.stringify(r).includes('syntheticReplay')), 'Baseline carries synthetic replay');
  const replacement = JSON.parse(await readFile(resolve(dir, 'first-replacement.json')));
  const cleanRequests = requests.slice(replacement.adapterRequestsAtVerification);
  assert.ok(cleanRequests.length >= 2, 'Both hot retry and cold request must be captured');
  for (const r of cleanRequests) {
    const wire = JSON.stringify(r);
    for (const token of [canary, Buffer.from(canary).toString('base64'), encodeURIComponent(canary)])
      assert.ok(!wire.includes(token));
  }
  const denials = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  });
  assert.equal(denials, '', 'Unexpected outbound attempt');
  await save('summary.json', { status: 'PASS', acceptanceScope: 'I01-I03 minimum spike', p0Status: 'FAIL', tasks: { I01: 'PASS', I02: 'PASS', I03: 'PASS' },
    levels: { currentInjection: 'PASS', surfaceReplacement: 'PASS',
      completeRequestAndManagedCopies: 'FAIL (P0 OPEN: native provider replay and MCP copy closure NOT_RUN)' },
    requests: requests.length, realModelRequests: 0, endpointAllowlist: [endpoint],
    sessionIdentity: 'same three main IDs across cold Host', fullFixtureColdRequestCanary: 0 });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await save('failure.json', { error: String(error), stack: error.stack });
  await save('summary.json', { status: 'FAIL', levels: { currentInjection: 'FAIL (see receipts)',
    surfaceReplacement: 'FAIL (see receipts)', completeRequestAndManagedCopies: 'FAIL (P0 OPEN)' } });
  console.log(JSON.stringify({ status: 'FAIL', dir, error: String(error) })); process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  server.closeAllConnections(); await new Promise(accept => server.close(accept));
  await save('commands.json', commands);
}
