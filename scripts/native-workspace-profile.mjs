// Isolated, cold profile migration to the official web-app. Never launches a Host.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeManifest, stoppedProcessPids, signatureDetails } from './deploy-official-desktop.mjs';
import { withProfileLock, exchangeProfileDirectories } from './update-bot-mode-desktop-plugin.mjs';
import { flattenEntryTree, normalizeAdapterEntryNames } from './install-official-desktop-compat.mjs';
import { openArchive } from '../adapters/bot-mode-desktop022/archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolated = join(root, '.dsh-dev');
const require = createRequire(join(root, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml'), { entryListSchema } = require('@deepseek-ai/cordis-plugin-include');
const official = '@deepseek-ai/dsh-web-app', legacy = 'dsh-bot-web-app';
const equal = (actual, expected, message = 'Integrity comparison failed') => assert.ok(isDeepStrictEqual(actual, expected), message);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
const within = (parent, child) => child !== parent && !isAbsolute(relative(parent, child)) && relative(parent, child) !== '..' && !relative(parent, child).startsWith(`..${sep}`);
const run = (bin, args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
const checked = (bin, args, options) => { const value = run(bin, args, options); assert.ok(!value.error && value.status === 0, `${bin.split('/').at(-1)} failed`); return value; };
async function canonical(path) { assert.equal(await realpath(path), path, 'Canonical paths required'); }
async function fresh(path) { await mkdir(path, { mode: 0o700 }); }
async function copy(from, to) { await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false }); }
async function isolatedProfileLinks(profile) {
  for (const row of (await treeManifest(profile)).entries.filter(row => row.type === 'symlink')) {
    assert.ok(!isAbsolute(row.target) && within(profile, resolve(dirname(join(profile, row.path)), row.target)), 'Profile links must be relative and remain profile-owned before staging');
  }
}

export function officialManifest(before) {
  const result = structuredClone(before), bundles = result.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), 'Profile bundle list required');
  assert.ok(!bundles.includes('dsh-bot-native-compat'), 'Experimental compatibility needs a reviewed manual migration');
  assert.equal(bundles.filter(name => name === official || name === legacy).length, 1, 'Expected exactly one official or legacy web-app selection');
  assert.equal(new Set(bundles).size, bundles.length, 'Duplicate bundle selection');
  const products = bundles.filter(name => ['dsh-bot', 'dsh-botgroup'].includes(name));
  assert.equal(products.length, 1, 'Expected one product; package-name migration is a separate operation');
  assert.ok(before.dependencies?.[products[0]], 'Selected product dependency is missing');
  result.dsh.profile.bundles = bundles.map(name => name === legacy ? official : name);
  return { manifest: result, product: products[0], kind: bundles.includes(legacy) ? 'active-legacy' : before.dependencies?.[legacy] ? 'residual-legacy' : 'official' };
}

export function preserveInstalledManifest(before, after, artifact, product) {
  const normalized = structuredClone(after);
  assert.equal(normalized.dependencies?.[product], `file:${artifact}`, 'Installer did not select the frozen product');
  normalized.dependencies[product] = before.dependencies[product];
  equal(normalized.dsh.profile.bundles.filter(name => name !== product), before.dsh.profile.bundles.filter(name => name !== product), 'Installer changed other bundle selections');
  normalized.dsh.profile.bundles = before.dsh.profile.bundles;
  equal(normalized, before, 'Installer changed unrelated manifest fields');
  const result = structuredClone(before); result.dependencies[product] = `file:${artifact}`;
  return result;
}

