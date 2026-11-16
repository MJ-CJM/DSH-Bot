import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';

assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve('.dsh-dev/bot-mode-group-input', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'B00_GROUP', { timeoutMs: 100000 });
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh');
let phase = 'version';
try {
  assert.equal((await run.command(['--version'], phase)).trim(), '0.2.1-rc.2');
  const profile = `bot-mode-group-input-${Date.now()}-${process.pid}`;
  phase = 'initialize'; await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], phase);
  phase = 'install'; await run.command(['plugin', '--profile', profile, 'add', resolve('packages/dsh-bot')], phase);
  for (const file of ['host/index.js', 'host/data-flow/tool-guard.js', 'host/delegate/continuation.js'])
    assert.deepEqual(await readFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'node_modules/dsh-botgroup/lib', file)), await readFile(resolve('packages/dsh-bot/lib', file)));
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
    'packages/dsh-bot/tests/bot-mode-group-input-profile.mjs', { outputDir: dir }));
  phase = 'host'; await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8')); assert.equal(result.status, 'PASS');
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ ...result, dir, cliVersion: '0.2.1-rc.2', installedGuardBytesMatch: true }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', dir, capability: result.capability }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, error: String(error), realModelRequests: 0 }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', dir, phase, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); }
