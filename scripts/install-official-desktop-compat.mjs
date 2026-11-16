// Orchestrator-only cold profile migration. Does not replace the application,
// reinstall dsh-bot, launch a Host, create sessions, or restore user data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signatureDetails, stoppedProcessPids, treeManifest } from './deploy-official-desktop.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml');
// Public Cordis entry point, preserving !!js as data; no expression evaluation.
const { entryListSchema } = require('@deepseek-ai/cordis-plugin-include');
const packageName = 'dsh-bot-web-app';
const originalBundle = '@deepseek-ai/dsh-web-app';
const digest = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => child !== parent && !relative(parent, child).startsWith(`..${sep}`) && relative(parent, child) !== '..' && !isAbsolute(relative(parent, child));
const swapCode = 'import ctypes,sys; libc=ctypes.CDLL(None,use_errno=True); f=libc.renamex_np; f.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint]; f.restype=ctypes.c_int; r=f(sys.argv[1].encode(),sys.argv[2].encode(),2); sys.exit(0 if r==0 else 1)';
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function hashFile(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
const nativeCommand = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });

export function replaceBundleAtOriginalPosition(before, afterAdd) {
  const original = before.dsh?.profile?.bundles;
  assert.ok(Array.isArray(original) && original.filter(name => name === originalBundle).length === 1, 'Profile must select exactly one original official web-app');
  assert.ok(!original.some(name => [packageName, 'dsh-bot-native-compat'].includes(name)), 'Existing compatibility selection requires separate review');
  const after = structuredClone(afterAdd);
  assert.ok(typeof after.dependencies?.[packageName] === 'string', 'Plugin installation did not add the reviewed compatibility dependency');
  const normalized = structuredClone(after);
  delete normalized.dependencies[packageName];
  if (!before.dependencies && Object.keys(normalized.dependencies).length === 0) delete normalized.dependencies;
  assert.deepEqual(normalized.dsh.profile.bundles.filter(name => name !== packageName), original, 'Plugin installation changed existing bundle order');
  normalized.dsh.profile.bundles = original;
  assert.deepEqual(normalized, before, 'Plugin installation changed unrelated manifest fields or product dependencies');
  const result = structuredClone(before);
  result.dependencies ??= {};
  result.dependencies[packageName] = after.dependencies[packageName];
  result.dsh.profile.bundles = original.map(name => name === originalBundle ? packageName : name);
  return result;
}

export function migrateChatPatch(originalText, effectiveYaml) {
  const entries = yaml.load(effectiveYaml, { schema: entryListSchema });
  assert.ok(Array.isArray(entries), 'Effective configuration is not an entry list');
  const rows = flattenEntryTree(entries).filter(row => row?.id === 'ui-chat' && !row.disabled);
  assert.equal(rows.length, 1, 'Expected one active native ui-chat entry');
  assert.equal(rows[0].name, '@deepseek-ai/dsh-client-ui-chat', 'Pre-migration ui-chat must use the original canonical package');
  const config = rows[0].config ?? {};
  assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'ui-chat config must be a mapping');
  const appended = yaml.dump([{ id: 'ui-chat', config }], { schema: entryListSchema, noRefs: true, lineWidth: -1 });
  return { text: `${originalText}${originalText.endsWith('\n') ? '' : '\n'}# Profile-owned web-app migration: preserve native ui-chat effective config.\n${appended}`, config, entries };
}

export function flattenEntryTree(entries) {
  return entries.flatMap(row => [row, ...(row?.group && Array.isArray(row.config) ? flattenEntryTree(row.config) : [])]);
}
export function normalizeAdapterEntryNames(entries) {
  return entries.map(row => ({ ...row,
    ...(row.group && Array.isArray(row.config) ? { config: normalizeAdapterEntryNames(row.config) } : {}),
    ...(['shortcuts', 'ui-chat', 'ui-workspace'].includes(row.id) ? { name: `@deepseek-ai/dsh-client-${row.id}` } : {}),
  }));
}

