import assert from 'node:assert/strict';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCompatibilityMigration, flattenEntryTree, migrateChatPatch, normalizeAdapterEntryNames, parseCompatibilityArguments, replaceBundleAtOriginalPosition } from './install-official-desktop-compat.mjs';
import { signatureDetails, treeManifest } from './deploy-official-desktop.mjs';
import { composeWithPublicBoot } from './compose-official-desktop-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const signatureText = 'Identifier=com.deepseek.dsh\nAuthority=Developer ID Application: Test (TESTTEAM01)\nTeamIdentifier=TESTTEAM01\nCDHash=abcd\n';
const signature = signatureDetails(signatureText);
const originalPatch = "# User-owned text must survive byte for byte.\n- id: ui-chat\n  name: '@deepseek-ai/dsh-client-ui-chat'\n  config:\n    transcriptView: standard\n    performanceUsage: detailed\n- id: dsh-bot\n  config: {supergroup: {enabled: false}}\n";
const originalManifest = { name: 'daily-profile', private: true, dependencies: { 'dsh-bot': 'file:/reviewed/product.tgz' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-bot'] } } };
const effective = installed => ['shortcuts', 'ui-chat', 'ui-workspace'].map(id => `- id: ${id}\n  name: ${JSON.stringify(installed ? `${installed}/adapters/${id}/lib/index.js` : `@deepseek-ai/dsh-client-${id}`)}\n${id === 'ui-chat' ? '  config:\n    transcriptView: standard\n    performanceUsage: detailed\n    extra: {nested: [one, two]}\n' : ''}`).join('') + '- id: dsh-bot\n  name: dsh-bot\n  config: {supergroup: {enabled: false}}\n';

async function fixture(t, flags = {}) {
  await mkdir(join(root, '.dsh-dev'), { recursive: true });
  const folder = await mkdtemp(join(root, '.dsh-dev/compat-migration-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const options = { root: folder, app: join(folder, 'Official.app'), home: join(folder, 'home'), userData: join(folder, 'userData'),
    compat: join(folder, 'reviewed.tgz'), runDir: join(folder, 'migration'), deployRunDir: join(folder, 'deploy'), expectedSha: sha('compat-fixture'), expectedAsar: sha('official-asar') };
  const profile = join(options.home, 'profiles/desktop'), source = join(folder, 'package-source');
  for (const path of [join(options.app, 'Contents/Resources'), join(profile, 'node_modules/dsh-bot/lib'), join(options.home, 'storages'), options.userData, options.deployRunDir, source]) await mkdir(path, { recursive: true });
  await writeFile(join(options.app, 'Contents/Resources/app.asar'), 'official-asar');
  await writeFile(options.compat, 'compat-fixture');
  await writeFile(join(profile, 'package.json'), `${JSON.stringify(originalManifest, null, 2)}\n`);
  await writeFile(join(profile, 'cordis.patch.yml'), originalPatch);
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'original lock');
  await writeFile(join(profile, 'node_modules/dsh-bot/lib/client.js'), 'existing product never reinstalled');
  await writeFile(join(options.home, 'storages/bots.json'), 'PRIVATE_BOT_DATA');
  await writeFile(join(options.userData, 'Preferences'), 'PRIVATE_PREFERENCES');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-bot-web-app', version: '0.1.0', engines: { dsh: '0.2.2-rc.3' } }));
  await writeFile(join(source, 'compatibility.json'), JSON.stringify({ mode: 'web-app-replacement', archiveSha256: options.expectedAsar, version: '0.2.2-rc.3' }));
  await writeFile(join(source, 'adapter.js'), 'reviewed adapter');
  const paths = { app: options.app, home: options.home, userData: options.userData };
  await writeFile(join(options.deployRunDir, 'prepared.json'), JSON.stringify({ status: 'PASS', paths, candidate: { identity: { version: '0.2.2-rc.3', signature }, manifest: await treeManifest(options.app) } }));
  for (const name of ['installed', 'verified']) await writeFile(join(options.deployRunDir, `${name}.json`), JSON.stringify({ status: 'PASS', paths }));
  const calls = [], commands = []; let installAttempted = false;
  const command = (file, args, opts) => {
    calls.push({ file, args, opts }); let stdout = '', status = 0;
    if (file.endsWith('/ps')) stdout = '';
    else if (file.endsWith('/codesign')) stdout = args.includes('--display') ? signatureText : '';
    else if (file.endsWith('/spctl')) stdout = 'accepted';
    else if (file.endsWith('/tar')) {
      if (args[0] === '-tzf') stdout = 'package/package.json\npackage/compatibility.json\npackage/adapter.js\n';
      else if (args[0] === '-tvzf') stdout = '-rw-r--r-- package/package.json\n-rw-r--r-- package/compatibility.json\n-rw-r--r-- package/adapter.js\n';
      else cpSync(source, join(args.at(-1), 'package'), { recursive: true });
    } else if (file.endsWith('/ditto')) cpSync(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true });
    else if (file.endsWith('/python3')) {
      const a = args.at(-2), b = args.at(-1), temp = `${a}.swap-test`;
      renameSync(a, temp); renameSync(b, a); renameSync(temp, b);
    } else if (file.endsWith('/DeepSeek Harness')) {
      assert.equal(opts.env.ELECTRON_RUN_AS_NODE, '1');
      assert.ok(args.includes('--profile-dir') && args.some(arg => arg.endsWith('compose-official-desktop-profile.mjs')));
      if (flags.failCompose) { status = 1; stdout = ''; }
      else {
        const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
        let composed = effective(manifest.dsh.profile.bundles.includes('dsh-bot-web-app') ? join(profile, 'node_modules/dsh-bot-web-app') : undefined);
        if (flags.grouped) composed = '- id: native-root\n  name: cordis:group\n  group: true\n  config:\n' + composed.split('\n').filter(Boolean).map(line => `    ${line}`).join('\n') + '\n';
        writeFileSync(args[args.indexOf('--output') + 1], composed);
      }
    } else if (file.endsWith('/scripts/dsh')) {
      commands.push(args);
      assert.ok(!args.includes('--dump-config'), 'Reserved desktop dump must never be invoked');
      if (args.includes('--dump-config')) {
        const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
        stdout = effective(manifest.dsh.profile.bundles.includes('dsh-bot-web-app') ? join(profile, 'node_modules/dsh-bot-web-app') : undefined);
      } else {
        installAttempted = true;
        assert.deepEqual(args.slice(0, 4), ['plugin', '--profile', 'desktop', 'add']);
        const manifest = JSON.parse(readFileSync(join(profile, 'package.json')));
        manifest.dependencies['dsh-bot-web-app'] = `file:${args.at(-1)}`;
        manifest.dsh.profile.bundles.push('dsh-bot-web-app', 'dsh-bot-web-app');
        writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(profile, 'pnpm-lock.yaml'), 'modified lock');
        cpSync(source, join(profile, 'node_modules/dsh-bot-web-app'), { recursive: true });
        if (flags.failInstall) {
          writeFileSync(join(profile, 'node_modules/dsh-bot/lib/client.js'), 'package-manager damaged old product');
          if (flags.changeUserData) writeFileSync(join(options.userData, 'Preferences'), 'new preferences retained after failure');
          status = 1;
        }
      }
    } else throw new Error(`Unexpected test command ${file}`);
    return { status, stdout, stderr: '' };
  };
  const controller = await createCompatibilityMigration(options, { command, lsof: () => flags.failRollback && installAttempted ? ({ status: 0, stdout: '931\n', stderr: '' }) : ({ status: 1, stdout: '', stderr: '' }) });
  return { options, profile, controller, calls, commands };
}

