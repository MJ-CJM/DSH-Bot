import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
const artifactPath = process.env.DSH_BOT_ARTIFACT ? resolve(root, process.env.DSH_BOT_ARTIFACT) : undefined;
assert.equal(process.env.DSH_HOME, home); assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve(home, 'groups-model', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'GROUP_MODEL');
run.env.DSH_HOME = home;
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
// Isolated native permission catalog for this probe; no Auto or full-access entry is selected.
const fixtureConfig = [
  '- id: agent-default-model', '  config:', '    provider: dp-b6b', '    model: fixture', '    reasoningEffort: high',
  '- id: permission', '  config:', '    defaultPreset: workspace-write', '    presets:',
  '      read-only:', '        sandbox: read-only', '        approval: ask',
  '      workspace-write:', '        sandbox: workspace-write', '        approval: ask',
];
let phase = 'version', artifact;
try {
  const version = (await run.command(['--version'], 'version')).trim();
  const profile = `groups-model-${Date.now()}-${process.pid}`;
  phase = 'initialize'; await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  phase = 'install'; await run.command(['plugin', '--profile', profile, 'add', artifactPath ?? resolve(root, 'packages/dsh-bot')], 'install');
  if (artifactPath) { artifact = await auditArtifact(root, artifactPath, dir); await auditInstalled(home, profile, artifact); }
  const patch = mockProfilePatch(dir, 'packages/dsh-bot/tests/groups-model-profile.mjs', { outputDir: dir }, fixtureConfig);
  await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), patch);
  phase = 'host'; await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json')));
  assert.equal(result.status, 'PASS');
  phase = 'cold-host';
  await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), mockProfilePatch(dir, 'packages/dsh-bot/tests/groups-model-profile.mjs', { outputDir: dir, cold: true }, fixtureConfig));
  await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'cold-host', true);
  const cold = JSON.parse(await readFile(resolve(dir, 'cold-result.json'))); assert.equal(cold.status, 'PASS');
  await save('summary', { ...result, cold, artifact, cliVersion: version, referenceTag: 'dsh-v0.2.1-rc.2', dir });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', phase, artifact, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); await save('commands', run.commands); }
