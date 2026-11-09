import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { auditInstalled, sha256 } from './p34-artifact.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const args = process.argv.slice(2);
const artifactIndex = args.indexOf('--artifact');
const artifact = artifactIndex < 0 ? undefined : resolve(root, args[artifactIndex + 1]);
if (artifact) args.splice(artifactIndex, 2);
assert.ok(JSON.stringify(args) === JSON.stringify(['--mock-only']) ||
  JSON.stringify(args) === JSON.stringify(['--mock-only', '--integrated']));
const integrated = args.includes('--integrated');
const dir = await mkdtemp(resolve(home, 'v066-group-owner-follow-up-'));
const profile = 'v066-group-owner-follow-up';
const run = await runner(dir, 0, 'GROUP_OWNER', { timeoutMs: 45000 });
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
await mkdir(run.env.DSH_HOME, { recursive: true });
const patch = resolve(run.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml');
const fixture = resolve(root, 'packages/dsh-bot/tests/v066-group-owner-follow-up-profile.mjs');
const flags = ['--profile', profile];
const save = summary => writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2));
const read = async name => JSON.parse(await readFile(resolve(dir, name), 'utf8'));
const patchFor = cold => {
  const text = mockProfilePatch(dir, fixture, { outputDir: dir, cold, integrated });
  return integrated ? text.replace('    messagingEnabled: true\n', '    messagingEnabled: true\n    proactiveEnabled: true\n') : text;
};
let phase = 'version';
try {
  const archive = artifact && JSON.parse(await readFile(resolve(dirname(artifact), 'audit/artifact-manifest.json'), 'utf8'));
  if (artifact) {
    const path = relative(root, artifact);
    assert.ok(path && !path.startsWith('..'));
    assert.equal(archive.artifact, path);
    assert.equal(sha256(await readFile(artifact)), archive.sha256);
  }
  const cliVersion = (await run.command(['--version'], phase)).trim();
  assert.ok(['0.2.1-rc.2', '0.2.2-rc.1'].includes(cliVersion), `Unqualified CLI ${cliVersion}`);
  phase = 'initialize'; await run.command([...flags, '--from-default-profile', 'web', '--dump-config'], phase);
  phase = 'install'; await run.command(['plugin', ...flags, 'add', artifact ?? resolve(root, 'packages/dsh-bot')], phase);
  const installed = archive && await auditInstalled(run.env.DSH_HOME, profile, archive);
  phase = 'host';
  await writeFile(patch, patchFor(false));
  const host = [...flags, '--no-open', '--host', '127.0.0.1', '--port', '0'];
  await run.command(host, phase, true);
  const warm = await read('result.json');
  assert.equal(warm.status, 'PASS');
  phase = 'cold-host';
  await writeFile(patch, patchFor(true));
  await run.command(host, phase, true);
  const cold = await read('cold-result.json');
  assert.equal(cold.status, 'PASS');
  await save({ status: 'PASS', cliVersion, installed, warm, cold });
  console.log(JSON.stringify({ status: 'PASS', dir }));
} catch (error) {
  await save({ status: 'FAIL', phase, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) }));
  process.exitCode = 1;
} finally { run.stop(); }
