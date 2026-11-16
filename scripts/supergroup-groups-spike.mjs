import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';

const home = resolve('.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve(home, 'supergroup-groups', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'SG_GROUPS');
// Memory ownership is DSH_HOME-wide. Keep the Host in this run's nested home;
// sharing the historical .dsh-dev owner lease would cross unrelated profiles.
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
let phase = 'version';
try {
  const cliVersion = (await run.command(['--version'], 'version')).trim();
  assert.equal(cliVersion, '0.2.1-rc.2');
  const profile = `supergroup-groups-${Date.now()}-${process.pid}`;
  phase = 'initialize';
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], phase);
  phase = 'install';
  await run.command(['plugin', '--profile', profile, 'add', resolve('packages/dsh-bot')], phase);
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
    'packages/dsh-bot/tests/supergroup-groups-profile.mjs', { outputDir: dir }));
  phase = 'host';
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8'));
  assert.equal(result.status, 'PASS');
  await save('summary', { ...result, cliVersion, referenceTag: 'dsh-v0.2.1-rc.2', dir });
  console.log(JSON.stringify({ status: 'PASS', capability: result.capability, dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', phase, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) }));
  process.exitCode = 1;
} finally { run.stop(); await save('commands', run.commands); }
