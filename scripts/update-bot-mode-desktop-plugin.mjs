// Orchestrator-only. No application writes, launches, signing, or data restores.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signatureDetails, stoppedProcessPids, treeManifest } from './deploy-official-desktop.mjs';
import { flattenEntryTree } from './install-official-desktop-compat.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';
import { openArchive } from '../adapters/bot-mode-desktop022/archive.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml'), { entryListSchema } = require('@deepseek-ai/cordis-plugin-include');
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => child !== parent && relative(parent, child) !== '..' && !relative(parent, child).startsWith(`..${sep}`) && !isAbsolute(relative(parent, child));
const swapCode = 'import ctypes,sys; libc=ctypes.CDLL(None,use_errno=True); f=libc.renamex_np; f.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]; f.restype=ctypes.c_int; sys.exit(0 if f(sys.argv[1].encode(),sys.argv[2].encode(),2)==0 else 1)';
const nativeCommand = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
const adapterIds = ['shortcuts', 'ui-chat', 'ui-workspace'];
const officialVersion = '0.2.2-rc.3';
const officialPatchPaths = ['./cordis.patch.yml', './presets/standard.patch.yml', './presets/ptc.patch.yml', './presets/minimal.patch.yml', './presets/cordis.patch.yml'];

/** A reviewed tree hash permits the three patched Clients, not a different Host or declaration bundle. */
export async function verifyAdapterProvenance(path, receipt, archive, tree) {
  const manifest = JSON.parse(await readFile(join(path, 'package.json')));
  assert.equal(manifest.name, 'dsh-bot-web-app'); assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.engines?.dsh, officialVersion, 'Adapter must pin the exact official release');
  assert.equal(receipt.packageName, manifest.name); assert.equal(receipt.replacesBundle, '@deepseek-ai/dsh-web-app');
  assert.equal(receipt.officialWebAppVersion, officialVersion); assert.equal(receipt.applicationUnchanged, true);
  assert.deepEqual(receipt.loaderIds, adapterIds); assert.deepEqual(receipt.configuredEntries, []);
  assert.deepEqual(receipt.officialPatchPaths, officialPatchPaths);
  assert.deepEqual(manifest.dsh?.bundle?.patch, officialPatchPaths.map(file => `./official-web-app/${file.slice(2)}`));
  const officialPrefix = 'dsh/node_modules/@deepseek-ai/dsh-web-app/';
  const official = JSON.parse(archive.read(`${officialPrefix}package.json`));
  assert.equal(official.name, '@deepseek-ai/dsh-web-app'); assert.equal(official.version, officialVersion);
  assert.deepEqual(official.dsh?.bundle?.patch, officialPatchPaths, 'Official declaration layers changed');
  assert.deepEqual(Object.keys(receipt.packages ?? {}).sort(), [...adapterIds].sort());
  for (const id of adapterIds) {
    const entry = receipt.packages[id], packageName = `@deepseek-ai/dsh-client-${id}`;
    const prefix = `dsh/node_modules/${packageName}/`;
    const native = JSON.parse(archive.read(`${prefix}package.json`));
    assert.equal(entry.packageName, packageName); assert.equal(entry.version, officialVersion); assert.equal(entry.prefix, prefix);
    assert.equal(native.name, packageName); assert.equal(native.version, officialVersion);
    assert.equal(entry.hostSha256, sha(archive.read(`${prefix}lib/index.js`)));
    assert.equal(entry.clientSha256, sha(archive.read(`${prefix}lib/client.js`)));
  }
  const rows = [...receipt.inventory, ...receipt.officialInventory];
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length, 'Duplicate adapter inventory file');
  const expectedFiles = archive.files.flatMap(file => {
    if (file.path.startsWith(officialPrefix)) return [`official-web-app/${file.path.slice(officialPrefix.length)}`];
    for (const id of adapterIds) {
      const prefix = receipt.packages[id].prefix;
      if (file.path.startsWith(prefix)) return [`adapters/${id}/${file.path.slice(prefix.length)}`];
    }
    return [];
  });
  assert.deepEqual(rows.map(row => row.path).sort(), expectedFiles.sort(), 'Adapter must retain the complete official package inventories');
  const files = tree.entries.filter(row => /^(?:adapters|official-web-app)\//.test(row.path));
  assert.ok(files.every(row => row.type !== 'symlink'), 'Adapter sources must not escape through links');
  assert.deepEqual(files.filter(row => row.type === 'file').map(row => row.path).sort(), rows.map(row => row.path).sort(), 'Adapter inventory must cover every source file');
  for (const row of rows) {
    assert.ok(inside(path, resolve(path, row.path)), 'Unsafe adapter inventory path');
    const installed = await readFile(join(path, row.path));
    assert.equal(installed.length, row.bytes); assert.equal(sha(installed), row.sha256, 'Adapter inventory mismatch');
    const adapter = /^adapters\/(shortcuts|ui-chat|ui-workspace)\/(.+)$/.exec(row.path);
    if (adapter) {
      const original = archive.read(`${receipt.packages[adapter[1]].prefix}${adapter[2]}`);
      assert.equal(row.changed, adapter[2] === 'lib/client.js', 'Only reviewed Client files can differ');
      if (!row.changed) assert.equal(row.sha256, sha(original), 'Adapter Host/source differs from the official archive');
    } else {
      assert.ok(row.path.startsWith('official-web-app/'), 'Unknown adapter inventory source');
      const local = row.path.slice('official-web-app/'.length), original = archive.read(`${officialPrefix}${local}`);
      assert.equal(row.originalSha256, sha(original), 'Official source receipt differs from the archive');
      assert.equal(row.changed, local === 'cordis.patch.yml');
      let expected = original.toString();
      if (row.changed) for (const id of adapterIds) {
        const anchor = `name: '@deepseek-ai/dsh-client-${id}'`;
        assert.equal(expected.split(anchor).length, 2, 'Official declaration anchor changed');
        expected = expected.replace(anchor, `name: ../adapters/${id}/lib/index.js`);
      }
      assert.equal(row.sha256, sha(row.changed ? Buffer.from(expected) : original), 'Official layers changed beyond the three Client entry names');
    }
  }
}

