import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { sha256 } from './p34-artifact.mjs';

const runtime = process.argv[2];
assert.ok(['rc2', 'desktop'].includes(runtime), 'usage: scripts/v066-schedule-spike.mjs rc2|desktop [--privacy|--rebind|--rebind-alone] [tgz]');
const mode = process.argv.slice(3).find(arg => arg.startsWith('--'));
assert.ok(!mode || ['--privacy', '--rebind', '--rebind-alone'].includes(mode));
const privacy = mode !== undefined;
const suite = `v066-schedule${mode?.slice(1) ?? ''}`;
process.env.DSH_BOT_DSH_BIN = runtime === 'rc2'
  ? resolve('.dsh-dev/proactive-bot/host-runtime/node_modules/.bin/dsh')
  : '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const artifact = resolve(process.argv.slice(3).find(arg => !arg.startsWith('--'))
  ?? '.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz');
const fixture = resolve('packages/dsh-bot/tests/v066-schedule-profile.mjs');
const dir = await scratch(`${suite}-${runtime}`);
const flags = ['- id: dsh-bot', '  config:', '    proactiveEnabled: false', '    proactiveExecutionEnabled: false'];
console.log(dir);
const version = execFileSync(resolve('scripts/dsh'), ['--version'], {
  encoding: 'utf8', env: { PATH: process.env.PATH, DSH_BOT_DSH_BIN: process.env.DSH_BOT_DSH_BIN, DSH_HOME: dir, HOME: dir },
}).trim();
// This is a frozen baseline; its installed bytes must match the tgz, not the working tree.
const packed = join(dir, 'artifact');
await mkdir(packed);
const paths = execFileSync('/usr/bin/tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
assert.ok(paths.every(p => p.startsWith('package/') && !p.split('/').includes('..')));
execFileSync('/usr/bin/tar', ['-xzf', artifact, '-C', packed]);
const manifest = JSON.parse(await readFile(join(packed, 'package/package.json'), 'utf8'));
assert.equal(manifest.name, 'dsh-bot');
assert.equal(manifest.version, '0.6.5');
const artifactAudit = { sha256: sha256(await readFile(artifact)), version: manifest.version,
  files: await Promise.all(paths.filter(p => !p.endsWith('/')).map(async path => ({
    file: path.slice('package/'.length), sha256: sha256(await readFile(join(packed, path))),
  }))) };
await writeFile(join(dir, 'artifact-manifest.json'), JSON.stringify(artifactAudit, null, 2));
const read = async name => readFile(join(dir, name), 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return undefined;
});
const wait = async (name, timeout) => {
  const deadline = Date.now() + timeout;
  do {
    const failure = await read('fixture-error.json');
    if (failure) throw new Error(failure.error);
    const result = await read(name);
    if (result) return result;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error(`Missing ${name}: ${dir}`);
};
let host;
try {
  host = await webHost(dir, suite, artifact, fixture, flags, { artifactAudit });
  const warm = await wait('warm.json', 95000);
  const checkpoint = await wait('next-phase.json', 11000);
  const warmHttpRequests = host.requests();
  assert.equal(checkpoint.fixtureRequests, warmHttpRequests);
  await host.crash();
  await host.stop(); host = undefined;
  await writeFile(join(dir, 'warm-commands.json'), await readFile(join(dir, 'commands.json')));
  await writeFile(join(dir, 'warm-host.log'), await readFile(join(dir, 'host.log')));
  const crossDueAt = Date.parse(checkpoint.crossDue.task.scheduledAt);
  assert.ok(Date.now() < crossDueAt, 'Host must stop before the cross-outage reminder is due');
  await delay(crossDueAt - Date.now() + 150);
  host = await webHost(dir, suite, artifact, fixture, flags, { preserveProfile: true, artifactAudit });
  const cold = await wait('cold.json', 17000);
  assert.equal(cold.fixtureRequests, host.requests());
  const result = { version, runtime, mode, privacy, artifact, warmHttpRequests, coldHttpRequests: host.requests(), checkpoint,
    status: 'OBSERVED', warm, cold };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`${version}: captured native model/input/receipt observations in ${dir}`);
} finally { await host?.stop(); }
