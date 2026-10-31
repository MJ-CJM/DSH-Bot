import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home); assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve(home, 'delegate-continuation', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'P0_CONTINUATION');
run.env.DSH_HOME = home;
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
let phase = 'version';
try {
  const version = (await run.command(['--version'], 'version')).trim();
  const profile = `delegate-continuation-${Date.now()}-${process.pid}`;
  phase = 'initialize'; await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  phase = 'install'; await run.command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], 'install');
  const results = [];
  for (const runPhase of ['first', 'cold']) {
    const patch = mockProfilePatch(dir, 'packages/dsh-bot/tests/delegate-continuation-profile.mjs', { outputDir: dir, phase: runPhase });
    await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), patch);
    phase = `${runPhase}-host`; await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
    const result = JSON.parse(await readFile(resolve(dir, `${runPhase}-result.json`)));
    assert.equal(result.status, 'PASS'); results.push(result);
  }
  await save('summary', { status: 'PASS', results, cliVersion: version, referenceTag: 'dsh-v0.2.1-rc.2', dir });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', phase, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); await save('commands', run.commands); }
