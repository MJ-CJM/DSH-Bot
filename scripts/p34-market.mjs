import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from './p34-artifact.mjs';

/** Only the published public parser is used; the read-only private generator is never run. */
export async function checkMarket(root, runDir, env) {
  await mkdir(runDir, { recursive: true });
  const require = createRequire(resolve(root, 'packages/dsh-bot/package.json'));
  const { parseMarketIndex, marketInstallTarget } = await import(require.resolve('@deepseek-ai/dsh-plugin-market-index'));
  const fixture = JSON.parse(await readFile(resolve(root, 'docs/fixtures/market-index.fixture.json')));
  const indexUrl = 'https://fixture.invalid/index.json';
  const checks = [];
  const check = async (id, fn) => {
    try { await fn(); checks.push({ id, status: 'PASS' }); }
    catch (error) { checks.push({ id, status: 'FAIL', reason: String(error) }); }
  };
  await check('native_parser_and_exact_npm_target', () => {
    const plugin = parseMarketIndex(fixture, indexUrl).plugins[0];
    assert.deepEqual(marketInstallTarget(plugin.name, plugin.versions[0]), {
      spec: 'dsh-bot-market-fixture@0.3.0', registry: 'https://registry.fixture.invalid/' });
  });
  for (const [id, mutate] of [
    ['invalid_format', f => { f.format = 2; }],
    ['timestamp_milliseconds', f => { f.plugins[0].versions[0].publishTimestamp = Date.now(); }],
    ['nonexact_version', f => { f.plugins[0].versions[0].version = '^0.3.0'; }],
    ['short_git_commit', f => { f.plugins[0].versions[0].source = { type: 'git', url: 'https://fixture.invalid/owner/repo', commit: '1234567' }; }],
    ['git_path_traversal', f => { f.plugins[0].versions[0].source = { type: 'git', url: 'https://fixture.invalid/owner/repo', commit: 'a'.repeat(40), path: '../escape' }; }],
  ]) await check(id, () => {
    const input = structuredClone(fixture); mutate(input);
    assert.throws(() => parseMarketIndex(input, indexUrl));
  });
  await check('exact_git_target_no_publication_claim', () => {
    const input = structuredClone(fixture);
    input.plugins[0].versions[0].source = { type: 'git', url: 'https://fixture.invalid/owner/repo', commit: 'a'.repeat(40), path: 'packages/dsh-bot' };
    const p = parseMarketIndex(input, indexUrl).plugins[0];
    assert.equal(marketInstallTarget(p.name, p.versions[0]).spec, `git+https://fixture.invalid/owner/repo.git#${'a'.repeat(40)}&path:/packages/dsh-bot`);
  });
  const fixtureRoot = resolve(runDir, 'fixture-package');
  await mkdir(fixtureRoot);
  const manifest = { name: 'dsh-bot-market-fixture', version: '0.3.0', private: true, type: 'module', fixtureRun: randomUUID(),
    engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } };
  await writeFile(resolve(fixtureRoot, 'package.json'), JSON.stringify(manifest));
  await writeFile(resolve(fixtureRoot, 'cordis.patch.yml'), '[]\n');
  const packed = await command(resolve(root, 'scripts/pnpm'), ['-C', fixtureRoot, 'pack', '--pack-destination', runDir], { cwd: root, env });
  await writeFile(resolve(runDir, 'pack.log'), packed.output);
  assert.equal(packed.code, 0);
  const tarball = await readFile(resolve(runDir, 'dsh-bot-market-fixture-0.3.0.tgz'));
  const requests = [];
  let versionMismatch;
  const validateIdentity = (installed, plugin, version) => {
    assert.equal(installed.name, plugin.name);
    assert.equal(installed.version, version.version);
  };
  let origin;
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.url === '/dsh-bot-market-fixture') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: {
        '0.3.0': { ...manifest, dist: { tarball: `${origin}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` } },
        // Deliberately inconsistent registry metadata; package bytes remain 0.3.0.
        '0.3.1': { ...manifest, version: '0.3.1', dist: { tarball: `${origin}/fixture.tgz`, integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}` } },
      } }));
    } else if (req.url === '/fixture.tgz') { res.setHeader('content-type', 'application/octet-stream'); res.end(tarball); }
    else { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"synthetic missing package"}'); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  origin = `http://127.0.0.1:${server.address().port}`;
  const profile = `p34-market-${Date.now()}-${process.pid}`;
  try {
    await check('native_installer_mock_registry_success_and_404', async () => {
      const input = structuredClone(fixture); input.plugins[0].versions[0].source.registry = origin;
      const plugin = parseMarketIndex(input, `${origin}/index.json`).plugins[0];
      const target = marketInstallTarget(plugin.name, plugin.versions[0]);
      const localEnv = { ...env, npm_config_fetch_retries: '0', pnpm_config_fetch_retries: '0' };
      const install = await command(resolve(root, 'scripts/dsh'), ['plugin', '--profile', profile, 'add', target.spec, '--registry', target.registry], { cwd: root, env: localEnv });
      await writeFile(resolve(runDir, 'install.log'), install.output);
      assert.equal(install.code, 0);
      const installed = JSON.parse(await readFile(resolve(env.DSH_HOME, 'profiles', profile, 'node_modules', plugin.name, 'package.json')));
      validateIdentity(installed, plugin, plugin.versions[0]);
      await check('registry_tarball_version_mismatch_rejected', async () => {
        const expected = { ...plugin.versions[0], version: '0.3.1' };
        const mismatchTarget = marketInstallTarget(plugin.name, expected);
        const mismatch = await command(resolve(root, 'scripts/dsh'), ['plugin', '--profile', `${profile}-mismatch`, 'add', mismatchTarget.spec, '--registry', origin], { cwd: root, env: localEnv });
        await writeFile(resolve(runDir, 'mismatch.log'), mismatch.output);
        if (mismatch.code !== 0) versionMismatch = { rejectedBy: 'native-installer', code: mismatch.code };
        else {
          const actual = JSON.parse(await readFile(resolve(env.DSH_HOME, 'profiles', `${profile}-mismatch`, 'node_modules', plugin.name, 'package.json')));
          assert.throws(() => validateIdentity(actual, plugin, expected));
          versionMismatch = { rejectedBy: 'post-install-identity-audit', expected: expected.version, actual: actual.version };
        }
      });
      const missing = await command(resolve(root, 'scripts/dsh'), ['plugin', '--profile', profile, 'add', 'dsh-bot-market-fixture-missing@0.3.0', '--registry', origin], { cwd: root, env: localEnv });
      await writeFile(resolve(runDir, 'missing.log'), missing.output);
      assert.notEqual(missing.code, 0); assert.ok(requests.some(r => r.path.includes('fixture-missing')));
      assert.ok(requests.some(r => r.path === '/fixture.tgz'));
    });
  } finally { await new Promise(accept => server.close(accept)); }
  const result = { status: checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL', checks, requests, versionMismatch,
    profile, published: false, fixtureOnly: true,
    gitFetch: { status: 'FAIL', reason: 'NOT_RUN: no published release commit/tag; only native parser and target validation executed.' } };
  await writeFile(resolve(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
