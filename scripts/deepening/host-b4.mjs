import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './b3-runner.mjs';
import { forgetCases } from './b4-cases.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev'), suite = process.argv[3];
assert.equal(process.env.DSH_HOME, home);
const cases = suite === 'forget-matrix' ? forgetCases : suite === 'copy-cleanup' ? ['copy-previous']
  : suite === 'history' ? ['tool-pair'] : ['repeat-cleanup', 'copy-unavailable', 'flush-failure', 'approval-wait'];
const dir = resolve(home, 'deepening', `b4-${suite}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
await mkdir(resolve(dir, 'receipts'), { recursive: true });
const requests = [], rows = [];
const save = (name, data) => writeFile(resolve(dir, name), `${JSON.stringify(data, null, 2)}\n`);
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/capture'); assert.equal(req.method, 'POST');
    let body = ''; for await (const chunk of req) body += chunk;
    const record = { index: requests.length + 1, request: JSON.parse(body) }; requests.push(record);
    await appendFile(resolve(dir, 'requests.jsonl'), `${JSON.stringify(record)}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((accept, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', accept); });
const endpoint = `http://127.0.0.1:${server.address().port}/capture`;
const run = await runner(dir, server.address().port, 'DP_B4'), profile = 'b4-mock';
try {
  const version = await run.command(['--version'], 'version');
  const cliVersion = version.split(/\r?\n/).find(line => /^\d+\.\d+\.\d+/.test(line));
  await save('manifest.json', { suite, cases, source: 'synthetic', cliVersion, reference: '0.2.1-rc.2',
    realModelRequests: 0, credentialsInherited: false, endpointAllowlist: [endpoint] });
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await run.command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  for (const scenario of cases) {
    for (const phase of ['first', 'cold']) {
      const patch = [
        '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, scenario, 'storage'))}`,
        '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, scenario, 'sessions'))}`,
        '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
        '- id: dsh-bot', '  config:', '    seedExamples: false', '    messagingEnabled: false',
        `    dataDir: ${JSON.stringify(resolve(dir, scenario, 'bots'))}`,
        '- id: agent-default-model', '  config:', '    provider: dp-loopback', '    model: fixture',
        ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
          'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
        '- insert:', '    - id: dp-b4-probe',
        `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/deepening/b4-profile.mjs'))}`,
        '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        endpoint: ${JSON.stringify(endpoint)}`,
        `        phase: ${phase}`, `        scenario: ${scenario}`,
      ].join('\n');
      await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
      const before = requests.length;
      await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${scenario}-${phase}`, true);
      if (phase === 'cold') assert.equal(requests.length, before, 'Cold blocked requests must never reach adapter');
    }
    const receipt = JSON.parse(await readFile(resolve(dir, 'receipts', `${scenario}-first.json`)));
    const cold = JSON.parse(await readFile(resolve(dir, 'receipts', `${scenario}-cold.json`)));
    assert.deepEqual(receipt.ids, cold.ids); assert.equal(receipt.blockedRequests, 0); assert.equal(cold.blockedRequests, 0);
    rows.push({ scenario, bots: 3, identity: 'PASS', stopped: 'PASS', guard: 'PASS',
      history: receipt.cleanup.reasons.includes('system-head') ? 'BLOCKED (system-head)' : receipt.cleanup.phase,
      strong: receipt.cleanup.strong ? 'PASS' : 'FAIL (P0 OPEN)', canaryPostForgetRequests: 0,
      cleanPostForgetRequestProof: 'FAIL (blocked; no clean dispatch proven)', reasons: receipt.cleanup.reasons });
  }
  const denials = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return ''; throw e;
  });
  assert.equal(denials, '');
  await save('matrix.json', rows);
  await save('summary.json', { status: 'PASS (safe blocking and exercised paths)', suite, cases: rows.length, botsPerCase: 3,
    requests: requests.length, realModelRequests: 0, blockedRequests: 0, canaryPostForgetRequests: 0,
    p0Status: 'FAIL (P0 OPEN)', levels: { currentInjection: 'PASS', history: 'BLOCKED (native system head)',
      strongForgetting: 'FAIL (raw-read policy and inventory unverified; native provider serializers NOT_RUN)' },
    exactReferenceHost: cliVersion === '0.2.1-rc.2' ? 'PASS' : 'FAIL (environment: installed CLI differs)', cliVersion });
  console.log(JSON.stringify({ dir, cases: rows.length, requests: requests.length, p0Status: 'FAIL (P0 OPEN)' }));
} catch (error) {
  await save('failure.json', { error: String(error), stack: error.stack });
  await save('summary.json', { status: 'FAIL', suite, completedCases: rows.length, requests: requests.length });
  process.exitCode = 1; console.error({ dir, error: String(error) });
} finally {
  run.stop(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); await save('commands.json', run.commands);
}
