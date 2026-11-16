import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runner } from './deepening/b3-runner.mjs';
import { mockProfilePatch } from './deepening/mock-profile.mjs';
import { command, sha256 } from './p34-artifact.mjs';

// Exact local archives only; reuse the published synthetic v0.6.7 Host fixture.
const root = process.cwd(), home = resolve(root, '.dsh-dev');
assert.equal(process.env.DSH_HOME, home);
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(['--artifact', '--sha256', '--baseline-artifact', '--legacy-artifact', '--baseline-cli', '--mock-only'].includes(flag), `Unknown option: ${flag}`);
  assert.ok(!options.has(flag), `Duplicate option: ${flag}`);
  if (flag === '--mock-only') options.set(flag, true);
  else {
    const value = process.argv[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}`);
    options.set(flag, value);
  }
}
assert.equal(options.get('--mock-only'), true, 'Explicit --mock-only required');
assert.ok(options.has('--artifact') && options.has('--sha256'), 'Use --artifact <candidate.tgz> --sha256 <digest> --mock-only');
assert.match(options.get('--sha256'), /^[0-9a-f]{64}$/);
const localArchive = async path => {
  const canonical = await realpath(resolve(root, path));
  const local = relative(root, canonical);
  assert.ok(local && !local.startsWith('..'), 'Archive must be a repository-local tarball');
  assert.equal((await lstat(canonical)).isFile(), true);
  return canonical;
};
const candidate = { name: 'dsh-botgroup', version: '0.7.0',
  path: await localArchive(options.get('--artifact')), sha256: options.get('--sha256') };
const baselines = [{ lane: 'same-name', name: 'dsh-botgroup', version: '0.6.7',
  path: await localArchive(options.get('--baseline-artifact') ?? '.dsh-dev/release-0.7.0/baseline/dsh-botgroup-0.6.7.tgz'),
  sha256: '48863e75ad691198d94d9db66c81fd277353fc86173b4823833650a7d1c18206' }];
if (options.has('--legacy-artifact')) baselines.push({ lane: 'legacy-rename', name: 'dsh-bot', version: '0.6.6',
  path: await localArchive(options.get('--legacy-artifact')),
  sha256: '46bd1d63c66ea2b110c27493b799714fba29c4b4b3dcd3e3251147d59d98451f' });
for (const artifact of [...baselines, candidate])
  assert.equal(sha256(await readFile(artifact.path)), artifact.sha256, `Archive SHA-256 mismatch: ${artifact.name}@${artifact.version}`);
const registryAllowedForInstall = process.env.DSH_BOT_UPGRADE_ALLOW_REGISTRY === '1';
const targetCli = process.env.DSH_BOT_DSH_BIN ?? resolve(home, 'proactive-bot/host-runtime/node_modules/.bin/dsh');
const baselineCli = options.has('--baseline-cli') ? await realpath(resolve(root, options.get('--baseline-cli'))) : null;
if (baselineCli) {
  const local = relative(root, baselineCli);
  assert.ok(local && !local.startsWith('..'), 'Baseline CLI must be a repository-local executable');
  const stat = await lstat(baselineCli);
  assert.ok(stat.isFile() && (stat.mode & 0o111) !== 0, 'Baseline CLI must be an executable file');
}
await mkdir(home, { recursive: true });
const directory = await mkdtemp(resolve(home, 'v070-upgrade-'));
const save = (dir, name, value) => writeFile(resolve(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const readOptional = path => readFile(path).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

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

async function packedFiles(artifact, destination) {
  assert.equal(sha256(await readFile(artifact.path)), artifact.sha256);
  const listing = await command('/usr/bin/tar', ['-tzf', artifact.path]);
  assert.equal(listing.code, 0, listing.output);
  const paths = listing.output.trimEnd().split('\n');
  assert.equal(new Set(paths).size, paths.length, 'Duplicate archive paths');
  for (const path of paths)
    assert.ok(path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..'), `Unsafe archive path: ${path}`);
  const types = await command('/usr/bin/tar', ['-tvzf', artifact.path]);
  assert.equal(types.code, 0, types.output);
  const entries = types.output.trimEnd().split('\n');
  assert.equal(entries.length, paths.length);
  for (const entry of entries) assert.match(entry, /^[-d]/, `Expected regular file or directory: ${entry}`);
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

async function fixtureForRun(dir) {
  const original = resolve(root, 'packages/dsh-bot/tests/v067-npm-upgrade-profile.mjs');
  const source = await readFile(original, 'utf8');
  const previous = '`v067-${stage}-blocked`';
  const replacement = '`v070-${stage}-${randomUUID()}-blocked`';
  assert.equal(source.split(previous).length, 2, 'Expected exactly one historical guard request ID');
  // Reinstall invokes the cold stage again. A fresh ID exercises the guard;
  // reusing the previous stage ID instead exercises native request deduplication.
  const changed = source.replace(previous, replacement);
  assert.equal(changed.replace(replacement, previous), source);
  const require = createRequire(original);
  const portable = changed.replace(/^(import(?:\s+.*?\s+from\s+|\s+))(['"])([^'"]+)\2;/gm,
    (statement, prefix, quote, specifier) => {
      if (specifier.startsWith('node:')) return statement;
      const file = specifier.startsWith('.') ? resolve(dirname(original), specifier) : require.resolve(specifier);
      return `${prefix}${JSON.stringify(pathToFileURL(file).href)};`;
    });
  const output = resolve(dir, 'v070-upgrade-profile.mjs');
  await writeFile(output, portable, { flag: 'wx', mode: 0o444 });
  await save(dir, 'fixture-provenance', { original: relative(root, original), originalSha256: sha256(source),
    generated: relative(root, output), generatedSha256: sha256(portable),
    semanticChange: { previous, replacement }, importChange: 'Rebase original imports to the same resolved files',
    assertionsChanged: false });
  return output;
}

async function runLane(baseline) {
  const dir = resolve(directory, baseline.lane);
  await mkdir(dir);
  // The unchanged historical fixture emits this marker for every supported stage.
  const run = await runner(dir, 0, 'V067_NPM_UPGRADE');
  run.env.DSH_BOT_DSH_BIN = baselineCli ?? targetCli;
  await mkdir(run.env.DSH_HOME, { recursive: true });
  const profile = `v070-upgrade-${baseline.lane}`;
  const flags = ['--profile', profile];
  const profileDir = resolve(run.env.DSH_HOME, 'profiles', profile);
  const patchFile = resolve(profileDir, 'cordis.patch.yml');
  const fixture = await fixtureForRun(dir);
  const renamed = baseline.name !== candidate.name;
  const load = name => readFile(resolve(dir, `${name}.json`), 'utf8').then(JSON.parse);
  const cli = (name, args, live = false) => run.command(args, name, live);
  const dataHashes = async () => Object.fromEntries(await Promise.all(
    ['storage', 'sessions', 'bots', 'home/dsh-bot', 'home/dsh-bot-proactive']
      .map(async name => [name, await fileHashes(resolve(dir, name))]),
  ));
  const installedFiles = {};
  let phase = 'artifacts';
  let baselineCliVersion, cliVersion;

  async function installed(artifact, packed) {
    const installedRoot = resolve(profileDir, 'node_modules', artifact.name);
    assert.deepEqual(JSON.parse(await readFile(resolve(installedRoot, 'package.json'))), packed.manifest);
    assert.deepEqual(await fileHashes(installedRoot), packed.files, `Installed paths or bytes differ for ${artifact.name}`);
    const { dependencies, dsh } = JSON.parse(await readFile(resolve(profileDir, 'package.json')));
    assert.ok(dependencies[artifact.name], `${artifact.name} missing from profile dependencies`);
    assert.equal(dsh.profile.bundles.filter(name => name === artifact.name).length, 1);
    return packed.files.length;
  }
  async function removed(name) {
    const { dependencies, dsh } = JSON.parse(await readFile(resolve(profileDir, 'package.json')));
    assert.equal(dependencies?.[name], undefined);
    assert.ok(!dsh.profile.bundles.includes(name));
    await assert.rejects(() => lstat(resolve(profileDir, 'node_modules', name)), { code: 'ENOENT' });
    const lock = await readFile(resolve(profileDir, 'pnpm-lock.yaml'), 'utf8');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(lock, new RegExp(`(?:^|[\\s/'"])${escaped}(?:[\\s:'"@/]|$)`, 'm'));
  }
  async function install(artifact, packed, label) {
    if (registryAllowedForInstall) run.env.pnpm_config_offline = 'false';
    try { await cli(label, ['plugin', ...flags, 'add', artifact.path]); }
    finally { run.env.pnpm_config_offline = 'true'; }
    return installed(artifact, packed);
  }
  async function host(stage, label = stage) {
    await save(dir, 'phase', { phase: stage, packageName: stage === 'old' ? baseline.name : candidate.name });
    await cli(`${label}-host`, [...flags, '--no-open', '--host', '127.0.0.1', '--port', '0'], true);
    const result = await load(`${stage}-result`);
    assert.equal(result.status, 'PASS');
    if (label !== stage) await save(dir, `${label}-result`, result);
    return result;
  }

  try {
    // Labels differ even when both package names are dsh-botgroup.
    const oldPacked = await packedFiles(baseline, resolve(dir, 'archive-baseline'));
    const nextPacked = await packedFiles(candidate, resolve(dir, 'archive-candidate'));
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      assert.equal(nextPacked.manifest[group]?.['dsh-bot'], undefined, `Legacy package listed in ${group}`);
    await save(dir, 'archives', { baseline, candidate, files: { old: oldPacked.files, next: nextPacked.files } });
    baselineCliVersion = (await cli('baseline-version', ['--version'])).trim();
    assert.ok(['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.3'].includes(baselineCliVersion), `Unqualified baseline CLI ${baselineCliVersion}`);
    if (baselineCli) assert.equal(baselineCliVersion, '0.2.1-rc.2', 'Explicit baseline CLI must be the verified rc.2 seed Host');

    phase = 'initialize';
    await cli(phase, [...flags, '--from-default-profile', 'web', '--dump-config']);
    phase = 'old-install';
    installedFiles.old = await install(baseline, oldPacked, phase);
    const patch = mockProfilePatch(dir, fixture, { outputDir: dir }).replace('- id: dsh-bot\n  config:\n',
      `- id: dsh-bot\n  name: ${baseline.name}\n  config:\n`).replace('    messagingEnabled: true\n', [
      '    messagingEnabled: true', '    memoryListLimit: 13', '    proactiveEnabled: false',
      '    proactiveExecutionEnabled: false', '    proactiveProvider: dp-b6b', '    proactiveModel: fixture',
      `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`, '',
    ].join('\n'));
    await writeFile(patchFile, patch);
    phase = 'old-host';
    const old = await host('old');
    const retained = await dataHashes();
    await save(dir, 'old-data-hashes', retained);
    assert.ok(retained.storage.length && retained.sessions.length && retained['home/dsh-bot'].length);
    const oldPatch = await readFile(patchFile);
    assert.notEqual(oldPatch.toString(), patch, 'Old Host did not persist the ConfigEditor fixture edit');
    await writeFile(resolve(dir, 'old-profile.patch.yml'), oldPatch);

    // The old Host has fully stopped. Keep this same home/profile and all native
    // persisted data while switching only the CLI used for subsequent commands.
    phase = 'target-version';
    run.env.DSH_BOT_DSH_BIN = targetCli;
    cliVersion = (await cli(phase, ['--version'])).trim();
    assert.ok(['0.2.1-rc.2', '0.2.2-rc.1', '0.2.2-rc.3'].includes(cliVersion), `Unqualified target CLI ${cliVersion}`);
    assert.deepEqual(await dataHashes(), retained, 'CLI selection changed durable data');
    assert.deepEqual(await readFile(patchFile), oldPatch, 'CLI selection changed profile settings');
    await save(dir, 'host-transition', { baselineCli: baselineCli ?? targetCli, targetCli,
      baselineCliVersion, targetCliVersion: cliVersion, profileDir,
      crossHostUpgrade: baselineCliVersion !== cliVersion, oldHostStopped: true,
      nativePersistedProfileReused: true, dataAndSettingsBytesPreservedAtTransition: true });

    if (renamed) {
      phase = 'old-remove';
      await cli(phase, ['plugin', ...flags, 'remove', baseline.name]);
      await removed(baseline.name);
      assert.deepEqual(await readFile(patchFile), oldPatch, 'Legacy removal changed profile settings');
      assert.deepEqual(await dataHashes(), retained, 'Legacy removal changed durable data');
    }
    phase = 'new-install';
    installedFiles.next = await install(candidate, nextPacked, phase);
    if (renamed) await removed(baseline.name);
    assert.deepEqual(await dataHashes(), retained, 'Upgrade changed durable data before startup');
    assert.deepEqual(await readFile(patchFile), oldPatch, 'Upgrade changed profile settings');

    if (renamed) {
      phase = 'unmigrated-config';
      const before = await cli(phase, [...flags, '--dump-config']);
      assert.match(before, /name mismatch[^\n]*dsh-botgroup/);
      assert.match(before, /^    memoryListLimit: 20$/m);
      assert.doesNotMatch(before, /^    memoryListLimit: 13$/m);
      phase = 'migrate-profile-name';
      const previous = '- id: dsh-bot\n  name: dsh-bot\n';
      const replacement = '- id: dsh-bot\n  name: dsh-botgroup\n';
      const text = oldPatch.toString('utf8');
      assert.equal(text.split(previous).length, 2, 'Expected one name-qualified override');
      const migrated = text.replace(previous, replacement);
      assert.equal(migrated.replace(replacement, previous), text);
      await writeFile(patchFile, migrated);
      await writeFile(resolve(dir, 'migrated-profile.patch.yml'), migrated);
    }
    phase = 'verify-retained-config';
    const dump = await cli(phase, [...flags, '--dump-config']);
    assert.doesNotMatch(dump, /name mismatch[^\n]*dsh-botgroup/);
    assert.match(dump, /^    memoryListLimit: 13$/m);
    assert.match(dump, /^    proactiveMaintenanceIntervalMs: 451$/m);
    const beforeSetup = await readFile(patchFile);
    phase = 'new-host';
    const upgraded = await host('new');
    const configuredPatch = await readFile(patchFile);
    assert.notDeepEqual(configuredPatch, beforeSetup, 'New Host did not persist scoped setup');
    await writeFile(resolve(dir, 'configured-profile.patch.yml'), configuredPatch);
    phase = 'cold-host';
    const cold = await host('cold');
    assert.deepEqual(await readFile(patchFile), configuredPatch, 'Cold restart rewrote profile settings');

    phase = 'remove-candidate';
    const beforeRemoval = await dataHashes();
    await save(dir, 'before-removal-data-hashes', beforeRemoval);
    await cli(phase, ['plugin', ...flags, 'remove', candidate.name]);
    await removed(candidate.name);
    assert.deepEqual(await dataHashes(), beforeRemoval, 'Uninstall changed durable data');
    assert.deepEqual(await readFile(patchFile), configuredPatch, 'Uninstall changed profile settings');
    phase = 'reinstall-candidate';
    installedFiles.reinstalled = await install(candidate, nextPacked, phase);
    assert.deepEqual(await dataHashes(), beforeRemoval, 'Reinstall changed durable data before startup');
    assert.deepEqual(await readFile(patchFile), configuredPatch, 'Reinstall changed profile settings');
    phase = 'reinstalled-host';
    // The cold stage checks retained state, scoped policy/bootstrap and zero model work.
    const reinstalled = await host('cold', 'reinstalled');
    assert.deepEqual(await readFile(patchFile), configuredPatch, 'Reinstalled Host rewrote profile settings');
    if (renamed) await removed(baseline.name);
    assert.equal((await readOptional(resolve(dir, 'network-denials.jsonl')))?.toString() ?? '', '');
    for (const artifact of [baseline, candidate]) assert.equal(sha256(await readFile(artifact.path)), artifact.sha256);
    const result = { status: 'PASS', lane: baseline.lane, cliVersion, baselineCliVersion, targetCliVersion: cliVersion,
      baselineCli: baselineCli ?? targetCli, targetCli, crossHostUpgrade: baselineCliVersion !== cliVersion,
      baseline, candidate, old, upgraded, cold, reinstalled,
      fixture: 'packages/dsh-bot/tests/v067-npm-upgrade-profile.mjs',
      legacyPackageRemoved: renamed, sameNameUpgrade: !renamed,
      profileSettingsBytesPreserved: true, nameQualifiedOverrideRequiredMigration: renamed,
      manualOverrideNameChange: renamed ? { from: baseline.name, to: candidate.name, retainedId: 'dsh-bot' } : null,
      installAndRemoveReinstallDataBytesRetained: true, installedFiles,
      registryAllowedForInstall, blockedNetworkAttempts: 0, realModelRequests: 0 };
    await save(dir, 'summary', result);
    return { ...result, dir };
  } catch (error) {
    const result = { status: 'FAIL', lane: baseline.lane, phase, baselineCliVersion, targetCliVersion: cliVersion,
      baselineCli: baselineCli ?? targetCli, targetCli, baseline, candidate, installedFiles,
      error: String(error), realModelRequests: 0 };
    await save(dir, 'summary', result);
    return { ...result, dir };
  } finally {
    run.stop();
    await save(dir, 'commands', run.commands);
  }
}

const results = [];
for (const baseline of baselines) {
  const result = await runLane(baseline);
  results.push(result);
  console.log(JSON.stringify({ status: result.status, lane: result.lane, phase: result.phase, dir: result.dir }));
  if (result.status !== 'PASS') break;
}
const status = results.length === baselines.length && results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL';
await save(directory, 'summary', { status, candidate, results,
  legacyBaseline: options.has('--legacy-artifact') ? 'RUN' : 'NOT_RUN (optional --legacy-artifact omitted)',
  publication: 'NOT_PERFORMED', dailyProfile: 'NOT_ACCESSED', realModelRequests: 0 });
console.log(JSON.stringify({ status, dir: directory, marker: 'V070_UPGRADE' }));
if (status !== 'PASS') process.exitCode = 1;
