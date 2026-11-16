#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve(home, 'supergroup-native', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'SG_NATIVE');
// Match the existing real-Host runner: all child user state lives under this
// fresh run inside .dsh-dev; never claim or rewrite a previous fixture's lease.
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN
  ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
let phase = 'version', cliVersion;
try {
  cliVersion = (await run.command(['--version'], phase)).trim();
  assert.equal(cliVersion, '0.2.1-rc.2');
  const profile = `supergroup-native-${Date.now()}-${process.pid}`;
  phase = 'initialize';
  await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], phase);
  phase = 'install';
  await run.command(['plugin', '--profile', profile, 'add', resolve(root, 'packages/dsh-bot')], phase);
  await writeFile(resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir,
    'packages/dsh-bot/tests/supergroup-native-profile.mjs', { outputDir: dir }));
  phase = 'host';
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], phase, true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json'), 'utf8'));
  const disposed = JSON.parse(await readFile(resolve(dir, 'disposed.json'), 'utf8'));
  assert.equal(result.status, 'PASS');
  assert.equal(disposed.status, 'PASS');
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ ...result, cliVersion, profile,
    referenceTag: 'dsh-v0.2.1-rc.2', childDshHome: run.env.DSH_HOME, disposed, dir }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', route: result.route, dir, cliVersion }));
} catch (error) {
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify({ status: 'FAIL', phase, cliVersion, error: String(error) }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) }));
  process.exitCode = 1;
} finally { run.stop(); }
