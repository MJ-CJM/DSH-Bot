import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { command, sha256 } from './p34-artifact.mjs';

const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const [artifactFlag, candidate, digestFlag, digest, mockFlag] = process.argv.slice(2);
assert.deepEqual([artifactFlag, digestFlag, mockFlag], ['--artifact', '--sha256', '--mock-only']);
assert.equal(process.argv.length, 7);
assert.match(digest, /^[0-9a-f]{64}$/);
const registryAllowedForInstall = process.env.DSH_BOT_UPGRADE_ALLOW_REGISTRY === '1';
const useNpm = process.env.DSH_BOT_UPGRADE_USE_NPM === '1';
assert.ok(!useNpm || registryAllowedForInstall, 'DSH_BOT_UPGRADE_USE_NPM=1 requires DSH_BOT_UPGRADE_ALLOW_REGISTRY=1');
const npmRegistry = 'https://registry.npmjs.org';
const oldPackage = {
  name: 'dsh-bot', version: '0.6.6',
  path: resolve(root, 'dist/release-candidates/v0.6.6-46bd1d63c66e/dsh-bot-0.6.6.tgz'),
  sha256: '46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f',
};
const nextPackage = { name: 'dsh-botgroup', version: '0.6.7', path: await realpath(resolve(root, candidate)), sha256: digest };
const relativeArchive = relative(root, nextPackage.path);
assert.ok(relativeArchive && !relativeArchive.startsWith('..'), 'Candidate must be a repository-local tarball');
assert.notEqual(nextPackage.sha256, oldPackage.sha256);
const installSources = {
  old: { kind: 'tarball', path: oldPackage.path },
  next: useNpm ? { kind: 'npm', spec: `${nextPackage.name}@${nextPackage.version}`, registry: npmRegistry }
    : { kind: 'tarball', path: nextPackage.path },
};

