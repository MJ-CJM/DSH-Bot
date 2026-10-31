import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';
const root = process.cwd(), home = resolve(root, '.dsh-dev');
const artifactPath = process.env.DSH_BOT_ARTIFACT ? resolve(root, process.env.DSH_BOT_ARTIFACT) : undefined;
assert.equal(process.env.DSH_HOME, home); assert.deepEqual(process.argv.slice(2), ['--mock-only']);
const dir = resolve(home, 'onboarding-native', `${Date.now()}-${process.pid}`);
await mkdir(dir, { recursive: true });
const run = await runner(dir, 0, 'ONBOARDING_NATIVE');
run.env.DSH_HOME = home;
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
let phase = 'version';
try {
  const version = (await run.command(['--version'], 'version')).trim();
  const profile = `onboarding-native-${Date.now()}-${process.pid}`;
  phase = 'initialize'; await run.command(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 'initialize');
  phase = 'install'; await run.command(['plugin', '--profile', profile, 'add', artifactPath ?? resolve(root, 'packages/dsh-bot')], 'install');
  if (artifactPath) await auditInstalled(home, profile, await auditArtifact(root, artifactPath, dir));
  const patch = mockProfilePatch(dir, 'packages/dsh-bot/tests/onboarding-native-profile.mjs', { outputDir: dir });
  await writeFile(resolve(home, 'profiles', profile, 'cordis.patch.yml'), patch);
  phase = 'host'; await run.command(['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], 'host', true);
  const result = JSON.parse(await readFile(resolve(dir, 'result.json')));
  assert.equal(result.status, 'PASS');
  await save('hot-result',result);
  phase='cold-host'; await writeFile(resolve(home,'profiles',profile,'cordis.patch.yml'),mockProfilePatch(dir,'packages/dsh-bot/tests/onboarding-native-profile.mjs',{outputDir:dir,cold:true}));
  await run.command(['--profile',profile,'--no-open','--host','127.0.0.1','--port','0'],'cold-host',true);
  const cold=JSON.parse(await readFile(resolve(dir,'cold-result.json'))); assert.equal(cold.status,'PASS');
  await save('summary', { ...result, cliVersion: version, referenceTag: 'dsh-v0.2.1-rc.2', dir });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', phase, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) })); process.exitCode = 1;
} finally { run.stop(); await save('commands', run.commands); }
