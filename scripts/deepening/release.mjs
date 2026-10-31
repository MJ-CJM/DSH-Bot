import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hotUpgrade } from './hot-upgrade.mjs';
import { runner } from './b3-runner.mjs';
import { mockProfilePatch } from './mock-profile.mjs';
import { auditArtifact, auditInstalled, sha256 } from '../p34-artifact.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const suite = process.argv[3]; assert.ok(['release-upgrade', 'lifecycle'].includes(suite));
const dir = resolve(home, 'deepening', `b8-${suite}-${Date.now()}`); await mkdir(resolve(dir, 'receipts'), { recursive: true });
const run = await runner(dir, 9, 'DP_B8'), checks = [], requests = [];
const save = (name, value) => writeFile(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`);
let server, cliVersion, audit, phase = 'audit';
async function check(name, action) {
  try { const detail = await action(); checks.push({ name, status: 'PASS', detail }); return true; }
  catch (error) { checks.push({ name, status: /EPERM|EACCES|listen.*not permitted/i.test(String(error)) ? 'FAIL(environment)' : 'FAIL',
    phase, error: String(error), stack: error.stack }); return false; }
}
try {
  await check('artifact', async () => {
    audit = await auditArtifact(root, resolve(root, 'dist/dsh-bot-0.4.1.tgz'), dir);
    assert.equal(audit.version, '0.4.1');
    assert.ok(audit.files.every(row => !/(?:^|\/)(?:evals|tests|scripts|spikes)(?:\/|$)/.test(row.file)));
    await writeFile(resolve(root, 'dist/dsh-bot-0.4.1.tgz.sha256'), `${audit.sha256}  dsh-bot-0.4.1.tgz\n`);
    return { sha256: audit.sha256, files: audit.files.length };
  });
  cliVersion = (await run.command(['--version'], 'version')).match(/\b0\.2\.1-rc\.\d+/)?.[0]; assert.ok(cliVersion);
  const phases = suite === 'lifecycle' ? ['lifecycle'] : ['fresh', 'legacy', 'upgrade', 'cold', 'fence', 'rollback-cold'];
  // Complete tarball installations before attempting a listener, so environment blockers retain install evidence.
  const profiles = new Map();
  for (const id of phases) {
    phase = `${id}-install`;
    await check(phase, async () => {
      assert.ok(audit); const profile = `b8-${id}`, old = ['legacy', 'fence'].includes(id);
      await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], `${id}-initialize`);
      const artifact = resolve(root, `dist/dsh-bot-${old ? '0.3.2' : '0.4.1'}.tgz`);
      await run.command(['plugin', '--profile', profile, 'add', artifact], `${id}-install`);
      const installed = resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-bot');
      if (!old) await auditInstalled(run.env.DSH_HOME, profile, audit);
      else {
        const manifest = JSON.parse(await readFile(resolve(installed, 'package.json'))); assert.equal(manifest.version, '0.3.2');
      }
      profiles.set(id, { profile, installed }); return { artifactHash: sha256(await readFile(artifact)), installed };
    });
  }
  if (suite === 'release-upgrade') {
    phase = 'hot-upgrade';
    await check('hot-upgrade', () => hotUpgrade(resolve(dir, 'hot-upgrade')));
  }
  phase = 'loopback-listen';
  const listening = await check('loopback', async () => {
    server = createServer(async (req, res) => {
      assert.equal(req.url, '/capture'); let body = ''; for await (const part of req) body += part;
      requests.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    run.env.DP_MOCK_PORT = String(server.address().port);
  });
  if (listening) for (const id of phases) {
    phase = `${id}-host`; const data = profiles.get(id);
    if (!data) { checks.push({ name: phase, status: 'FAIL(NOT_RUN)', reason: 'Install failed' }); continue; }
    await check(phase, async () => {
      const endpoint = `http://127.0.0.1:${server.address().port}/capture`;
      const probe = suite === 'lifecycle' ? 'b8-lifecycle-profile.mjs' : 'b8-release-profile.mjs';
      const patch = mockProfilePatch(dir, `packages/dsh-bot/tests/deepening/${probe}`,
        { outputDir: dir, installed: data.installed, phase: id, endpoint, artifactHash: audit.sha256 },
        ['- id: agent-default-model', '  config:', '    provider: dp-loopback', '    model: fixture',
          ...suite === 'lifecycle' ? ['- id: dsh-bot', '  disabled: true'] : []]);
      // Fresh and upgrade families use different isolated data roots; legacy/new/cold/fence share only synthetic upgrade data.
      const isolated = id === 'fresh' ? patch.replaceAll(resolve(dir, 'storage'), resolve(dir, 'fresh-storage'))
        .replaceAll(resolve(dir, 'sessions'), resolve(dir, 'fresh-sessions')).replaceAll(resolve(dir, 'bots'), resolve(dir, 'fresh-bots')) : patch;
      await writeFile(resolve(run.env.DSH_HOME, 'profiles', data.profile, 'cordis.patch.yml'), isolated);
      await run.command(['--profile', data.profile, '--dump-config'], `${id}-dump`);
      await run.command(['--profile', data.profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], `${id}-host`, true);
      const receipt = JSON.parse(await readFile(resolve(dir, 'receipts', `${id}.json`)));
      assert.equal(receipt.status, 'PASS');
      if (id === 'fence') {
        assert.equal(receipt.rejected, true); assert.equal(receipt.adapterRequests, 0);
        assert.equal(receipt.rejection?.code, 'bot/unavailable');
        assert.equal(receipt.rejection.message, "Bot registry startup failed: domain 'dsh_bot': stored record " +
          "'__dsh_bot_memory_v2_fence__' in table 'memories' does not match its schema");
      }
      return receipt;
    });
  }
  else for (const id of phases) checks.push({ name: `${id}-host`, status: 'FAIL(environment/NOT_RUN)', reason: 'loopback listen blocked' });
} catch (error) { checks.push({ name: phase, status: 'FAIL', error: String(error) }); }
finally {
  run.stop(); if (server?.listening) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
  await save('requests.json', requests);
  const summary = { status: checks.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL', suite, checks, cliVersion,
    exactRc2Host: cliVersion === '0.2.1-rc.2' ? 'PASS' : 'FAIL(NOT_RUN)', realModelRequests: 0,
    artifactHash: audit?.sha256, dir };
  await save('summary.json', summary); console.log(JSON.stringify(summary)); if (summary.status !== 'PASS') process.exitCode = 1;
}
