import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProfileUpdate, verifyAdapterProvenance, exchangeProfileDirectories, parseProfileUpdateArguments, preserveProductManifest, withProfileLock } from './update-bot-mode-desktop-plugin.mjs';
import { treeManifest } from './deploy-official-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const signature = 'Identifier=com.deepseek.dsh\nAuthority=Developer ID Application: DeepSeek (NAN929V4UM)\nTeamIdentifier=NAN929V4UM\nCDHash=1234\n';
const initialManifest = { name: 'daily', private: true, dependencies: { 'dsh-bot': 'file:/old/product.tgz', 'dsh-bot-web-app': 'file:/approved/adapter.tgz' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-bot-web-app', 'dsh-bot'] } } };
function packArchive(files) {
  const table = { files: {} }, payload = []; let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.from(value); let node = table;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) node = (node.files[part] ??= { files: {} });
    node.files[parts.at(-1)] = { offset: String(offset), size: bytes.length }; offset += bytes.length; payload.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(table)), length = Math.ceil((4 + json.length) / 4) * 4;
  const header = Buffer.alloc(4 + length), prefix = Buffer.alloc(8);
  header.writeUInt32LE(length, 0); header.writeUInt32LE(json.length, 4); json.copy(header, 8);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(header.length, 4);
  return Buffer.concat([prefix, header, ...payload]);
}
async function seedAdapter(options, adapter, flags) {
  const ids = ['shortcuts', 'ui-chat', 'ui-workspace'];
  const patchPaths = ['./cordis.patch.yml', './presets/standard.patch.yml', './presets/ptc.patch.yml', './presets/minimal.patch.yml', './presets/cordis.patch.yml'];
  const manifest = { name: 'dsh-bot-web-app', version: flags.adapterWrongVersion ? '0.2.0' : '0.1.0',
    engines: { dsh: flags.adapterWrongEngine ? '>=0.2.2-rc.3' : '0.2.2-rc.3' }, dsh: { bundle: { patch: patchPaths.map(path => `./official-web-app/${path.slice(2)}`) } } };
  const receipt = { mode: 'web-app-replacement', packageName: manifest.name, replacesBundle: '@deepseek-ai/dsh-web-app',
    version: '0.2.2-rc.3', officialWebAppVersion: '0.2.2-rc.3', loaderIds: ids, configuredEntries: [],
    officialPatchPaths: patchPaths, applicationUnchanged: true, packages: {}, inventory: [], officialInventory: [] };
  const original = {};
  const put = async (path, text) => { await mkdir(dirname(join(adapter, path)), { recursive: true }); await writeFile(join(adapter, path), text); };
  for (const id of ids) {
    const packageName = `@deepseek-ai/dsh-client-${id}`, prefix = `dsh/node_modules/${packageName}/`;
    const files = { 'package.json': JSON.stringify({ name: packageName, version: flags.wrongClientVersion && id === 'ui-chat' ? '0.2.2-rc.2' : '0.2.2-rc.3' }),
      'lib/index.js': `OFFICIAL_HOST_${id}`, 'lib/client.js': `OFFICIAL_CLIENT_${id}` };
    receipt.packages[id] = { packageName, prefix, version: '0.2.2-rc.3', clientSha256: sha(files['lib/client.js']), hostSha256: sha(files['lib/index.js']) };
    for (const [file, text] of Object.entries(files)) {
      original[prefix + file] = text;
      const changed = file === 'lib/client.js', installed = changed ? `REVIEWED_CLIENT_${id}` : text;
      const path = `adapters/${id}/${file}`; await put(path, installed);
      receipt.inventory.push({ path, sha256: sha(installed), bytes: Buffer.byteLength(installed), changed });
    }
  }
  const official = { 'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '0.2.2-rc.3', dsh: { bundle: { patch: patchPaths } } }),
    'cordis.patch.yml': ids.map(id => `- id: ${id}\n  name: '@deepseek-ai/dsh-client-${id}'\n`).join(''),
    ...Object.fromEntries(patchPaths.slice(1).map(path => [path.slice(2), '[]\n'])) };
  for (const [file, text] of Object.entries(official)) {
    original[`dsh/node_modules/@deepseek-ai/dsh-web-app/${file}`] = text;
    let installed = text; const changed = file === 'cordis.patch.yml';
    if (changed) for (const id of ids) installed = installed.replace(`name: '@deepseek-ai/dsh-client-${id}'`, `name: ../adapters/${id}/lib/index.js`);
    if (flags.changedOfficialLayer && file === 'presets/minimal.patch.yml') installed = '# unreviewed layer\n[]\n';
    const path = `official-web-app/${file}`; await put(path, installed);
    receipt.officialInventory.push({ path, sha256: sha(installed), originalSha256: flags.forgedSourceReceipt ? sha('forged') : sha(text), bytes: Buffer.byteLength(installed), changed });
  }
  if (flags.missingAdapterFile) {
    await rm(join(adapter, 'adapters/ui-chat/lib/client.js'));
    receipt.inventory = receipt.inventory.filter(row => row.path !== 'adapters/ui-chat/lib/client.js');
  }
  if (flags.extraAdapterFile) await put('adapters/ui-chat/unlisted.js', 'unreviewed');
  await put('package.json', JSON.stringify(manifest));
  const bytes = packArchive(original); options.expectedAsar = sha(bytes); receipt.archiveSha256 = options.expectedAsar;
  await writeFile(join(options.app, 'Contents/Resources/app.asar'), bytes);
  await put('compatibility.json', JSON.stringify(receipt));
}
async function fixture(t, flags = {}) {
  await mkdir(join(root, '.dsh-dev'), { recursive: true });
  const folder = await mkdtemp(join(root, '.dsh-dev/profile-update-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { root: folder, app: join(folder, 'Official.app'), home: join(folder, 'home'), userData: join(folder, 'userData'),
    artifact: join(folder, 'frozen.tgz'), runDir: join(folder, 'update'), expectedSha: sha('frozen-product'), expectedAsar: sha('official-asar') };
  const profile = join(options.home, 'profiles/desktop'), adapter = join(profile, 'node_modules/dsh-bot-web-app'), product = join(profile, 'node_modules/dsh-bot');
  for (const path of [join(options.app, 'Contents/Resources'), adapter, product, join(options.home, 'storages'), options.userData]) await mkdir(path, { recursive: true });
  await writeFile(join(options.app, 'Contents/Resources/app.asar'), 'official-asar');
  await writeFile(options.artifact, 'frozen-product');
  await writeFile(join(profile, 'package.json'), JSON.stringify(initialManifest));
  await writeFile(join(profile, 'cordis.patch.yml'), '# original modes and permissions\n');
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'old-lock');
  await writeFile(join(product, 'client.js'), 'old-product');
  await writeFile(join(adapter, 'client.js'), 'approved-adapter');
  await seedAdapter(options, adapter, flags);
  options.expectedCompatTree = (await treeManifest(adapter)).sha256;
  await writeFile(join(options.home, 'storages/private.json'), 'PRIVATE_DATA');
  await writeFile(join(options.home, '.hidden'), 'hidden-data');
  await writeFile(join(options.userData, 'Preferences'), 'private-preferences');
  const calls = []; let attempted = false;
  const command = (file, args, opts) => {
    calls.push({ file, args, opts }); let stdout = '', status = 0;
    if (file.endsWith('/ps')) stdout = flags.running ? `81 /Applications/Other.app\n82 ${options.app}/Contents/MacOS/DeepSeek Harness\n` : '';
    else if (file.endsWith('/codesign')) { stdout = args.includes('--display') ? flags.adhoc ? 'Signature=adhoc\n' : flags.wrongTeam ? signature.replaceAll('NAN929V4UM', 'WRONGTEAM1') : signature : ''; if (flags.badSignature && !args.includes('--display')) status = 1; }
    else if (file.endsWith('/spctl')) status = flags.badNotary ? 1 : 0;
    else if (file.endsWith('/PlistBuddy')) stdout = flags.wrongVersion ? '0.2.3' : '0.2.2-rc.3';
    else if (file.endsWith('/tar')) stdout = flags.tarLink ? 'lrwxr-xr-x package/link\n' : '-rw-r--r-- package/package.json\n';
    else if (file.endsWith('/ditto')) {
      mkdirSync(dirname(args.at(-1)), { recursive: true }); cpSync(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true });
      if (flags.badBackup && args.at(-1).endsWith('/backup/home')) writeFileSync(join(args.at(-1), '.hidden'), 'damaged');
    } else if (file.endsWith('/python3')) {
      const a = args.at(-2), b = args.at(-1), stage = `${a}.swap`;
      renameSync(a, stage); renameSync(b, a); renameSync(stage, b);
    } else if (file.endsWith('/DeepSeek Harness')) {
      assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1'); assert.ok(args.some(arg => arg.endsWith('compose-official-desktop-profile.mjs')));
      const altered = attempted && flags.changedSettings;
      const effective = ['shortcuts', 'ui-chat', 'ui-workspace'].map(id => `- id: ${id}\n  name: ${JSON.stringify(join(flags.unreviewedEntry ? join(folder, 'unreviewed') : adapter, `adapters/${id}/lib/index.js`))}\n  config: {mode: ${altered ? 'changed' : 'original'}}\n`).join('');
      writeFileSync(args[args.indexOf('--output') + 1], effective);
      if (flags.failCompose) status = 1;
    } else if (file.endsWith('/scripts/dsh')) {
      attempted = true; assert.deepEqual(args.slice(0, 4), ['plugin', '--profile', 'desktop', 'add']);
      assert.equal(opts.env.pnpm_config_offline, 'true'); assert.equal(opts.env.pnpm_config_ignore_scripts, 'true');
      const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
      manifest.dependencies['dsh-bot'] = `file:${args.at(-1)}`; manifest.dsh.profile.bundles.push('dsh-bot');
      if (flags.changedManifest) manifest.dependencies['dsh-bot-web-app'] = 'file:/unapproved';
      writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest)); writeFileSync(join(product, 'client.js'), 'new-product');
      writeFileSync(join(profile, 'pnpm-lock.yaml'), 'new-lock');
      if (flags.failInstall) status = 1;
      if (flags.newUserData) writeFileSync(join(options.userData, 'Preferences'), 'new-user-data');
    } else throw new Error(`Unexpected command: ${file}`);
    return { status, stdout, stderr: '' };
  };
  const deps = { command, lsof: () => ({ status: 1, stdout: '', stderr: '' }),
    auditArtifact: async (_root, artifact) => ({ sha256: sha(await readFile(artifact)), files: [] }),
    auditInstalled: async () => { assert.equal(await readFile(join(product, 'client.js'), 'utf8'), 'new-product'); return { status: 'PASS' }; } };
  const controller = await createProfileUpdate(options, deps);
  return { controller, options, profile, product, adapter, calls };
}

