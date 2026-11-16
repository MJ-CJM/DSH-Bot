import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve('.dsh-dev/supergroup-recovery', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'SG_RUNTIME', { timeoutMs: 150000 });
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
if (process.env.DSH_BOT_E2E_PACKAGE) run.env.pnpm_config_offline = process.env.DSH_BOT_INSTALL_OFFLINE === '1' ? 'true' : 'false';
const profile = `supergroup-recovery-${Date.now()}`;
const args = ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'];
async function patch(phase) {
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
    'packages/dsh-bot/tests/supergroup-runtime-profile.mjs', { outputDir: dir, phase }, [
      '- id: dsh-bot', '  config:', '    supergroup:', '      enabled: true', '      timeoutMs: 90000',
      '      allowedBotIds: [sg-alpha, sg-beta, sg-gamma]',
    ]));
}
try {
  assert.equal((await run.command(['--version'], 'version')).trim(), '0.2.1-rc.2');
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  await run.command(['plugin', '--profile', profile, 'add', process.env.DSH_BOT_E2E_PACKAGE ?? resolve('packages/dsh-bot')], 'install');
  await patch('crash');
  const live = run.command(args, 'crash-host', true).then(() => { throw new Error('Crash Host unexpectedly exited cleanly'); }, error => error);
  const deadline = Date.now() + 100000;
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Crash fixture never reached expert execution');
    try { await readFile(resolve(dir, 'crash-ready.json')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(30);
  }
  process.kill(run.commands.at(-1).pid, 'SIGKILL');
  await live;
  assert.equal(run.commands.at(-1).signal, 'SIGKILL');
  await patch('cold');
  await run.command(args, 'cold-host', true);
  const result = JSON.parse(await readFile(resolve(dir, 'cold-result.json'), 'utf8'));
  assert.equal(result.status, 'PASS');
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ ...result, forcedTermination: 'SIGKILL', realModelRequests: 0,
    artifactSha256: process.env.DSH_BOT_E2E_PACKAGE ? createHash('sha256').update(await readFile(process.env.DSH_BOT_E2E_PACKAGE)).digest('hex') : null }, null, 2));
  console.log(JSON.stringify({ ...result, dir }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); }