test('CLI requires explicit pinned artifacts and rejects relative paths', () => {
  assert.throws(() => parseCompatibilityArguments([]), /compat required/);
  assert.throws(() => parseCompatibilityArguments(['--compat', './x.tgz', '--run-dir', '/run', '--expected-sha', 'a', '--expected-asar', 'b']), /absolute/);
});
test('bundle replacement retains base/product positions and removes appended compatibility duplicates', () => {
  const after = structuredClone(originalManifest); after.dependencies['dsh-bot-web-app'] = 'file:/reviewed/compat.tgz';
  after.dsh.profile.bundles.push('dsh-bot-web-app', 'dsh-bot-web-app');
  const migrated = replaceBundleAtOriginalPosition(originalManifest, after);
  assert.deepEqual(migrated.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-bot-web-app', 'dsh-bot']);
  assert.equal(migrated.dependencies['dsh-bot'], originalManifest.dependencies['dsh-bot']);
  after.dependencies['dsh-bot'] = 'file:/other/product.tgz';
  assert.throws(() => replaceBundleAtOriginalPosition(originalManifest, after), /unrelated manifest fields/);
});
test('chat migration preserves qualified patch bytes and complete nested effective config', () => {
  const migrated = migrateChatPatch(originalPatch, effective());
  assert.ok(migrated.text.startsWith(originalPatch));
  assert.deepEqual(migrated.config.extra, { nested: ['one', 'two'] });
  assert.match(migrated.text.slice(originalPatch.length), /- id: ui-chat\n  config:/);
  assert.ok(!migrated.text.slice(originalPatch.length).includes('name:'));
});
test('chat migration preserves native !!js expressions without evaluating them', () => {
  const migrated = migrateChatPatch(originalPatch, '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n  config:\n    extra: !!js ctx.someSetting\n');
  assert.match(migrated.text, /extra: !!js ctx.someSetting/);
});
test('root groups keep every field while recursively normalizing only three adapter names', () => {
  const before = [{ id: 'root', name: 'cordis:group', group: true, config: [{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'standard' } }] }];
  const after = structuredClone(before); after[0].config[0].name = 'file:///profile/adapters/ui-chat/lib/index.js';
  assert.deepEqual(normalizeAdapterEntryNames(before), normalizeAdapterEntryNames(after));
  assert.equal(flattenEntryTree(after).find(row => row.id === 'ui-chat').config.transcriptView, 'standard');
  after[0].name = 'changed-root';
  assert.notDeepEqual(normalizeAdapterEntryNames(before), normalizeAdapterEntryNames(after));
});
test('public composer includes base cordis.yml and home/profile layers without booting', () => {
  const calls = [];
  const boot = {
    loadProfileDirectory(...args) { calls.push(['load', args]); return { skippedBundles: [], layers: [{ patches: [] }], patchPath: '/profile/cordis.patch.yml' }; },
    readProfilePatches(...args) { calls.push(['patches', args]); return [{ id: 'ui-chat', config: { performanceUsage: 'detailed' } }]; },
    renderConfigDump(...args) { calls.push(['compose', args]); return 'complete grouped config'; },
  };
  assert.equal(composeWithPublicBoot({ boot, profileDir: '/profile', home: '/home', installAnchor: '/official/package.json' }).text, 'complete grouped config');
  assert.equal(calls[1][1][1].home, '/home');
  assert.equal(calls[2][1][1], '/profile/cordis.yml');
});
test('successful migration installs only compatibility, retains product and all user data', async t => {
  const { options, profile, controller, calls, commands } = await fixture(t);
  const product = await treeManifest(join(profile, 'node_modules/dsh-bot'));
  assert.equal((await controller.execute()).status, 'PASS');
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'))).dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-bot-web-app', 'dsh-bot']);
  assert.ok((await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).startsWith(originalPatch));
  assert.equal((await treeManifest(join(profile, 'node_modules/dsh-bot'))).sha256, product.sha256);
  assert.equal(await readFile(join(options.home, 'storages/bots.json'), 'utf8'), 'PRIVATE_BOT_DATA');
  assert.equal(await readFile(join(options.userData, 'Preferences'), 'utf8'), 'PRIVATE_PREFERENCES');
  assert.equal(commands.filter(args => args[0] === 'plugin').length, 1);
  assert.ok(calls.filter(row => row.file.endsWith('/scripts/dsh')).every(row => row.opts.env.pnpm_config_offline === 'true' && row.opts.env.DSH_BOT_DSH_BIN.startsWith(options.app)));
});
test('failed installation atomically restores complete profile including product and dependencies', async t => {
  const { options, profile, controller } = await fixture(t, { failInstall: true });
  const before = await treeManifest(profile);
  await assert.rejects(controller.execute(), /profile restored/);
  assert.equal((await treeManifest(profile)).sha256, before.sha256);
  assert.equal(await readFile(join(options.app, 'Contents/Resources/app.asar'), 'utf8'), 'official-asar');
  assert.equal(await readFile(join(options.home, 'storages/bots.json'), 'utf8'), 'PRIVATE_BOT_DATA');
  assert.equal(JSON.parse(await readFile(join(options.runDir, 'failure.json'))).profileRestored, true);
});
test('grouped complete composition preserves settings through the migration', async t => {
  const { controller } = await fixture(t, { grouped: true });
  assert.equal((await controller.execute()).status, 'PASS');
});
test('composition error before changes marks profile unchanged and never attempts rollback', async t => {
  const { options, controller, calls, commands } = await fixture(t, { failCompose: true });
  await assert.rejects(controller.execute(), /profile unchanged; no recovery needed/);
  const failure = JSON.parse(await readFile(join(options.runDir, 'failure.json')));
  assert.equal(failure.profileUnchanged, true); assert.equal(failure.profileRecoveryRequired, false);
  assert.equal(commands.length, 0);
  assert.ok(!calls.some(row => row.file.endsWith('/python3')));
});
test('failed rollback keeps private details and precise phase instead of swallowing errors', async t => {
  const { options, controller } = await fixture(t, { failInstall: true, failRollback: true });
  await assert.rejects(controller.execute(), /requires recovery/);
  assert.match(await readFile(join(options.runDir, 'rollback-detail.log'), 'utf8'), /phase: cold-check/);
  assert.equal(JSON.parse(await readFile(join(options.runDir, 'failure.json'))).profileRecoveryRequired, true);
});
test('missing deployment verification blocks all profile CLI commands', async t => {
  const { options, controller, commands } = await fixture(t);
  await rm(join(options.deployRunDir, 'verified.json'));
  await assert.rejects(controller.execute(), /not modified by migration/);
  assert.equal(commands.length, 0);
});
test('profile rollback never overwrites new Electron userData', async t => {
  const { options, controller } = await fixture(t, { failInstall: true, changeUserData: true });
  await assert.rejects(controller.execute(), /profile restored/);
  assert.equal(await readFile(join(options.userData, 'Preferences'), 'utf8'), 'new preferences retained after failure');
  assert.equal(await readFile(join(options.home, 'storages/bots.json'), 'utf8'), 'PRIVATE_BOT_DATA');
});
test('artifact hash mismatch blocks all profile CLI commands', async t => {
  const { options, controller, commands } = await fixture(t);
  await writeFile(options.compat, 'tampered artifact');
  await assert.rejects(controller.execute(), /not modified by migration/);
  assert.equal(commands.length, 0);
});
