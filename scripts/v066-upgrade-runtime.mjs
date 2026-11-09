import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { command, sha256 } from './p34-artifact.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const [artifactFlag, candidate, digestFlag, expectedDigest, baselineFlag, baseline, mockFlag] = process.argv.slice(2);
assert.deepEqual([artifactFlag, digestFlag, baselineFlag, mockFlag], ['--artifact', '--sha256', '--baseline', '--mock-only']);
assert.equal(process.argv.length, 9);
const oldPackages = {
  public: { path: '.dsh-dev/v065-public-assets/dsh-bot-0.6.5.tgz', digest: '4cbbf2d412063c68ec890cbeb2a2924f43f8ee4abc5f82e4f89c9efcb595ffde' },
  local: { path: '.dsh-dev/avatar-fix-20261109/candidate-1/dsh-bot-0.6.5.tgz', digest: 'a983bdb2b5c715b749f451ada3c5d23260397413f39f4a3e5f8596bc8ac060a9' },
};
assert.ok(Object.hasOwn(oldPackages, baseline), 'Use public or local baseline');
assert.match(expectedDigest, /^[0-9a-f]{64}$/);
assert.notEqual(expectedDigest, oldPackages[baseline].digest);
const archive = resolve(root, candidate);
const relativeArchive = relative(root, archive);
assert.ok(relativeArchive && !relativeArchive.startsWith('..'));
const dir = await mkdtemp(resolve(home, `v066-upgrade-${baseline}-`));
const run = await runner(dir, 0, 'V066_UPGRADE', { timeoutMs: 90000 });
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
const isolatedHome = run.env.DSH_HOME;
await mkdir(isolatedHome, { recursive: true });
const profile = 'v066-upgrade';
const flags = ['--profile', profile];
const profileDir = resolve(isolatedHome, 'profiles', profile);
const installedRoot = resolve(profileDir, 'node_modules/dsh-bot');
const patchFile = resolve(profileDir, 'cordis.patch.yml');
const fixture = resolve(root, 'packages/dsh-bot/tests/v066-upgrade-profile.mjs');
const corePath = resolve(isolatedHome, 'dsh-bot-proactive', 'core.sqlite');
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), JSON.stringify(value, null, 2));
const load = name => readFile(resolve(dir, `${name}.json`), 'utf8').then(JSON.parse);