test('CLI refuses obsolete positional invocation, relative paths and duplicate flags', () => {
  assert.throws(() => parseProfileUpdateArguments(['/old.tgz', '/run']), /Usage/);
  assert.throws(() => parseProfileUpdateArguments(['install', '--artifact', './relative', '--run-dir', '/run']), /Absolute/);
  assert.throws(() => parseProfileUpdateArguments(['install', '--artifact', '/a', '--artifact', '/b']), /duplicate/);
});
test('product update keeps bundle order and refuses unrelated dependency changes', () => {
  const after = structuredClone(initialManifest); after.dependencies['dsh-bot'] = 'file:/frozen'; after.dsh.profile.bundles.push('dsh-bot');
  assert.deepEqual(preserveProductManifest(initialManifest, after, '/frozen').dsh.profile.bundles, initialManifest.dsh.profile.bundles);
  after.dependencies['dsh-bot-web-app'] = 'file:/tampered';
  assert.throws(() => preserveProductManifest(initialManifest, after, '/frozen'), /Unrelated/);
});
test('success makes a complete cold backup and updates only the profile product', async t => {
  const f = await fixture(t); const before = await treeManifest(f.options.home);
  assert.equal((await f.controller.execute()).status, 'PASS');
  assert.equal((await treeManifest(join(f.options.runDir, 'backup/home'))).sha256, before.sha256);
  assert.equal(await readFile(join(f.options.home, '.hidden'), 'utf8'), 'hidden-data');
  const installed = JSON.parse(await readFile(join(f.options.runDir, 'installed.json')));
  assert.equal(installed.effectiveSettingsUnchanged, true); assert.equal(installed.officialApplicationUnchanged, true);
  assert.equal(f.calls.filter(row => row.file.endsWith('/scripts/dsh')).length, 1);
  assert.ok(!f.calls.some(row => row.args.includes('--dump-config')));
});
for (const flag of ['running', 'adhoc', 'wrongTeam', 'badSignature', 'badNotary', 'wrongVersion', 'tarLink', 'badBackup', 'failCompose', 'unreviewedEntry', 'adapterWrongVersion', 'adapterWrongEngine', 'wrongClientVersion', 'changedOfficialLayer', 'forgedSourceReceipt', 'extraAdapterFile', 'missingAdapterFile']) {
  test(`${flag} refuses before profile mutation`, async t => {
    const f = await fixture(t, { [flag]: true }); const before = await treeManifest(f.profile);
    await assert.rejects(f.controller.execute(), /before profile changes/);
    assert.equal((await treeManifest(f.profile)).sha256, before.sha256);
    assert.ok(!f.calls.some(row => row.file.endsWith('/scripts/dsh')));
  });
}
for (const flag of ['failInstall', 'changedManifest', 'changedSettings']) {
  test(`${flag} restores the complete profile`, async t => {
    const f = await fixture(t, { [flag]: true }); const before = await treeManifest(f.profile);
    await assert.rejects(f.controller.execute(), /complete profile restored/);
    assert.equal((await treeManifest(f.profile)).sha256, before.sha256);
  });
}
test('rollback preserves user data written after an installation failure', async t => {
  const f = await fixture(t, { failInstall: true, newUserData: true });
  await assert.rejects(f.controller.execute(), /complete profile restored/);
  assert.equal(await readFile(join(f.options.userData, 'Preferences'), 'utf8'), 'new-user-data');
});
test('explicit profile rollback keeps newer non-profile history', async t => {
  const f = await fixture(t); const before = await treeManifest(f.profile); await f.controller.execute();
  await writeFile(join(f.options.home, 'storages/private.json'), 'NEW_HISTORY');
  assert.equal((await f.controller.rollback()).status, 'PASS');
  assert.equal((await treeManifest(f.profile)).sha256, before.sha256);
  assert.equal(await readFile(join(f.options.home, 'storages/private.json'), 'utf8'), 'NEW_HISTORY');
});
test('explicit rollback refuses to overwrite later profile settings', async t => {
  const f = await fixture(t); await f.controller.execute(); await writeFile(join(f.profile, 'cordis.patch.yml'), 'new-settings');
  await assert.rejects(f.controller.rollback(), /newer settings/);
});
test('changed product and adapter hashes prevent installation', async t => {
  const f = await fixture(t); await writeFile(f.options.artifact, 'tampered');
  await assert.rejects(f.controller.execute(), /before profile changes/);
  assert.ok(!f.calls.some(row => row.file.endsWith('/scripts/dsh')));
});
test('adapter inventory drift refuses installation', async t => {
  const f = await fixture(t); await writeFile(join(f.adapter, 'client.js'), 'tampered adapter');
  await assert.rejects(f.controller.execute(), /before profile changes/);
  assert.ok(!f.calls.some(row => row.file.endsWith('/scripts/dsh')));
});
test('explicit interrupted recovery works without installed receipt and preserves newer history', async t => {
  const f = await fixture(t); const before = await treeManifest(f.profile); await f.controller.execute();
  await rm(join(f.options.runDir, 'installed.json'));
  await writeFile(join(f.options.home, 'storages/private.json'), 'NEW_HISTORY_AFTER_INTERRUPTION');
  f.options.expectedCurrentProfile = (await treeManifest(f.profile)).sha256;
  assert.equal((await f.controller.recover()).status, 'PASS');
  assert.equal((await treeManifest(f.profile)).sha256, before.sha256);
  assert.equal(await readFile(join(f.options.home, 'storages/private.json'), 'utf8'), 'NEW_HISTORY_AFTER_INTERRUPTION');
});
test('interrupted recovery requires the exact reviewed current profile', async t => {
  const f = await fixture(t); await f.controller.execute();
  f.options.expectedCurrentProfile = sha('unreviewed');
  await assert.rejects(f.controller.recover(), /reviewed interrupted state/);
});
test('advisory profile lock refuses overlap and releases after the owner exits', async t => {
  const folder = await mkdtemp(join(root, '.dsh-dev/profile-flock-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const lock = join(folder, 'lock');
  await withProfileLock(lock, async () => {
    await assert.rejects(withProfileLock(lock, async () => assert.fail('second owner entered')), /lock is held/);
  });
  await withProfileLock(lock, async () => {});
  const moduleUrl = new URL('./update-bot-mode-desktop-plugin.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {withProfileLock} from ${JSON.stringify(moduleUrl)}; await withProfileLock(${JSON.stringify(lock)}, async()=>{console.log('OWNER_READY');await new Promise(()=>{});});`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stderr.resume();
  const done = new Promise(accept => child.once('close', accept));
  await new Promise((accept, reject) => {
    child.once('error', reject); child.stdout.on('data', chunk => { output += chunk; if (output.includes('OWNER_READY')) accept(); });
  });
  child.kill('SIGKILL'); await done;
  // The orphan lock helper sees EOF even after SIGKILL; acquiring this lock
  // proves automatic OS release, without deleting any stale PID lockfile.
  let acquired = false;
  for (let attempt = 0; attempt < 20 && !acquired; attempt++) {
    try { await withProfileLock(lock, async () => { acquired = true; }); }
    catch { await new Promise(accept => setTimeout(accept, 20)); }
  }
  assert.equal(acquired, true);
});


test('read-only installed adapter provenance matches the actual official rc.3 archive', async t => {
  const adapter = join(root, '.dsh-dev/official-desktop-rc3/profile-migration-v2/unpacked/package');
  const asar = join(root, '.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app/Contents/Resources/app.asar');
  try { await readFile(join(adapter, 'compatibility.json')); await readFile(asar); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Local official candidate is unavailable'); return; } throw error; }
  const { openArchive } = await import('../adapters/bot-mode-desktop022/archive.mjs');
  const receipt = JSON.parse(await readFile(join(adapter, 'compatibility.json')));
  const bytes = await readFile(asar); assert.equal(sha(bytes), receipt.archiveSha256);
  await verifyAdapterProvenance(adapter, receipt, openArchive(bytes), await treeManifest(adapter));
});


test('real Darwin profile exchange atomically swaps the two existing directory identities', { skip: process.platform !== 'darwin' }, async t => {
  const folder = await mkdtemp(join(root, '.dsh-dev/profile-exchange-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const profile = join(folder, 'profile'), stage = join(folder, 'stage');
  await mkdir(profile); await mkdir(stage);
  await writeFile(join(profile, 'state'), 'NEW_PROFILE'); await writeFile(join(stage, 'state'), 'OLD_BACKUP');
  const { stat } = await import('node:fs/promises');
  const before = await stat(profile), staged = await stat(stage);
  exchangeProfileDirectories(profile, stage);
  assert.equal((await stat(profile)).ino, staged.ino); assert.equal((await stat(stage)).ino, before.ino);
  assert.equal(await readFile(join(profile, 'state'), 'utf8'), 'OLD_BACKUP');
  assert.equal(await readFile(join(stage, 'state'), 'utf8'), 'NEW_PROFILE');
});
