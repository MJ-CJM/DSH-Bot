import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runner } from './b3-runner.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev');
const args = process.argv.slice(2), suite = args[1];
assert.equal(process.env.DSH_HOME, home); assert.equal(args[0], '--suite'); assert.equal(args[2], '--mock-only');
assert.equal(args.length, 3); assert.ok(['fence', 'admission', 'migration', 'migration-rollback'].includes(suite));
const dir = resolve(home, 'deepening', `b3-${suite}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
await mkdir(resolve(dir, 'receipts'), { recursive: true });
const save = (name, data) => writeFile(resolve(dir, name), `${JSON.stringify(data, null, 2)}\n`);
const requests = [];
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/capture'); assert.equal(req.method, 'POST'); let body = '';
    for await (const chunk of req) body += chunk;
    const record = { index: requests.length + 1, request: JSON.parse(body) }; requests.push(record);
    await appendFile(resolve(dir, 'requests.jsonl'), `${JSON.stringify(record)}\n`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const endpoint = `http://127.0.0.1:${server.address().port}/capture`, run = await runner(dir, server.address().port);
const old = resolve(root, 'dist/dsh-bot-0.3.2.tgz');
try {
  const versionOutput = await run.command(['--version'], 'version');
  const cliVersion = versionOutput.split(/\r?\n/).map(line => line.trim()).find(line => /^\d+\.\d+\.\d+/.test(line));
  assert.ok(cliVersion, 'CLI version receipt required');
  const oldHash = createHash('sha256').update(await readFile(old)).digest('hex');
  await save('manifest.json', { suite, source: 'synthetic', oldPackage: old, oldSha256: oldHash, realModelRequests: 0,
    endpointAllowlist: [endpoint], inheritedCredentials: false, cliVersion, referenceVersion: '0.2.1-rc.2' });
  const phases = suite === 'fence' ? ['fresh', 'old-rejected'] : suite === 'admission' ? ['admission', 'cold-blocked']
    : suite === 'migration' ? ['legacy-seed', 'upgrade', 'cold'] : ['legacy-seed', 'forget', 'old-rejected', 'cold-blocked'];
  for (const phase of phases) {
    // A fresh profile avoids pnpm retaining a same-version link resolution when switching file sources.
    const profile = `b3-${phase}`;
    await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], `${phase}-initialize`);
    const legacy = phase === 'legacy-seed' || phase === 'old-rejected';
    await run.command(['plugin', '--profile', profile, 'add', legacy ? old : resolve(root, 'packages/dsh-bot')], `${phase}-install`);
    if (legacy) {
      const installed = resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-bot/lib/host/stores/domain.js');
      const expected = execFileSync('tar', ['-xOf', old, 'package/lib/host/stores/domain.js']);
      const actual = await readFile(installed); assert.ok(expected.equals(actual), 'Installed old schema must match real tgz bytes');
      await save(`${phase}-package.json`, { oldSha256: oldHash, installedDomainSha256: createHash('sha256').update(actual).digest('hex') });
    }
    const patch = [
      '- id: storage-json', '  config:', `    root: ${JSON.stringify(resolve(dir, 'storages'))}`,
      '- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(resolve(dir, 'sessions'))}`,
      '- id: credentials-local', '  config:', `    path: ${JSON.stringify(resolve(dir, 'synthetic-credentials.yml'))}`, '    watch: false',
      '- id: dsh-bot', '  config:', '    seedExamples: false', '    messagingEnabled: false',
      `    dataDir: ${JSON.stringify(resolve(dir, 'bots'))}`,
      '- id: agent-default-model', '  config:', '    provider: dp-loopback', '    model: fixture',
      ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm', 'llm-retry',
        'session-log-deepseek', 'session-telemetry-otel', 'desktop-product-telemetry'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
      '- insert:', '    - id: dp-b3-probe',
      `      name: ${JSON.stringify(resolve(root, 'packages/dsh-bot/tests/deepening/b3-profile.mjs'))}`,
      '      config:', `        outputDir: ${JSON.stringify(dir)}`, `        endpoint: ${JSON.stringify(endpoint)}`, `        phase: ${phase}`,
      `        legacyPrompt: ${JSON.stringify(resolve(run.env.DSH_HOME, 'profiles', profile,
        'node_modules/dsh-bot/lib/host/memory/prompt.js'))}`,
    ].join('\n');
    await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), `${patch}\n`);
    await run.command(['--profile', profile, '--dump-config'], `${phase}-dump`);
    await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${phase}-host`, true);
  }
  const network = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  assert.equal(network, '');
  if (suite === 'admission') {
    assert.equal(requests.length, 4);
    const latestContext = r => JSON.stringify(r.request.messages.filter(m => m.source?.kind === 'runtime-context').at(-1));
    assert.match(latestContext(requests[0]), /B3_CONTEXT_ONE \{\{literal\}\}/);
    assert.match(latestContext(requests[2]), /B3_CONTEXT_TWO/);
    assert.ok(!latestContext(requests[2]).includes('B3_CONTEXT_ONE'));
  }
  await save('summary.json', { status: 'PASS', suite, hostPhases: phases.length, requests: requests.length, realModelRequests: 0,
    p0Status: 'FAIL (P0 OPEN: history and managed copy cleanup are B4)', oldSha256: oldHash, cliVersion,
    exactReferenceHost: cliVersion === '0.2.1-rc.2' ? 'PASS' : 'FAIL (NOT_RUN: installed CLI differs from locked reference)' });
  console.log(JSON.stringify({ status: 'PASS', dir, requests: requests.length }));
} catch (error) {
  await save('failure.json', { error: String(error), stack: error.stack });
  await save('summary.json', { status: 'FAIL', suite }); process.exitCode = 1; console.error({ dir, error: String(error) });
} finally {
  run.stop(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); await save('commands.json', run.commands);
}