async function leafFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await leafFiles(path, base));
    else {
      assert.ok(entry.isFile(), `Unexpected file type: ${path}`);
      result.push({ file: relative(base, path), digest: sha256(await readFile(path)) });
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
async function unpack(path, label, expected) {
  assert.equal(sha256(await readFile(path)), expected, `${label} archive SHA changed`);
  const listing = await command('/usr/bin/tar', ['-tzf', path]);
  assert.equal(listing.code, 0);
  for (const leaf of listing.output.trim().split('\n')) assert.ok(leaf.startsWith('package/') && !leaf.split('/').includes('..'));
  const output = resolve(dir, label);
  await mkdir(output);
  assert.equal((await command('/usr/bin/tar', ['-xzf', path, '-C', output])).code, 0);
  const pkg = resolve(output, 'package');
  const { name, version } = JSON.parse(await readFile(resolve(pkg, 'package.json')));
  assert.equal(name, 'dsh-bot');
  return { path, version, sha256: expected, files: await leafFiles(pkg) };
}
const installed = async artifact => {
  const manifest = JSON.parse(await readFile(resolve(installedRoot, 'package.json')));
  assert.equal(manifest.version, artifact.version);
  for (const entry of artifact.files)
    assert.equal(sha256(await readFile(resolve(installedRoot, entry.file))), entry.digest, `Installed bytes differ: ${entry.file}`);
};
const cli = (name, args, live = false) => run.command(args, name, live);
const host = name => cli(name, [...flags, '--no-open', '--host', '127.0.0.1', '--port', '0'], true);
const data = async () => Object.fromEntries(await Promise.all(
  ['storage', 'sessions', 'bots', 'home/dsh-bot-proactive'].map(async name => [name, await leafFiles(resolve(dir, name))]),
));
const configure = async (phase, artifact, preserve = false) => {
  if (preserve) {
    const prior = await readFile(patchFile, 'utf8');
    const changed = prior.replace(/^(\s+phase: ).*$/m, `$1${JSON.stringify(phase)}`);
    assert.notEqual(changed, prior);
    await writeFile(patchFile, changed);
    return;
  }
  const settings = phase === 'old' && baseline === 'public' ? '' : [
    `    proactiveEnabled: ${baseline === 'local'}`,
    '    proactiveExecutionEnabled: false',
    '    proactiveProvider: dp-b6b',
    '    proactiveModel: fixture',
    '    proactiveMaintenanceIntervalMs: 250',
    `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
    '',
  ].join('\n');
  const patch = mockProfilePatch(dir, fixture, { outputDir: dir, phase, baseline, corePath, installedVersion: artifact.version });
  await writeFile(patchFile, patch.replace('    messagingEnabled: true\n', `    messagingEnabled: true\n${settings}`));
};
let phase = 'artifacts';
try {
  const spec = oldPackages[baseline];
  const old = await unpack(resolve(root, spec.path), 'baseline', spec.digest);
  const next = await unpack(archive, 'candidate', expectedDigest);
  assert.equal(old.version, '0.6.5');
  assert.equal(old.files.some(row => row.file === 'lib/proactive-coordinator/main.mjs'), baseline === 'local');
  assert.ok(next.files.some(row => row.file === 'lib/proactive-coordinator/main.mjs'));
  await save('archives', { old, next });
  const cliVersion = (await cli('version', ['--version'])).trim();
  assert.ok(['0.2.1-rc.2', '0.2.2-rc.1'].includes(cliVersion), `Unqualified CLI ${cliVersion}`);
  phase = 'initialize';
  await cli(phase, [...flags, '--from-default-profile', 'web', '--dump-config']);
  phase = 'old-install';
  await cli(phase, ['plugin', ...flags, 'add', old.path]);
  await installed(old);
  await configure('old', old);
  phase = 'old-host'; await host(phase);
  const oldResult = await load('old-result'); assert.equal(oldResult.status, 'PASS');

  phase = 'upgrade';
  await cli(phase, ['plugin', ...flags, 'add', next.path]);
  await installed(next);
  await configure('new', next);
  phase = 'new-host'; await host(phase);
  const newResult = await load('new-result'); assert.equal(newResult.status, 'PASS');

  phase = 'remove';
  const retained = await data();
  await cli(phase, ['plugin', ...flags, 'remove', 'dsh-bot']);
  await assert.rejects(() => lstat(installedRoot), error => error.code === 'ENOENT');
  assert.equal(JSON.parse(await readFile(resolve(profileDir, 'package.json'))).dependencies?.['dsh-bot'], undefined);
  assert.deepEqual(await data(), retained);
  phase = 'reinstall';
  await cli(phase, ['plugin', ...flags, 'add', next.path]);
  await installed(next);
  assert.deepEqual(await data(), retained);
  await configure('reinstalled', next, true);
  phase = 'reinstalled-host'; await host(phase);
  const reinstalled = await load('reinstalled-result'); assert.equal(reinstalled.status, 'PASS');

  phase = 'unknown-schema';
  const db = new DatabaseSync(corePath);
  try { db.exec('UPDATE pb_meta SET schema_version=2147483647 WHERE singleton=1'); }
  finally { db.close(); }
  const beforeUnknown = sha256(await readFile(corePath));
  await configure('unknown', next, true);
  await host(phase);
  const unknown = await load('unknown-result');
  assert.equal(unknown.status, 'PASS');
  assert.equal(sha256(await readFile(corePath)), beforeUnknown, 'Unknown schema was rewritten');
  const denials = await readFile(resolve(dir, 'network-denials.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.equal(denials, '');
  await save('summary', { status: 'PASS', baseline, cliVersion, previousVersion: old.version,
    candidateVersion: next.version, oldSha256: old.sha256, candidateSha256: next.sha256,
    old: oldResult, upgraded: newResult, reinstalled, unknown, removeReinstallDataBytesRetained: true,
    unknownSchemaBytesRetained: true, blockedNetworkAttempts: 0, realModelRequests: 0 });
  console.log(JSON.stringify({ status: 'PASS', baseline, cliVersion, dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', baseline, phase, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', baseline, phase, dir, error: String(error) }));
  process.exitCode = 1;
} finally { run.stop(); await save('commands', run.commands); }