// An advisory OS lock disappears even when the updater is killed. The child
// holds flock while its parent-owned stdin remains open; no stale PID unlink
// race, permanent lockfile, or process-name guess is needed for recovery.
export async function withProfileLock(path, action) {
  const code = 'import fcntl,os,sys; f=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("LOCKED",flush=True); sys.stdin.read()';
  const child = spawn('/usr/bin/python3', ['-c', code, path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.resume();
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  try {
    await Promise.race([
      new Promise(accept => child.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED\n')) accept(); })),
      done.then(() => { throw new Error('Profile update lock is held or unavailable; no target changes were made'); }),
    ]);
    return await action();
  } finally { child.stdin.end(); await done; }
}

/** Darwin exchanges both existing directories in one filesystem operation. */
export function exchangeProfileDirectories(profile, stage, command = nativeCommand) {
  const result = command('/usr/bin/python3', ['-c', swapCode, profile, stage]);
  assert.ok(!result.error && result.status === 0, 'Atomic profile exchange failed; both existing directories were retained');
}

export function preserveProductManifest(before, installed, frozen) {
  assert.ok(before.dependencies?.['dsh-bot'] && installed.dependencies?.['dsh-bot'], 'Expected existing product dependency');
  const normalized = structuredClone(installed);
  assert.equal(normalized.dependencies['dsh-bot'], `file:${frozen}`, 'Installer must select frozen product');
  normalized.dependencies['dsh-bot'] = before.dependencies['dsh-bot'];
  const bundles = before.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles) && bundles.filter(name => name === 'dsh-bot').length === 1, 'Expected one product bundle');
  assert.deepEqual(normalized.dsh.profile.bundles.filter(name => name !== 'dsh-bot'), bundles.filter(name => name !== 'dsh-bot'), 'Unrelated bundles changed');
  normalized.dsh.profile.bundles = bundles;
  assert.deepEqual(normalized, before, 'Unrelated manifest fields changed');
  const result = structuredClone(before); result.dependencies['dsh-bot'] = `file:${frozen}`;
  return result;
}

export async function createProfileUpdate(options, dependencies = {}) {
  const root = await realpath(options.root ?? repoRoot), command = dependencies.command ?? nativeCommand;
  const paths = { app: resolve(options.app ?? '/Applications/DeepSeek Harness.app'), home: resolve(options.home ?? join(homedir(), '.dsh')),
    userData: resolve(options.userData ?? join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop')),
    artifact: resolve(options.artifact), runDir: resolve(options.runDir) };
  assert.ok(inside(root, paths.runDir) && inside(root, paths.artifact) && !inside(paths.runDir, paths.artifact), 'Use repository-local frozen input and a separate fresh receipt directory');
  for (const key of ['expectedSha', 'expectedAsar', 'expectedCompatTree']) assert.match(options[key] ?? '', /^[a-f0-9]{64}$/, `Explicit ${key} SHA-256 required`);
  const profile = join(paths.home, 'profiles/desktop');
  for (const path of [paths.app, paths.home, paths.userData, paths.artifact, profile]) assert.equal(await realpath(path), path, 'Canonical target paths required');
  const protectedPaths = [paths.app, paths.home, paths.userData];
  for (const [index, path] of protectedPaths.entries()) {
    assert.ok(path !== root && !inside(path, root) && !inside(path, paths.runDir), 'Protected target cannot contain repository or receipts');
    for (const other of protectedPaths.slice(index + 1)) assert.ok(path !== other && !inside(path, other) && !inside(other, path), 'Protected targets must be disjoint');
  }
  for (let path = paths.runDir; path !== root; path = dirname(path)) if (await exists(path)) assert.ok(!(await lstat(path)).isSymbolicLink(), 'Receipt path cannot traverse symlinks');
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 }); await chmod(paths.runDir, 0o700);
  assert.equal((await lstat(profile)).dev, (await lstat(paths.runDir)).dev, 'Atomic rollback needs same filesystem');
  const json = path => readFile(path, 'utf8').then(JSON.parse);
  const save = async (name, value) => {
    const handle = await open(join(paths.runDir, name), 'wx', 0o600);
    try { await handle.writeFile(typeof value === 'string' ? value : `${JSON.stringify({ schema: 1, createdAt: new Date().toISOString(), paths, ...value }, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  };
  const checked = (file, args, opts) => { const result = command(file, args, opts); assert.ok(!result.error && result.status === 0, `${file.split('/').at(-1)} failed; inspect private receipts`); return result; };
  const env = { PATH: process.env.PATH, SHELL: process.env.SHELL, USER: process.env.USER,
    HOME: join(paths.runDir, 'environment-home'), DSH_HOME: paths.home, DSH_BOT_DSH_BIN: join(paths.app, 'Contents/Resources/runtime/cli/bin/dsh'),
    DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(paths.runDir, 'agents'), XDG_STATE_HOME: join(paths.runDir, 'state'),
    XDG_DATA_HOME: join(paths.runDir, 'data'), XDG_CONFIG_HOME: join(paths.runDir, 'config'), XDG_CACHE_HOME: join(paths.runDir, 'cache'),
    NODE_COMPILE_CACHE: join(paths.runDir, 'node-cache'), TMPDIR: join(paths.runDir, 'tmp'),
    pnpm_config_store_dir: join(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: join(root, '.dsh-dev/pnpm-cache'),
    pnpm_config_offline: 'true', npm_config_offline: 'true', pnpm_config_ignore_scripts: 'true', npm_config_ignore_scripts: 'true' };
  async function cold() {
    assert.equal(stoppedProcessPids(checked('/bin/ps', ['-axo', 'pid=,command=']).stdout, paths).length, 0, 'Quit desktop and Host gracefully first');
    for (const path of protectedPaths) {
      const result = dependencies.lsof ? dependencies.lsof(path) : command('/usr/sbin/lsof', ['-nP', '-t', '+D', path]);
      assert.ok(!result.error && [0, 1].includes(result.status) && !(result.stderr ?? '').trim(), 'Incomplete open-file inspection');
      assert.equal((result.stdout ?? '').trim(), '', 'Desktop or data files still open');
    }
  }
  async function application() {
    assert.equal(sha(await readFile(join(paths.app, 'Contents/Resources/app.asar'))), options.expectedAsar, 'Official ASAR hash mismatch');
    checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.app]);
    const displayed = checked('/usr/bin/codesign', ['--display', '--verbose=4', paths.app]);
    const signature = signatureDetails(`${displayed.stdout ?? ''}${displayed.stderr ?? ''}`);
    assert.equal(signature.teamId, 'NAN929V4UM', 'Expected official DeepSeek publisher'); assert.equal(signature.identifier, 'com.deepseek.dsh');
    checked('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"', paths.app]);
    checked('/usr/sbin/spctl', ['--assess', '--type', 'execute', paths.app]);
    assert.equal(checked('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(paths.app, 'Contents/Info.plist')]).stdout.trim(), '0.2.2-rc.3', 'Review a different official release separately');
    return { signature, manifest: await treeManifest(paths.app) };
  }
  async function compatibility() {
    const manifest = await json(join(profile, 'package.json'));
    assert.deepEqual(manifest.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', 'dsh-bot-web-app', 'dsh-bot'], 'Expected reviewed independent web-app composition');
    const path = await realpath(join(profile, 'node_modules/dsh-bot-web-app'));
    assert.ok(inside(profile, path), 'Adapter must be profile-owned');
    const tree = await treeManifest(path); assert.equal(tree.sha256, options.expectedCompatTree, 'Independent adapter changed');
    const receipt = await json(join(path, 'compatibility.json'));
    assert.equal(receipt.mode, 'web-app-replacement'); assert.equal(receipt.version, officialVersion); assert.equal(receipt.archiveSha256, options.expectedAsar);
    const archiveBytes = await readFile(join(paths.app, 'Contents/Resources/app.asar'));
    assert.equal(sha(archiveBytes), options.expectedAsar, 'Official archive changed during source verification');
    await verifyAdapterProvenance(path, receipt, openArchive(archiveBytes), tree);
    return { path, tree };
  }
  async function nonProfile() { return (await treeManifest(paths.home)).entries.filter(row => row.path !== 'profiles/desktop' && !row.path.startsWith('profiles/desktop/')); }
  async function compose(label, adapterPath) {
    const output = join(paths.runDir, `${label}.yml`);
    const result = command(join(paths.app, 'Contents/MacOS/DeepSeek Harness'), ['--expose-internals', join(repoRoot, 'scripts/compose-official-desktop-profile.mjs'), '--app', paths.app, '--profile-dir', profile, '--home', paths.home, '--output', output], { cwd: repoRoot, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
    await save(`${label}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.ok(!result.error && result.status === 0, 'Offline public composition failed');
    const entries = yaml.load(await readFile(output, 'utf8'), { schema: entryListSchema });
    for (const id of ['shortcuts', 'ui-chat', 'ui-workspace']) {
      const rows = flattenEntryTree(entries).filter(row => row.id === id && !row.disabled);
      assert.equal(rows.length, 1, `Expected one active ${id}`);
      const expected = join(adapterPath, 'adapters', id, 'lib/index.js');
      const entry = rows[0].name.startsWith('file:') ? fileURLToPath(rows[0].name) : rows[0].name;
      assert.ok(isAbsolute(entry), 'Expected an absolute profile Client entry');
      assert.equal(resolve(entry), expected, 'Effective Client entry differs from the reviewed adapter');
      assert.equal(await realpath(entry), expected, 'Effective Client entry is not the reviewed regular file');
    }
    return entries;
  }
  async function backupIntegrity(before) { for (const key of ['app', 'home', 'userData']) assert.equal((await treeManifest(join(paths.runDir, 'backup', key))).sha256, before.manifests[key].sha256, `Backup ${key} changed`); }
  async function restore(before, automatic) {
    await cold(); await backupIntegrity(before);
    assert.equal((await application()).manifest.sha256, before.application.manifest.sha256, 'Application changed; refuse rollback');
    const stage = join(paths.runDir, `profile-restore-${Date.now()}`);
    checked('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', join(paths.runDir, 'backup/home/profiles/desktop'), stage]);
    assert.equal((await treeManifest(stage)).sha256, before.profile.sha256, 'Rollback staging mismatch');
    exchangeProfileDirectories(profile, stage, command);
    assert.equal((await treeManifest(profile)).sha256, before.profile.sha256, 'Restored profile mismatch');
    await save(`rollback-${Date.now()}.json`, { status: 'PASS', automatic, failedProfile: stage, profileRestored: true, userDataOverwritten: false });
  }
  async function locked(action) {
    const folder = join(root, '.dsh-dev/profile-update-locks'); await mkdir(folder, { recursive: true, mode: 0o700 });
    return withProfileLock(join(folder, sha(paths.home)), action);
  }
  async function execute() { return locked(async () => {
    assert.ok(!(await exists(join(paths.runDir, 'before.json'))), 'Fresh update run directory required');
    let before, changed = false;
    try {
      await cold(); const app = await application(), compat = await compatibility();
      assert.equal(sha(await readFile(paths.artifact)), options.expectedSha, 'Frozen product hash mismatch');
      const frozen = join(paths.runDir, 'product-input.tgz'); await copyFile(paths.artifact, frozen); assert.equal(sha(await readFile(frozen)), options.expectedSha);
      const listing = checked('/usr/bin/tar', ['-tvzf', frozen]).stdout.trim().split('\n'); assert.ok(listing.length && listing.every(line => /^[-d]/.test(line)), 'Tar links or special files forbidden');
      const audit = await (dependencies.auditArtifact ?? auditArtifact)(repoRoot, frozen, paths.runDir); assert.equal(audit.sha256, options.expectedSha);
      before = { application: app, compatibility: compat, manifests: {}, profile: await treeManifest(profile), nonProfile: await nonProfile(),
        package: await json(join(profile, 'package.json')), patch: sha(await readFile(join(profile, 'cordis.patch.yml'))) };
      for (const key of ['app', 'home', 'userData']) {
        before.manifests[key] = key === 'app' ? app.manifest : await treeManifest(paths[key]);
        checked('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', paths[key], join(paths.runDir, 'backup', key)]);
      }
      await backupIntegrity(before); await save('before.json', { status: 'PASS', ...before });
      for (const key of ['HOME', 'DSH_AGENTS_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[key], { recursive: true });
      const effective = await compose('effective-before', compat.path); await cold(); assert.equal((await treeManifest(profile)).sha256, before.profile.sha256, 'Profile changed during preparation');
      changed = true;
      const installed = command(join(repoRoot, 'scripts/dsh'), ['plugin', '--profile', 'desktop', 'add', frozen], { cwd: repoRoot, env });
      await save('install.log', `${installed.stdout ?? ''}\n${installed.stderr ?? ''}`); assert.ok(!installed.error && installed.status === 0, 'Profile install failed');
      const manifest = preserveProductManifest(before.package, await json(join(profile, 'package.json')), frozen);
      await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      assert.equal(sha(await readFile(join(profile, 'cordis.patch.yml'))), before.patch, 'User configuration changed');
      assert.deepEqual(await compose('effective-after', compat.path), effective, 'Effective model, permissions, modes or settings changed');
      const receipt = await (dependencies.auditInstalled ?? auditInstalled)(paths.home, 'desktop', audit);
      assert.equal((await compatibility()).tree.sha256, before.compatibility.tree.sha256);
      assert.deepEqual(await nonProfile(), before.nonProfile, 'Cold data outside profile changed');
      assert.equal((await treeManifest(paths.userData)).sha256, before.manifests.userData.sha256, 'Desktop preferences changed');
      assert.equal((await application()).manifest.sha256, before.application.manifest.sha256, 'Official application changed');
      await backupIntegrity(before); await cold();
      await save('installed.json', { status: 'PASS', artifactSha256: audit.sha256, installed: receipt, officialApplicationUnchanged: true, coldDataUnchanged: true,
        effectiveSettingsUnchanged: true, profile: await treeManifest(profile), realModelRequests: 0 });
      return { status: 'PASS', runDir: paths.runDir, artifactSha256: audit.sha256 };
    } catch (error) {
      let restored = false;
      if (changed) { try { await restore(before, true); restored = true; } catch (rollbackError) { await save('rollback-error.log', String(rollbackError.stack)); } }
      await save('failure-detail.log', String(error.stack));
      await save('failure.json', { status: 'FAIL', profileChanged: changed, profileRestored: restored, recoveryRequired: changed && !restored });
      throw new Error(changed ? restored ? 'Update failed; complete profile restored; inspect private receipts' : 'Update failed; profile recovery required; inspect private receipts' : 'Update refused before profile changes; inspect inputs', { cause: error });
    }
  }); }
  async function rollback() { return locked(async () => {
    const before = await json(join(paths.runDir, 'before.json')), installed = await json(join(paths.runDir, 'installed.json'));
    for (const row of [before, installed]) assert.deepEqual(row.paths, paths, 'Rollback target differs');
    await cold(); assert.equal((await treeManifest(profile)).sha256, installed.profile.sha256, 'Profile changed since update; refuse to overwrite newer settings');
    const data = await nonProfile(), preferences = await treeManifest(paths.userData);
    await restore(before, false); assert.deepEqual(await nonProfile(), data); assert.equal((await treeManifest(paths.userData)).sha256, preferences.sha256);
    return { status: 'PASS', action: 'rollback-profile', userDataOverwritten: false };
  }); }
  async function recover() { return locked(async () => {
    assert.match(options.expectedCurrentProfile ?? '', /^[a-f0-9]{64}$/, 'Recovery requires explicit reviewed current profile SHA-256');
    const before = await json(join(paths.runDir, 'before.json'));
    assert.deepEqual(before.paths, paths, 'Recovery target differs'); await cold();
    assert.equal((await treeManifest(profile)).sha256, options.expectedCurrentProfile, 'Current profile differs from the reviewed interrupted state');
    const data = await nonProfile(), preferences = await treeManifest(paths.userData);
    await restore(before, false); assert.deepEqual(await nonProfile(), data);
    assert.equal((await treeManifest(paths.userData)).sha256, preferences.sha256);
    return { status: 'PASS', action: 'recover-interrupted-profile', userDataOverwritten: false };
  }); }
  return { execute, rollback, recover, paths };
}

export function parseProfileUpdateArguments(args) {
  const [action, ...rest] = args; assert.ok(['install', 'rollback', 'recover'].includes(action), 'Usage: install|rollback|recover --artifact ABS --run-dir ABS --expected-sha SHA --expected-asar SHA --expected-compat-tree SHA');
  const names = { '--artifact': 'artifact', '--run-dir': 'runDir', '--expected-sha': 'expectedSha', '--expected-asar': 'expectedAsar', '--expected-compat-tree': 'expectedCompatTree', '--expected-current-profile': 'expectedCurrentProfile', '--app': 'app', '--home': 'home', '--user-data': 'userData' }, options = {};
  for (let index = 0; index < rest.length; index += 2) { const key = names[rest[index]]; assert.ok(key && rest[index + 1] && !options[key], 'Unknown, duplicate or incomplete option'); options[key] = rest[index + 1]; }
  for (const key of ['artifact', 'runDir']) assert.ok(options[key] && isAbsolute(options[key]), `Absolute ${key} required`);
  return { action, options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { action, options } = parseProfileUpdateArguments(process.argv.slice(2)), updater = await createProfileUpdate(options);
    console.log(JSON.stringify(await (action === 'install' ? updater.execute() : action === 'rollback' ? updater.rollback() : updater.recover())));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