export async function createCompatibilityMigration(options, dependencies = {}) {
  const root = await realpath(options.root ?? repoRoot), command = dependencies.command ?? nativeCommand;
  const paths = {
    app: resolve(options.app ?? '/Applications/DeepSeek Harness.app'), home: resolve(options.home ?? join(homedir(), '.dsh')),
    userData: resolve(options.userData ?? join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop')),
    compat: resolve(options.compat), runDir: resolve(options.runDir),
  };
  const deployRunDir = resolve(options.deployRunDir ?? join(dirname(paths.runDir), 'deploy'));
  assert.ok(within(root, paths.runDir) && within(root, deployRunDir), 'Migration/deployment receipts must be repository-local');
  for (const folder of [paths.runDir, deployRunDir]) for (let path = folder; path !== root; path = dirname(path)) if (await exists(path)) assert.ok(!(await lstat(path)).isSymbolicLink(), 'Receipt paths cannot traverse symlinks');
  assert.ok(paths.runDir !== deployRunDir && !within(paths.runDir, deployRunDir) && !within(deployRunDir, paths.runDir), 'Use separate deployment and migration receipt directories');
  const profile = join(paths.home, 'profiles/desktop');
  for (const path of [paths.app, paths.home, paths.userData]) {
    assert.ok(path !== paths.runDir && !within(path, paths.runDir), 'Receipts cannot be inside protected application/data');
    assert.equal(await realpath(path), path, 'Use canonical application/data paths');
  }
  assert.equal(await realpath(profile), profile, 'Desktop profile must be a canonical directory');
  assert.equal(await realpath(paths.compat), paths.compat, 'Compatibility artifact must be canonical');
  assert.match(options.expectedSha ?? '', /^[a-f0-9]{64}$/, 'Explicit expected compatibility SHA-256 is required');
  assert.match(options.expectedAsar ?? '', /^[a-f0-9]{64}$/, 'Explicit expected official ASAR SHA-256 is required');
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 }); await chmod(paths.runDir, 0o700);
  assert.equal((await lstat(profile)).dev, (await lstat(paths.runDir)).dev, 'Profile and migration receipts must share a filesystem for atomic rollback');
  const safeWrite = async (name, data) => { const handle = await open(join(paths.runDir, name), 'wx', 0o600); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); } };
  const json = path => readFile(path, 'utf8').then(JSON.parse);
  const receipt = value => ({ schema: 1, createdAt: new Date().toISOString(), paths, deployRunDir, ...value });
  const checked = (file, args, opts) => {
    const result = command(file, args, opts);
    assert.ok(!result.error && result.status === 0, `${basename(file)} failed (exit ${result.status ?? 'unavailable'}); inspect private logs`);
    return result;
  };
  async function cold() {
    const output = checked('/bin/ps', ['-axo', 'pid=,command=']).stdout;
    const pids = stoppedProcessPids(output, paths);
    assert.equal(pids.length, 0, `Quit desktop application and Host gracefully first; PIDs: ${pids.join(',')}`);
    for (const path of [paths.app, paths.home, paths.userData]) {
      const result = dependencies.lsof ? dependencies.lsof(path) : command('/usr/sbin/lsof', ['-nP', '-t', '+D', path]);
      assert.ok(!result.error && [0, 1].includes(result.status) && !(result.stderr ?? '').trim(), 'Cannot completely inspect open application/data files');
      assert.equal((result.stdout ?? '').trim(), '', 'Application/data files are still open');
    }
  }
  async function application(prepared) {
    assert.equal(await hashFile(join(paths.app, 'Contents/Resources/app.asar')), options.expectedAsar, 'Official ASAR changed');
    checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.app]);
    const displayed = checked('/usr/bin/codesign', ['--display', '--verbose=4', paths.app]);
    const signature = signatureDetails(`${displayed.stdout ?? ''}${displayed.stderr ?? ''}`);
    assert.deepEqual(signature, prepared.candidate.identity.signature, 'Official publisher/signature changed');
    const requirement = `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = ${JSON.stringify(signature.teamId)} and identifier ${JSON.stringify(signature.identifier)}`;
    checked('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', requirement, paths.app]);
    checked('/usr/sbin/spctl', ['--assess', '--type', 'execute', paths.app]);
    assert.equal((await treeManifest(paths.app)).sha256, prepared.candidate.manifest.sha256, 'Official application bytes changed');
    return signature;
  }
  async function outsideProfile() {
    const all = await treeManifest(paths.home);
    const entries = all.entries.filter(row => row.path !== 'profiles/desktop' && !row.path.startsWith('profiles/desktop/'));
    return { sha256: digest(JSON.stringify(entries)), entries };
  }
  async function preserved(before) {
    assert.equal((await outsideProfile()).sha256, before.outsideProfile.sha256, 'Non-profile DSH home data changed');
    assert.equal((await treeManifest(paths.userData)).sha256, before.userData.sha256, 'Electron userData changed');
    assert.equal(await realpath(join(profile, 'node_modules/dsh-bot')), before.productPath, 'Existing product location changed');
    assert.equal((await treeManifest(before.productPath)).sha256, before.product.sha256, 'Existing dsh-bot product bytes changed');
  }
  const env = {
    PATH: process.env.PATH, SHELL: process.env.SHELL, USER: process.env.USER,
    HOME: join(paths.runDir, 'environment-home'), DSH_HOME: paths.home,
    DSH_BOT_DSH_BIN: join(paths.app, 'Contents/Resources/runtime/cli/bin/dsh'),
    DSH_AGENTS_HOME: join(paths.runDir, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    XDG_STATE_HOME: join(paths.runDir, 'state'), XDG_DATA_HOME: join(paths.runDir, 'data'),
    XDG_CONFIG_HOME: join(paths.runDir, 'config'), XDG_CACHE_HOME: join(paths.runDir, 'cache'),
    NODE_COMPILE_CACHE: join(paths.runDir, 'node-cache'), TMPDIR: join(paths.runDir, 'tmp'),
    pnpm_config_store_dir: join(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: join(root, '.dsh-dev/pnpm-cache'),
    pnpm_config_offline: 'true', npm_config_offline: 'true', pnpm_config_ignore_scripts: 'true', npm_config_ignore_scripts: 'true',
  };
  async function cli(args, label) {
    const result = command(join(root, 'scripts/dsh'), args, { cwd: root, env });
    await safeWrite(`${label}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.ok(!result.error && result.status === 0, `DSH ${label} failed; inspect its private log`);
    return result.stdout;
  }
  async function compose(label) {
    const output = join(paths.runDir, `${label}.yml`);
    const result = command(join(paths.app, 'Contents/MacOS/DeepSeek Harness'), [
      '--expose-internals', join(root, 'scripts/compose-official-desktop-profile.mjs'),
      '--app', paths.app, '--profile-dir', profile, '--home', paths.home, '--output', output,
    ], { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } });
    await safeWrite(`${label}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    assert.ok(!result.error && result.status === 0, `Public official profile composition ${label} failed; inspect its private log`);
    return readFile(output, 'utf8');
  }
  async function execute() {
    const lockPath = join(paths.runDir, '.profile-migration.lock'), lock = await open(lockPath, 'wx', 0o600);
    let backupReady = false, before, prepared;
    try {
      await lock.writeFile(String(process.pid));
      assert.ok(!(await exists(join(paths.runDir, 'before.json'))), 'Use a fresh migration runDir');
      prepared = await json(join(deployRunDir, 'prepared.json'));
      const installed = await json(join(deployRunDir, 'installed.json'));
      const verifiedFile = await exists(join(deployRunDir, 'verified.json')) ? 'verified.json' : 'verify.json';
      const verified = await json(join(deployRunDir, verifiedFile));
      for (const row of [prepared, installed, verified]) {
        assert.equal(row.status, 'PASS', 'Official application deployment/verification must pass first');
        for (const key of ['app', 'home', 'userData']) assert.equal(row.paths?.[key], paths[key], 'Deployment receipts target different application/data');
      }
      await cold(); await application(prepared);
      assert.equal(await hashFile(paths.compat), options.expectedSha, 'Compatibility artifact hash mismatch');
      const frozen = join(paths.runDir, 'compat-input.tgz'); await copyFile(paths.compat, frozen);
      assert.equal(await hashFile(frozen), options.expectedSha, 'Frozen compatibility artifact changed');
      const listing = checked('/usr/bin/tar', ['-tzf', frozen]).stdout.trim().split('\n');
      assert.ok(listing.length && listing.every(path => path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\')), 'Unsafe tar path');
      const verbose = checked('/usr/bin/tar', ['-tvzf', frozen]).stdout.trim().split('\n');
      assert.ok(verbose.every(line => /^[-d]/.test(line)), 'Compatibility tar cannot contain links or special files');
      const unpacked = join(paths.runDir, 'unpacked'); await mkdir(unpacked);
      checked('/usr/bin/tar', ['-xzf', frozen, '-C', unpacked]);
      const packed = join(unpacked, 'package'), packageManifest = await json(join(packed, 'package.json'));
      const compatibility = await json(join(packed, 'compatibility.json'));
      assert.equal(packageManifest.name, packageName, 'Only the reviewed web-app replacement may be installed');
      assert.equal(compatibility.mode, 'web-app-replacement');
      assert.equal(compatibility.archiveSha256, options.expectedAsar, 'Compatibility package targets a different official ASAR');
      assert.equal(compatibility.version, prepared.candidate.identity.version, 'Compatibility release differs from installed official app');
      assert.equal(packageManifest.engines?.dsh, compatibility.version, 'Compatibility package must retain its exact release gate');
      const packageBefore = await json(join(profile, 'package.json'));
      assert.ok(!packageBefore.dependencies?.[packageName], 'Compatibility already installed; use a reviewed update path');
      assert.equal(packageBefore.dsh?.profile?.bundles?.filter(name => name === originalBundle).length, 1, 'Expected exactly one original official web-app selection');
      assert.ok(!packageBefore.dsh.profile.bundles.includes('dsh-bot-native-compat'), 'Earlier compatibility selection requires separate review');
      const productPath = await realpath(join(profile, 'node_modules/dsh-bot'));
      assert.ok(within(profile, productPath), 'Existing product must be profile-owned for complete profile rollback');
      const patchBefore = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
      before = { package: packageBefore, patchSha256: digest(patchBefore), profile: await treeManifest(profile),
        outsideProfile: await outsideProfile(), userData: await treeManifest(paths.userData), productPath, product: await treeManifest(productPath) };
      const backup = join(paths.runDir, 'profile-backup');
      checked('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', profile, backup]);
      assert.equal((await treeManifest(backup)).sha256, before.profile.sha256, 'Complete cold profile backup mismatch');
      await safeWrite('before.json', `${JSON.stringify(receipt({ status: 'PASS', ...before }), null, 2)}\n`);
      backupReady = true;
      for (const key of ['HOME', 'DSH_AGENTS_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[key], { recursive: true });
      const effectiveBefore = await compose('effective-before');
      const migration = migrateChatPatch(patchBefore, effectiveBefore);
      await preserved(before);
      assert.equal((await treeManifest(profile)).sha256, before.profile.sha256, 'Config inspection changed the cold profile');
      await cold();
      await cli(['plugin', '--profile', 'desktop', 'add', frozen], 'install-compat');
      const afterAdd = await json(join(profile, 'package.json'));
      const finalManifest = replaceBundleAtOriginalPosition(packageBefore, afterAdd);
      assert.equal(digest(await readFile(join(profile, 'cordis.patch.yml'))), before.patchSha256, 'Plugin installation rewrote the original patch');
      await writeFile(join(profile, 'package.json'), `${JSON.stringify(finalManifest, null, 2)}\n`);
      await writeFile(join(profile, 'cordis.patch.yml'), migration.text);
      assert.ok((await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).startsWith(patchBefore), 'Original qualified patch bytes changed');
      const effectiveAfter = await compose('effective-after');
      const afterEntries = yaml.load(effectiveAfter, { schema: entryListSchema });
      assert.deepEqual(normalizeAdapterEntryNames(afterEntries), normalizeAdapterEntryNames(migration.entries), 'Effective settings changed beyond the three reviewed Client entry paths');
      for (const id of ['shortcuts', 'ui-chat', 'ui-workspace']) {
        const rows = flattenEntryTree(afterEntries).filter(row => row.id === id && !row.disabled);
        assert.equal(rows.length, 1, `Expected one active ${id}`);
        assert.ok(rows[0].name.includes(`/adapters/${id}/lib/index.js`), `Native ${id} did not select the profile adapter`);
      }
      const installedPackage = await realpath(join(profile, 'node_modules', packageName));
      assert.ok(within(profile, installedPackage), 'Compatibility must be profile-owned');
      for (const row of (await treeManifest(packed)).entries.filter(row => row.type === 'file')) assert.equal(await hashFile(join(installedPackage, row.path)), row.sha256, 'Installed compatibility file mismatch');
      await preserved(before); await application(prepared); await cold();
      await safeWrite('installed.json', `${JSON.stringify(receipt({ status: 'PASS', artifactSha256: options.expectedSha, officialAsarSha256: options.expectedAsar,
        bundles: finalManifest.dsh.profile.bundles, productUnchanged: true, coldDataUnchanged: true, officialApplicationUnchanged: true,
        originalPatchPreserved: true, effectiveChatConfigPreserved: true, profileBackup: backup }), null, 2)}\n`);
      return { status: 'PASS', action: 'install-profile-compat', runDir: paths.runDir, productUnchanged: true, coldDataUnchanged: true, officialApplicationUnchanged: true };
    } catch (error) {
      let restored = false, unchanged = false, recoveryPhase = 'inspect-current-profile';
      if (!(await exists(join(paths.runDir, 'failure-detail.log')))) await safeWrite('failure-detail.log', `${error.stack ?? error.message}\n`);
      if (backupReady) {
        try {
          unchanged = (await treeManifest(profile)).sha256 === before.profile.sha256;
          if (!unchanged) {
          recoveryPhase = 'cold-check';
          await cold();
          const backup = join(paths.runDir, 'profile-backup'), stage = join(paths.runDir, 'profile-restore');
          recoveryPhase = 'validate-backup';
          assert.equal((await treeManifest(backup)).sha256, before.profile.sha256, 'Rollback profile backup changed');
          recoveryPhase = 'copy-restore-stage';
          checked('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', backup, stage]);
          assert.equal((await treeManifest(stage)).sha256, before.profile.sha256, 'Rollback stage mismatch');
          recoveryPhase = 'atomic-profile-exchange';
          checked('/usr/bin/python3', ['-c', swapCode, profile, stage]);
          await rename(stage, join(paths.runDir, 'failed-profile'));
          assert.equal((await treeManifest(profile)).sha256, before.profile.sha256, 'Restored profile mismatch');
          restored = true;
          }
        } catch (rollbackError) {
          await safeWrite('rollback-detail.log', `phase: ${recoveryPhase}\n${rollbackError.stack ?? rollbackError.message}\n`);
          /* Retain full backup and failed state; never overwrite home/userData/app. */
        }
      }
      if (!(await exists(join(paths.runDir, 'failure.json')))) await safeWrite('failure.json', `${JSON.stringify(receipt({ status: 'FAIL', profileBackupReady: backupReady, profileUnchanged: unchanged, profileRestored: restored, profileRecoveryRequired: backupReady && !unchanged && !restored, applicationNeverRewritten: true, nonProfileDataNeverRestored: true }), null, 2)}\n`);
      throw new Error(`Compatibility migration failed; profile ${unchanged ? 'unchanged; no recovery needed' : restored ? 'restored' : backupReady ? 'requires recovery from private profile-backup' : 'not modified by migration'}; app and user data never restored/overwritten`, { cause: error });
    } finally { await lock.close(); await unlink(lockPath); }
  }
  return { execute };
}

export function parseCompatibilityArguments(args) {
  if (args.includes('--help')) return { help: true };
  const names = { '--app': 'app', '--home': 'home', '--user-data': 'userData', '--compat': 'compat', '--run-dir': 'runDir', '--deploy-run-dir': 'deployRunDir', '--expected-sha': 'expectedSha', '--expected-asar': 'expectedAsar' }, options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    assert.ok(key && value && !value.startsWith('--') && options[key] === undefined, 'Unknown, repeated or incomplete CLI option'); options[key] = value;
  }
  for (const key of ['compat', 'runDir', 'expectedSha', 'expectedAsar']) assert.ok(options[key], `Explicit --${key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)} required`);
  for (const key of ['app', 'home', 'userData', 'compat', 'runDir', 'deployRunDir']) if (options[key]) assert.ok(isAbsolute(options[key]), `${key} must be absolute`);
  return { options };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const parsed = parseCompatibilityArguments(process.argv.slice(2));
    if (parsed.help) console.log('Orchestrator-only. node scripts/install-official-desktop-compat.mjs --compat /absolute/reviewed.tgz --run-dir /repo/.dsh-dev/official-desktop-rc3/profile-migration --expected-sha SHA256 --expected-asar SHA256 [--app APP] [--home HOME] [--user-data DATA] [--deploy-run-dir /repo/.dsh-dev/official-desktop-rc3/deploy]\nRequires cold application/Host and completed official application deployment verified.json PASS. Full profile rollback only; app/home/userData are never restored.');
    else console.log(JSON.stringify(await (await createCompatibilityMigration(parsed.options)).execute()));
  } catch (error) { console.error(JSON.stringify({ status: 'FAIL', message: error.message })); process.exitCode = 1; }
}