const dir = await mkdtemp(resolve(home, 'v067-npm-upgrade-'));
const run = await runner(dir, 0, 'V067_NPM_UPGRADE');
run.env.DSH_BOT_DSH_BIN = process.env.DSH_BOT_DSH_BIN ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
await mkdir(run.env.DSH_HOME, { recursive: true });
const profile = 'v067-npm-upgrade';
const flags = ['--profile', profile];
const profileDir = resolve(run.env.DSH_HOME, 'profiles', profile);
const patchFile = resolve(profileDir, 'cordis.patch.yml');
const fixture = resolve(root, 'packages/dsh-bot/tests/v067-npm-upgrade-profile.mjs');
const save = (name, value) => writeFile(resolve(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const load = name => readFile(resolve(dir, `${name}.json`), 'utf8').then(JSON.parse);
const cli = (name, args, live = false) => run.command(args, name, live);
const readOptional = path => readFile(path).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function packedFiles(artifact) {
  assert.equal(sha256(await readFile(artifact.path)), artifact.sha256, `SHA-256 mismatch for ${artifact.path}`);
  const listing = await command('/usr/bin/tar', ['-tzf', artifact.path]);
  assert.equal(listing.code, 0, listing.output);
  const paths = listing.output.trimEnd().split('\n');
  assert.equal(new Set(paths).size, paths.length, 'Duplicate archive paths');
  for (const path of paths) {
    assert.ok(path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..'), `Unsafe archive path: ${path}`);
  }
  const types = await command('/usr/bin/tar', ['-tvzf', artifact.path]);
  assert.equal(types.code, 0, types.output);
  const entries = types.output.trimEnd().split('\n');
  assert.equal(entries.length, paths.length);
  for (const entry of entries) assert.match(entry, /^[-d]/, `Expected a regular file or directory: ${entry}`);
  const destination = resolve(dir, `archive-${artifact.name}`);
  await mkdir(destination);
  const extracted = await command('/usr/bin/tar', ['-xzf', artifact.path, '-C', destination]);
  assert.equal(extracted.code, 0, extracted.output);
  const unpacked = resolve(destination, 'package');
  const manifest = JSON.parse(await readFile(resolve(unpacked, 'package.json')));
  assert.equal(manifest.name, artifact.name);
  assert.equal(manifest.version, artifact.version);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  const files = await fileHashes(unpacked);
  assert.ok(files.length > 0);
  return { manifest, files };
}

async function installed(artifact, packed, source) {
  const installedRoot = resolve(profileDir, 'node_modules', artifact.name);
  assert.deepEqual(JSON.parse(await readFile(resolve(installedRoot, 'package.json'))), packed.manifest);
  const files = await fileHashes(installedRoot);
  assert.deepEqual(files.map(file => file.path), packed.files.map(file => file.path), `Installed paths differ for ${artifact.name}`);
  for (const [index, file] of files.entries()) {
    assert.equal(file.sha256, packed.files[index].sha256, `Installed bytes differ for ${artifact.name}/${file.path}`);
  }
  const { dependencies, dsh } = JSON.parse(await readFile(resolve(profileDir, 'package.json')));
  assert.ok(dependencies[artifact.name], `${artifact.name} missing from profile dependencies`);
  if (source.kind === 'npm') assert.equal(dependencies[artifact.name], artifact.version, 'Profile did not save the exact npm version');
  assert.equal(dsh.profile.bundles.filter(name => name === artifact.name).length, 1);
  return files.length;
}

async function assertOldRemoved() {
  const { dependencies, dsh } = JSON.parse(await readFile(resolve(profileDir, 'package.json')));
  assert.equal(dependencies?.[oldPackage.name], undefined);
  assert.ok(!dsh.profile.bundles.includes(oldPackage.name));
  await assert.rejects(() => lstat(resolve(profileDir, 'node_modules', oldPackage.name)), { code: 'ENOENT' });
  const lock = await readFile(resolve(profileDir, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lock, /(?:^|[\s/'"])dsh-bot(?:[\s:'"@/]|$)/m);
}

async function fileHashes(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const hashes = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) hashes.push(...await fileHashes(path, base));
    else {
      assert.ok(entry.isFile(), `Unexpected file type: ${path}`);
      hashes.push({ path: relative(base, path), sha256: sha256(await readFile(path)) });
    }
  }
  return hashes.sort((left, right) => left.path.localeCompare(right.path));
}

const dataHashes = async () => Object.fromEntries(await Promise.all(
  ['storage', 'sessions', 'bots', 'home/dsh-bot', 'home/dsh-bot-proactive'].map(async name => [name, await fileHashes(resolve(dir, name))]),
));

async function install(artifact, packed, phase, source) {
  const target = source.kind === 'npm' ? [source.spec, '--save-exact', `--registry=${source.registry}`] : [source.path];
  if (registryAllowedForInstall) run.env.pnpm_config_offline = 'false';
  try {
    await cli(phase, ['plugin', ...flags, 'add', ...target]);
  } finally {
    run.env.pnpm_config_offline = 'true';
  }
  return installed(artifact, packed, source);
}

async function host(phase, packageName) {
  await save('phase', { phase, packageName });
  await cli(`${phase}-host`, [...flags, '--no-open', '--host', '127.0.0.1', '--port', '0'], true);
  const result = await load(`${phase}-result`);
  assert.equal(result.status, 'PASS');
  return result;
}

let phase = 'artifacts';
const installedFiles = {};
try {
  const oldPacked = await packedFiles(oldPackage);
  const nextPacked = await packedFiles(nextPackage);
  for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
    assert.equal(nextPacked.manifest[group]?.[oldPackage.name], undefined, `Old package listed in ${group}`);
  await save('archives', { oldPackage, nextPackage, files: { old: oldPacked.files, next: nextPacked.files } });
  const cliVersion = (await cli('version', ['--version'])).trim();
  assert.ok(['0.2.1-rc.2', '0.2.2-rc.1'].includes(cliVersion), `Unqualified CLI ${cliVersion}`);

  phase = 'initialize';
  await cli(phase, [...flags, '--from-default-profile', 'web', '--dump-config']);
  phase = 'old-install';
  installedFiles.old = await install(oldPackage, oldPacked, phase, installSources.old);
  const patch = mockProfilePatch(dir, fixture, { outputDir: dir }).replace('- id: dsh-bot\n  config:\n',
    '- id: dsh-bot\n  name: dsh-bot\n  config:\n').replace('    messagingEnabled: true\n', [
    '    messagingEnabled: true', '    memoryListLimit: 13', '    proactiveEnabled: false',
    '    proactiveExecutionEnabled: false', '    proactiveProvider: dp-b6b', '    proactiveModel: fixture',
    `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`, '',
  ].join('\n'));
  await writeFile(patchFile, patch);
  phase = 'old-host';
  const old = await host('old', oldPackage.name);
  const retained = await dataHashes();
  await save('old-data-hashes', retained);
  assert.ok(retained.storage.length && retained.sessions.length && retained['home/dsh-bot'].length);
  const oldPatch = await readFile(patchFile);
  assert.notEqual(oldPatch.toString(), patch, 'The old Host did not persist the ConfigEditor fixture edit');
  await writeFile(resolve(dir, 'old-profile.patch.yml'), oldPatch);

  phase = 'old-remove';
  await cli(phase, ['plugin', ...flags, 'remove', oldPackage.name]);
  await assertOldRemoved();
  const removedPatch = await readOptional(patchFile);
  if (removedPatch) await writeFile(resolve(dir, 'removed-profile.patch.yml'), removedPatch);
  assert.deepEqual(await dataHashes(), retained, 'Uninstall changed durable data');

  phase = 'new-install';
  installedFiles.next = await install(nextPackage, nextPacked, phase, installSources.next);
  await assertOldRemoved();
  const installedPatch = await readOptional(patchFile);
  if (installedPatch) await writeFile(resolve(dir, 'installed-profile.patch.yml'), installedPatch);
  assert.deepEqual(await dataHashes(), retained, 'Installation changed durable data before startup');
  await save('profile-patch-hashes', {
    old: sha256(oldPatch), removed: removedPatch && sha256(removedPatch), installed: installedPatch && sha256(installedPatch),
  });
  assert.deepEqual(removedPatch, oldPatch, 'Native uninstall did not preserve the profile patch byte-for-byte');
  assert.deepEqual(installedPatch, oldPatch, 'Native installation did not preserve the profile patch byte-for-byte');

  phase = 'unmigrated-config';
  const beforeMigration = await cli(phase, [...flags, '--dump-config']);
  assert.match(beforeMigration, /name mismatch[^\n]*dsh-botgroup/);
  assert.match(beforeMigration, /^    memoryListLimit: 20$/m);
  assert.doesNotMatch(beforeMigration, /^    memoryListLimit: 13$/m);

  phase = 'migrate-profile-name';
  const oldSelector = '- id: dsh-bot\n  name: dsh-bot\n';
  const newSelector = '- id: dsh-bot\n  name: dsh-botgroup\n';
  const oldText = oldPatch.toString('utf8');
  assert.equal(oldText.split(oldSelector).length, 2, 'Expected exactly one name-qualified plugin override');
  const migrated = oldText.replace(oldSelector, newSelector);
  assert.equal(migrated.replace(newSelector, oldSelector), oldText);
  await writeFile(patchFile, migrated);
  await writeFile(resolve(dir, 'migrated-profile.patch.yml'), migrated);
  const afterMigration = await cli(phase, [...flags, '--dump-config']);
  assert.doesNotMatch(afterMigration, /name mismatch[^\n]*dsh-botgroup/);
  assert.match(afterMigration, /^    memoryListLimit: 13$/m);
  assert.match(afterMigration, /^    proactiveMaintenanceIntervalMs: 451$/m);

  phase = 'new-host';
  const upgraded = await host('new', nextPackage.name);
  const configuredPatch = await readFile(patchFile);
  assert.notEqual(configuredPatch.toString('utf8'), migrated, 'The new Host did not persist scoped setup');
  await writeFile(resolve(dir, 'configured-profile.patch.yml'), configuredPatch);

  phase = 'cold-host';
  const cold = await host('cold', nextPackage.name);
  await assertOldRemoved();
  assert.deepEqual(await readFile(patchFile), configuredPatch, 'Cold restart rewrote the profile settings');
  assert.equal((await readOptional(resolve(dir, 'network-denials.jsonl')))?.toString() ?? '', '');
  assert.equal(sha256(await readFile(oldPackage.path)), oldPackage.sha256);
  assert.equal(sha256(await readFile(nextPackage.path)), nextPackage.sha256);
  await save('summary', { status: 'PASS', cliVersion, oldPackage, nextPackage, old, upgraded, cold,
    oldPackageRemoved: true, nativeProfilePatchBytesPreserved: true, nameQualifiedOverrideRequiredMigration: true,
    manualOverrideNameChange: { from: 'dsh-bot', to: 'dsh-botgroup', retainedId: 'dsh-bot' }, durableDataBytesRetained: true,
    installSources, installedFiles, registryAllowedForInstall, blockedNetworkAttempts: 0, realModelRequests: 0 });
  console.log(JSON.stringify({ status: 'PASS', cliVersion, dir }));
} catch (error) {
  await save('summary', { status: 'FAIL', phase, installSources, installedFiles, error: String(error), realModelRequests: 0 });
  console.error(JSON.stringify({ status: 'FAIL', phase, dir, error: String(error) }));
  process.exitCode = 1;
} finally {
  run.stop();
  await save('commands', run.commands);
}
