import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve('.dsh-dev/supergroup-runtime', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'SG_RUNTIME', { timeoutMs: 150000 });
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
if (process.env.DSH_BOT_E2E_PACKAGE) run.env.pnpm_config_offline = process.env.DSH_BOT_INSTALL_OFFLINE === '1' ? 'true' : 'false';
try {
  assert.equal((await run.command(['--version'], 'version')).trim(), '0.2.1-rc.2');
  const profile = `supergroup-runtime-${Date.now()}`;
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await run.command(['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve('packages/dsh-bot')], 'install');
  for (const file of ['host/index.js', 'host/supergroup/service.js', 'host/groups/supergroup-admission.js', 'client.js']) {
    assert.deepEqual(await readFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-botgroup/lib', file)),
      await readFile(resolve('packages/dsh-bot/lib', file)), `Installed artifact differs: ${file}`);
  }
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
    'packages/dsh-bot/tests/supergroup-runtime-profile.mjs', { outputDir: dir }, [
      '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      maxRequests: 24',
      '      timeoutMs: 90000', '      allowedBotIds: [sg-alpha, sg-beta, sg-gamma]',
    ]));
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'PASS');
  const summary = { status: 'PASS', dir, ...result, installedBytesMatch: true,
    artifactSha256: process.env.DSH_BOT_E2E_PACKAGE ? createHash('sha256').update(await readFile(process.env.DSH_BOT_E2E_PACKAGE)).digest('hex') : null };
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); }