export function normalizedComposition(entries, home) {
  const normalize = value => typeof value === 'string' ? value.replaceAll(home, '<HOME>') : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)])) : value;
  return normalize(normalizeAdapterEntryNames(entries));
}
export function assertOfficialComposition(entries) {
  for (const row of flattenEntryTree(entries)) if (row.disabled !== true) {
    assert.ok(!/^dsh-bot-compat-/.test(row.id ?? '') && !/(?:dsh-bot-(?:web-app|native-compat)|\/adapters\/(?:shortcuts|ui-chat|ui-workspace)\/)/.test(row.name ?? ''), 'An active legacy adapter reference remains');
  }
  for (const id of ['shortcuts', 'ui-chat', 'ui-workspace']) {
    const rows = flattenEntryTree(entries).filter(row => row.id === id);
    assert.equal(rows.length, 1, `Native ID ${id} must be unique`);
    assert.ok(!rows[0].disabled, `Native ID ${id} disabled`);
    assert.equal(rows[0].name, `@deepseek-ai/dsh-client-${id}`, `Native ID ${id} is not official`);
  }
}

// Hash the supplied package itself: fallback artifacts need not equal current source.
export async function auditFrozenPackage(artifact, expectedSha, output) {
  assert.equal(sha(await readFile(artifact)), expectedSha, 'Artifact hash mismatch');
  const paths = checked('/usr/bin/tar', ['-tzf', artifact]).stdout.trim().split('\n');
  assert.ok(paths.length && paths.every(path => path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..')), 'Unsafe package path');
  assert.ok(checked('/usr/bin/tar', ['-tvzf', artifact]).stdout.trim().split('\n').every(line => /^[-d]/.test(line)), 'Package links and special files forbidden');
  await fresh(output); checked('/usr/bin/tar', ['-xzf', artifact, '-C', output]);
  const directory = join(output, 'package'), manifest = await json(join(directory, 'package.json'));
  assert.ok(['dsh-botgroup', 'dsh-bot'].includes(manifest.name), 'Expected a product package');
  assert.ok(manifest.dsh?.bundle, 'Product bundle declaration required');
  const inventory = await treeManifest(directory);
  assert.ok(inventory.entries.every(row => row.type !== 'symlink'));
  return { name: manifest.name, version: manifest.version, sha256: expectedSha, inventory };
}
async function verifyInstalled(home, audit) {
  const directory = await realpath(join(home, 'profiles/desktop/node_modules', audit.name));
  assert.ok(within(join(home, 'profiles/desktop'), directory), 'Product must remain profile-owned');
  for (const row of audit.inventory.entries.filter(row => row.type === 'file')) assert.equal(sha(await readFile(join(directory, row.path))), row.sha256, `Installed package mismatch: ${row.path}`);
}
function environment(home, folder, app) {
  return { PATH: process.env.PATH, SHELL: process.env.SHELL, USER: process.env.USER,
    HOME: join(folder, 'environment'), DSH_HOME: home, DSH_BOT_DSH_BIN: join(app, 'Contents/Resources/runtime/cli/bin/dsh'), ELECTRON_RUN_AS_NODE: '1',
    DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(folder, 'agents'), XDG_STATE_HOME: join(folder, 'state'), XDG_DATA_HOME: join(folder, 'data'), XDG_CONFIG_HOME: join(folder, 'config'), XDG_CACHE_HOME: join(folder, 'cache'), TMPDIR: join(folder, 'tmp'),
    pnpm_config_store_dir: join(isolated, 'pnpm-store'), pnpm_config_cache_dir: join(isolated, 'pnpm-cache'),
    pnpm_config_offline: 'true', npm_config_offline: 'true', pnpm_config_ignore_scripts: 'true', npm_config_ignore_scripts: 'true' };
}
async function prepareEnvironment(env) { for (const key of ['HOME', 'DSH_AGENTS_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[key], { recursive: true }); }
async function composeNative({ app, home, output, folder }) {
  const env = environment(home, folder, app); await prepareEnvironment(env);
  const result = run(join(app, 'Contents/MacOS/DeepSeek Harness'), [join(root, 'scripts/compose-official-desktop-profile.mjs'), '--app', app, '--home', home, '--profile-dir', join(home, 'profiles/desktop'), '--output', output], { cwd: root, env });
  await writeFile(output + '.log', `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600, flag: 'wx' });
  assert.ok(!result.error && result.status === 0, 'Staged native composition failed; inspect private log');
  return yaml.load(await readFile(output, 'utf8'), { schema: entryListSchema });
}
async function installNative({ app, home, artifact, folder }) {
  const env = environment(home, folder, app); delete env.ELECTRON_RUN_AS_NODE; await prepareEnvironment(env);
  const result = run(join(root, 'scripts/dsh'), ['plugin', '--profile', 'desktop', 'add', artifact], { cwd: root, env });
  await writeFile(join(folder, 'install.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`, { mode: 0o600, flag: 'wx' });
  assert.ok(!result.error && result.status === 0, 'Staged product installation failed');
}
async function appIdentity(app, expectedAsar, expectedVersion) {
  const bytes = await readFile(join(app, 'Contents/Resources/app.asar'));
  const digest = sha(bytes); if (expectedAsar) assert.equal(digest, expectedAsar, 'Official ASAR changed');
  const archive = openArchive(bytes), version = JSON.parse(archive.read('dsh/desktop-runtime.json')).release.version;
  if (expectedVersion) assert.equal(version, expectedVersion, 'Official runtime changed');
  checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const signature = checked('/usr/bin/codesign', ['--display', '--verbose=4', app]);
  const identity = signatureDetails(signature.stdout + signature.stderr);
  assert.equal(identity.teamId, 'NAN929V4UM'); assert.equal(identity.identifier, 'com.deepseek.dsh');
  checked('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"NAN929V4UM\" and identifier \"com.deepseek.dsh\"', app]);
  return { sha256: digest, version, signature: identity };
}

export async function createNativeWorkspaceMigration(options, dependencies = {}) {
  const paths = Object.fromEntries(['app', 'home', 'userData', 'artifact', 'fallbackArtifact', 'runDir'].map(key => { assert.ok(options[key] && isAbsolute(options[key]), `Absolute ${key} required`); return [key, resolve(options[key])]; }));
  paths.sourceApp = resolve(options.sourceApp ?? paths.app);
  for (const key of ['expectedSha', 'fallbackSha', 'expectedAsar']) assert.match(options[key] ?? '', /^[a-f0-9]{64}$/, `${key} required`);
  assert.ok(['0.2.2-rc.3', '0.2.2-rc.5'].includes(options.expectedVersion), 'Target must be an explicitly reviewed runtime');
  for (const key of ['home', 'userData', 'artifact', 'fallbackArtifact', 'runDir']) assert.ok(within(isolated, paths[key]), 'This runner only changes repository-isolated fixtures');
  const profile = join(paths.home, 'profiles/desktop');
  for (const app of [paths.app, paths.sourceApp]) for (const target of [paths.home, paths.userData, paths.runDir]) assert.ok(app !== target && !within(app, target) && !within(target, app), 'Read-only applications and mutable targets must be disjoint');
  for (const artifact of [paths.artifact, paths.fallbackArtifact]) for (const target of [paths.home, paths.userData, paths.runDir]) assert.ok(artifact !== target && !within(target, artifact), 'Frozen artifacts must be outside mutable targets');
  for (const path of [paths.app, paths.sourceApp, paths.home, paths.userData, paths.artifact, paths.fallbackArtifact, profile]) await canonical(path);
  for (const a of ['home', 'userData', 'runDir']) for (const b of ['home', 'userData', 'runDir']) if (a !== b) assert.ok(paths[a] !== paths[b] && !within(paths[a], paths[b]), 'Targets and receipts must be disjoint');
  for (let path = paths.runDir; path !== root; path = dirname(path)) { try { assert.ok(!(await lstat(path)).isSymbolicLink(), 'Receipt path traverses a symlink'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  const compose = dependencies.compose ?? composeNative, install = dependencies.install ?? installNative, identity = dependencies.appIdentity ?? appIdentity;
  const audit = dependencies.audit ?? auditFrozenPackage, verify = dependencies.verifyInstalled ?? verifyInstalled;
  const exchange = dependencies.exchange ?? exchangeProfileDirectories;
  const cold = dependencies.cold ?? (async () => {
    assert.equal(stoppedProcessPids(checked('/bin/ps', ['-axo', 'pid=,command=']).stdout, { ...paths, app: join(paths.runDir, 'no-application-target') }).length, 0, 'Target application or Host is running');
    for (const path of [paths.home, paths.userData]) { const r = run('/usr/sbin/lsof', ['-nP', '-t', '+D', path]); assert.ok(!r.error && [0, 1].includes(r.status) && !r.stderr.trim() && !r.stdout.trim(), 'Target data is open'); }
  });
  const nonProfile = async () => (await treeManifest(paths.home)).entries.filter(row => row.path !== 'profiles/desktop' && !row.path.startsWith('profiles/desktop/'));
  const outside = async () => ({ home: await nonProfile(), userData: await treeManifest(paths.userData) });
  const save = async (name, data) => { const handle = await open(join(paths.runDir, name + '.json'), 'wx', 0o600); try { await handle.writeFile(JSON.stringify({ schema: 1, paths, ...data }, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); } };
  async function stage(name, from = paths.home) {
    await isolatedProfileLinks(join(from, 'profiles/desktop'));
    const folder = join(paths.runDir, name); await fresh(folder); const home = join(folder, 'home'); await copy(from, home);
    assert.equal((await treeManifest(home)).sha256, (await treeManifest(from)).sha256, 'Staging copy mismatch');
    return { folder, home, app: paths.app, profile: join(home, 'profiles/desktop') };
  }
  async function composition(value, label) {
    const before = await treeManifest(value.home);
    const entries = await compose({ ...value, output: join(value.folder, label + '.yml') });
    assert.equal((await treeManifest(value.home)).sha256, before.sha256, 'Native composer normalized staged files; review this diff explicitly');
    return entries;
  }
  async function installStage(value, frozen, receipt, manifest) {
    const original = await treeManifest(value.profile), patch = await readFile(join(value.profile, 'cordis.patch.yml'));
    await install({ ...value, artifact: frozen });
    await writeFile(join(value.profile, 'package.json'), JSON.stringify(preserveInstalledManifest(manifest, await json(join(value.profile, 'package.json')), frozen, receipt.name), null, 2) + '\n');
    equal(await readFile(join(value.profile, 'cordis.patch.yml')), patch, 'Installer rewrote current configuration');
    // Only the native package manager owns dependency installation and lock changes.
    const unmanaged = tree => tree.entries.filter(row => !['package.json', 'pnpm-lock.yaml', 'node_modules'].includes(row.path) && !row.path.startsWith('node_modules/'));
    const oldRows = unmanaged(original), newRows = unmanaged(await treeManifest(value.profile));
    for (const row of oldRows) equal(newRows.find(next => next.path === row.path), row, 'Installer changed existing non-package profile data');
    for (const row of newRows.filter(next => !oldRows.some(old => old.path === next.path))) {
      const logDirectory = row.type === 'directory' && /^(?:\.plugin-manager(?:\/logs)?|\.plugin-manager\/logs\/operation-[A-Za-z0-9_-]+)$/.test(row.path);
      const logFile = row.type === 'file' && /^\.plugin-manager\/logs\/operation-[A-Za-z0-9_-]+\/pnpm\.log$/.test(row.path);
      assert.ok(logDirectory || logFile, 'Installer added unexplained non-package profile data');
    }
    await isolatedProfileLinks(value.profile);
    await verify(value.home, receipt);
  }
  async function locked(action) { await mkdir(join(isolated, 'profile-update-locks'), { recursive: true }); return withProfileLock(join(isolated, 'profile-update-locks', sha(paths.home)), action); }
  async function execute() { return locked(async () => {
    await fresh(paths.runDir); await cold(); const target = await identity(paths.app, options.expectedAsar, options.expectedVersion);
    const source = await identity(paths.sourceApp); const input = officialManifest(await json(join(profile, 'package.json')));
    const before = { profile: await treeManifest(profile), outside: await outside(), target, source, kind: input.kind };
    await save('before', before);
    const backup = join(paths.runDir, 'backup'); await fresh(backup); await copy(paths.home, join(backup, 'home')); await copy(paths.userData, join(backup, 'userData'));
    assert.equal((await treeManifest(join(backup, 'home'))).sha256, (await treeManifest(paths.home)).sha256); equal(await treeManifest(join(backup, 'userData')), before.outside.userData);
    const frozen = join(paths.runDir, 'product.tgz'), fallback = join(paths.runDir, 'fallback.tgz');
    await copy(paths.artifact, frozen); await copy(paths.fallbackArtifact, fallback);
    const product = await audit(frozen, options.expectedSha, join(paths.runDir, 'product-audit'));
    const fallbackProduct = await audit(fallback, options.fallbackSha, join(paths.runDir, 'fallback-audit'));
    assert.equal(product.name, input.product); assert.equal(fallbackProduct.name, input.product);
    const baseline = await stage('baseline'); baseline.app = paths.sourceApp;
    const effective = await composition(baseline, 'before');
    const safe = await stage('safe'); await writeFile(join(safe.profile, 'package.json'), JSON.stringify(input.manifest, null, 2) + '\n');
    await installStage(safe, fallback, fallbackProduct, input.manifest);
    const safeEntries = await composition(safe, 'official'); assertOfficialComposition(safeEntries);
    const sourceConfig = normalizedComposition(effective, baseline.home), targetConfig = normalizedComposition(safeEntries, safe.home);
    if (!isDeepStrictEqual(sourceConfig, targetConfig)) {
      const review = { beforeSha256: sha(JSON.stringify(sourceConfig)), afterSha256: sha(JSON.stringify(targetConfig)), sourceVersion: source.version, targetVersion: target.version };
      await save('composition-diff', { ...review, before: sourceConfig, after: targetConfig });
      assert.ok(options.compositionReview, 'Effective settings differ; inspect composition-diff.json and supply an exact reviewed receipt');
      const approved = await json(resolve(options.compositionReview));
      for (const key of ['beforeSha256', 'afterSha256', 'sourceVersion', 'targetVersion']) assert.equal(approved[key], review[key], 'Composition review does not match this exact transition');
      await save('composition-review', review);
    }
    const candidate = await stage('candidate', safe.home);
    await installStage(candidate, frozen, product, await json(join(candidate.profile, 'package.json')));
    const candidateEntries = await composition(candidate, 'candidate'); assertOfficialComposition(candidateEntries);
    equal(normalizedComposition(candidateEntries, candidate.home), normalizedComposition(safeEntries, safe.home), 'Product installation changed effective settings');
    const transaction = { before: before.profile, installed: await treeManifest(candidate.profile), fallback: await treeManifest(safe.profile), target, product, fallbackProduct };
    await save('transaction', transaction);
    await cold(); equal(await treeManifest(profile), before.profile, 'Current profile changed during staging'); equal(await outside(), before.outside, 'Current data changed during staging');
    equal(await identity(paths.app, options.expectedAsar, options.expectedVersion), target, 'Application changed during staging');
    // The transaction was persisted before exchange, so missing installed.json is recoverable.
    exchange(profile, candidate.profile);
    try {
      equal(await treeManifest(profile), transaction.installed, 'Profile exchange mismatch');
      await verify(paths.home, product); equal(await outside(), before.outside, 'Data outside profile changed');
      await save('installed', { status: 'PASS', artifactSha256: options.expectedSha, profile: transaction.installed, officialComposition: true, dormantCompatibilityRetained: Boolean(input.manifest.dependencies?.[legacy]), realModelRequests: 0 });
      return { status: 'PASS', runDir: paths.runDir, kind: input.kind };
    } catch (error) {
      let restored = false;
      try {
        await cold();
        equal(await treeManifest(profile), transaction.installed, 'Newer profile changes forbid automatic rollback');
        equal(await treeManifest(safe.profile), transaction.fallback, 'Fallback snapshot changed');
        const latestData = await outside(), recovery = join(paths.runDir, 'automatic-recovery'); await copy(safe.profile, recovery);
        exchange(profile, recovery); equal(await treeManifest(profile), transaction.fallback); equal(await outside(), latestData);
        restored = true;
      } catch { /* Keep exact transaction and both profiles for explicit reviewed recovery. */ }
      await save('failure', { status: 'FAIL', officialFallbackRestored: restored, recoveryRequired: !restored });
      throw new Error(restored ? 'Verification failed; official fallback restored without restoring user data' : 'Verification failed; current profile retained for reviewed recovery', { cause: error });
    }
  }); }
  async function rollback({ targeted = false } = {}) { return locked(async () => {
    const transaction = await json(join(paths.runDir, 'transaction.json')); equal(transaction.paths, paths, 'Rollback target mismatch');
    await cold(); equal(await identity(paths.app, options.expectedAsar, options.expectedVersion), transaction.target);
    const current = await treeManifest(profile), data = await outside();
    if (!targeted) equal(current, transaction.installed, 'Profile changed; refuse to overwrite newer settings; use reviewed targeted rollback');
    const safeProfile = join(paths.runDir, 'safe/home/profiles/desktop'); equal(await treeManifest(safeProfile), transaction.fallback, 'Fallback snapshot changed');
    const value = await stage('rollback-' + Date.now());
    if (targeted) {
      const selection = officialManifest(await json(join(value.profile, 'package.json'))); assert.equal(selection.kind === 'active-legacy', false, 'Targeted rollback never reactivates an adapter');
      const effective = await composition(value, 'current'); assertOfficialComposition(effective);
      await installStage(value, join(paths.runDir, 'fallback.tgz'), transaction.fallbackProduct, selection.manifest);
      const next = await composition(value, 'fallback'); assertOfficialComposition(next); equal(next, effective, 'Fallback changes current effective settings');
    } else {
      const replacement = join(value.folder, 'safe-profile'); await copy(safeProfile, replacement);
      exchange(value.profile, replacement);
    }
    const post = await treeManifest(value.profile);
    await cold(); equal(await treeManifest(profile), current, 'Profile changed during rollback staging'); equal(await outside(), data);
    exchange(profile, value.profile); equal(await treeManifest(profile), post); equal(await outside(), data);
    await save('rollback-' + Date.now(), { status: 'PASS', targeted, officialComposition: true, preservedLaterHistory: true, profile: post });
    return { status: 'PASS', targeted, officialComposition: true };
  }); }
  return { execute, rollback, paths };
}

export function parseNativeMigrationArguments(args) {
  const [action, ...rest] = args; assert.ok(['install', 'rollback', 'rollback-targeted'].includes(action), 'Expected install|rollback|rollback-targeted');
  const names = { '--app': 'app', '--source-app': 'sourceApp', '--home': 'home', '--user-data': 'userData', '--artifact': 'artifact', '--fallback-artifact': 'fallbackArtifact', '--run-dir': 'runDir', '--expected-sha': 'expectedSha', '--fallback-sha': 'fallbackSha', '--expected-asar': 'expectedAsar', '--expected-version': 'expectedVersion', '--composition-review': 'compositionReview' }, options = {};
  for (let index = 0; index < rest.length; index += 2) { const key = names[rest[index]]; assert.ok(key && rest[index + 1] && !options[key], 'Unknown, duplicate or incomplete option'); options[key] = rest[index + 1]; }
  return { action, options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { action, options } = parseNativeMigrationArguments(process.argv.slice(2)); const migration = await createNativeWorkspaceMigration(options); console.log(JSON.stringify(action === 'install' ? await migration.execute() : await migration.rollback({ targeted: action === 'rollback-targeted' }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
