import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertOfficialComposition, createNativeWorkspaceMigration, officialManifest, parseNativeMigrationArguments } from './native-workspace-profile.mjs';
import { treeManifest } from './deploy-official-desktop.mjs';
const sha = v => createHash('sha256').update(v).digest('hex');
const official = '@deepseek-ai/dsh-web-app', legacy = 'dsh-bot-web-app', product = 'dsh-botgroup';
const signature = { teamId: 'NAN929V4UM' };
const json = path => readFile(path, 'utf8').then(JSON.parse);
async function fixture(t, kind = 'official', flags = {}) {
  const dir = await mkdtemp(resolve('.dsh-dev/native-workspace-migration-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { app: join(dir, 'rc5.app'), sourceApp: join(dir, 'rc3.app'), home: join(dir, 'home'), userData: join(dir, 'userData'), artifact: join(dir, 'new.tgz'), fallbackArtifact: join(dir, 'safe.tgz'), runDir: join(dir, 'migration'), expectedSha: sha('new'), fallbackSha: sha('safe'), expectedAsar: sha('rc5'), expectedVersion: '0.2.2-rc.5' };
  const profile = join(options.home, 'profiles/desktop');
  for (const p of [options.app, options.sourceApp, options.userData, join(profile, 'node_modules', product), join(options.home, 'storages')]) await mkdir(p, { recursive: true });
  const manifest = { name: 'desktop', private: true, dependencies: { [product]: 'file:/old.tgz', ...(kind !== 'official' ? { [legacy]: 'file:/old-adapter.tgz' } : {}) }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', kind === 'active-legacy' ? legacy : official, product, 'unrelated'] } } };
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(profile, 'cordis.patch.yml'), '# Preserve qualified row and latest generic override\nlatest-setting\n');
  await writeFile(join(profile, '.hidden'), 'private-profile-data');
  await writeFile(join(profile, 'compatibility.json'), JSON.stringify({ 'unrelated@1.0.0': ['0.2.2-rc.5'] }));
  await writeFile(join(profile, 'pnpm-lock.yaml'), 'old-lock');
  await writeFile(join(profile, 'node_modules', product, 'client.js'), 'old-product');
  await writeFile(join(options.home, 'storages/history'), 'history-before');
  await writeFile(join(options.userData, 'Preferences'), 'preferences-before');
  await writeFile(options.artifact, 'new'); await writeFile(options.fallbackArtifact, 'safe');
  const calls = [], identity = { sha256: options.expectedAsar, version: options.expectedVersion, signature };
  const deps = {
    appIdentity: async (app, expected) => { if (expected) assert.equal(expected, options.expectedAsar); return app === options.app ? identity : { ...identity, version: '0.2.2-rc.3' }; },
    cold: async () => { assert.ok(!flags.running, 'Target data is open'); },
    audit: async (path, expected) => { assert.equal(sha(await readFile(path)), expected, 'Artifact hash mismatch'); return { name: product, sha256: expected, version: '0.7.0', inventory: { entries: [] } }; },
    compose: async value => {
      calls.push({ type: 'compose', home: value.home }); assert.notEqual(value.home, options.home, 'Never compose the live profile');
      const p = join(value.home, 'profiles/desktop'), m = await json(join(p, 'package.json'));
      if (flags.normalizeStage) await writeFile(join(p, 'package.json'), JSON.stringify({ ...m, normalized: true }));
      const config = await readFile(join(p, 'cordis.patch.yml'), 'utf8');
      const entries = ['shortcuts', 'ui-chat', 'ui-workspace'].map(id => ({ id, name: m.dsh.profile.bundles.includes(legacy) ? join(p, 'node_modules', legacy, 'adapters', id, 'lib/index.js') : `@deepseek-ai/dsh-client-${id}`, config: { full: config, nested: { permission: 'never' } } }));
      if (flags.nativeDrift) entries.push({ id: 'native-default', config: value.app === options.sourceApp ? { oldDefault: true } : {} });
      if (flags.changedEffective && value.folder.endsWith('/candidate')) entries[1].config.nested.permission = 'always';
      if (flags.duplicate) entries.push({ ...entries[1] });
      return entries;
    },
    install: async value => {
      calls.push({ type: 'install', home: value.home }); assert.notEqual(value.home, options.home, 'Never install into the live profile');
      const p = join(value.home, 'profiles/desktop'), m = await json(join(p, 'package.json'));
      m.dependencies[product] = `file:${value.artifact}`; m.dsh.profile.bundles.push(product);
      if (flags.unrelatedManifest) m.dependencies.unrelated = 'file:/changed';
      await writeFile(join(p, 'package.json'), JSON.stringify(m));
      await writeFile(join(p, 'pnpm-lock.yaml'), 'lock:' + value.artifact);
      await writeFile(join(p, 'node_modules', product, 'client.js'), await readFile(value.artifact));
      if (flags.failInstall) throw Error('staged install failed');
    },
    verifyInstalled: async (home, audit) => {
      assert.equal(sha(await readFile(join(home, 'profiles/desktop/node_modules', product, 'client.js'))), audit.sha256);
      if (flags.failAfterSwap && home === options.home) {
        if (flags.newHistory) await writeFile(join(options.home, 'storages/history'), 'new-during-verification');
        if (flags.newSetting) await writeFile(join(profile, 'cordis.patch.yml'), 'new-user-setting');
        throw Error('post-swap audit failed');
      }
    },
    exchange: (a, b) => { const tmp = a + '.exchange'; renameSync(a, tmp); renameSync(b, a); renameSync(tmp, b); },
  };
  return { options, profile, calls, flags, controller: await createNativeWorkspaceMigration(options, deps), deps };
}
for (const kind of ['official', 'residual-legacy', 'active-legacy']) test(`${kind}: staged migration preserves latest config and dormant dependencies`, async t => {
  const f = await fixture(t, kind), before = await treeManifest(f.profile);
  const patch = await readFile(join(f.profile, 'cordis.patch.yml'));
  assert.equal((await f.controller.execute()).status, 'PASS');
  const after = await json(join(f.profile, 'package.json')); assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', official, product, 'unrelated']);
  assert.equal(Boolean(after.dependencies[legacy]), kind !== 'official'); assert.deepEqual(await readFile(join(f.profile, 'cordis.patch.yml')), patch);
  assert.equal(await readFile(join(f.options.home, 'storages/history'), 'utf8'), 'history-before');
  assert.equal(await readFile(join(f.profile, '.hidden'), 'utf8'), 'private-profile-data');
  assert.equal((await treeManifest(join(f.options.runDir, 'backup/home/profiles/desktop'))).sha256, before.sha256);
  assert.equal(f.calls.filter(c => c.type === 'compose').length, 3);
});
test('duplicate migration in the same run is refused without changes; a fresh run is repeatable', async t => {
  const f = await fixture(t, 'residual-legacy'); await f.controller.execute(); const before = await treeManifest(f.profile);
  await assert.rejects(f.controller.execute()); assert.deepEqual(await treeManifest(f.profile), before);
  f.options.runDir += '-repeat'; const next = await createNativeWorkspaceMigration(f.options, f.deps);
  assert.equal((await next.execute()).status, 'PASS');
});
for (const flag of ['normalizeStage', 'changedEffective', 'duplicate', 'unrelatedManifest', 'failInstall', 'running']) test(`${flag}: refuses before changing current profile`, async t => {
  const f = await fixture(t, 'active-legacy', { [flag]: true }), before = await treeManifest(f.profile);
  await assert.rejects(f.controller.execute()); assert.deepEqual(await treeManifest(f.profile), before);
});
test('frozen hash mismatch leaves current profile intact', async t => {
  const f = await fixture(t); await writeFile(f.options.artifact, 'tampered'); const before = await treeManifest(f.profile);
  await assert.rejects(f.controller.execute(), /Artifact hash mismatch/); assert.deepEqual(await treeManifest(f.profile), before);
});
test('rollback from old active adapter always chooses official target and preserves later history', async t => {
  const f = await fixture(t, 'active-legacy'); await f.controller.execute();
  await writeFile(join(f.options.home, 'storages/history'), 'new-history'); await writeFile(join(f.options.userData, 'Preferences'), 'new-preferences');
  assert.equal((await f.controller.rollback()).status, 'PASS');
  assert.ok((await json(join(f.profile, 'package.json'))).dsh.profile.bundles.includes(official));
  assert.equal(await readFile(join(f.profile, 'node_modules', product, 'client.js'), 'utf8'), 'safe');
  assert.equal(await readFile(join(f.options.home, 'storages/history'), 'utf8'), 'new-history'); assert.equal(await readFile(join(f.options.userData, 'Preferences'), 'utf8'), 'new-preferences');
});
test('new settings block snapshot rollback; targeted fallback retains settings and history', async t => {
  const f = await fixture(t, 'active-legacy'); await f.controller.execute();
  await writeFile(join(f.profile, 'cordis.patch.yml'), 'new-owner-settings'); await writeFile(join(f.options.home, 'storages/history'), 'new-history');
  await assert.rejects(f.controller.rollback(), /newer settings/);
  assert.equal((await f.controller.rollback({ targeted: true })).status, 'PASS');
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'new-owner-settings'); assert.equal(await readFile(join(f.options.home, 'storages/history'), 'utf8'), 'new-history');
});
test('interruption after exchange before installed receipt is recoverable without restoring legacy', async t => {
  const f = await fixture(t, 'active-legacy'); await f.controller.execute(); await rm(join(f.options.runDir, 'installed.json'));
  assert.equal((await f.controller.rollback()).status, 'PASS');
  assert.ok((await json(join(f.profile, 'package.json'))).dsh.profile.bundles.includes(official));
});
test('post-swap failure restores safe official snapshot and preserves history written meanwhile', async t => {
  const f = await fixture(t, 'active-legacy', { failAfterSwap: true, newHistory: true });
  await assert.rejects(f.controller.execute(), /official fallback restored/);
  assert.equal(await readFile(join(f.options.home, 'storages/history'), 'utf8'), 'new-during-verification');
  assert.ok((await json(join(f.profile, 'package.json'))).dsh.profile.bundles.includes(official));
});
test('post-swap user settings are never overwritten by automatic recovery', async t => {
  const f = await fixture(t, 'active-legacy', { failAfterSwap: true, newSetting: true });
  await assert.rejects(f.controller.execute(), /retained for reviewed recovery/);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), 'new-user-setting');
});
test('tampered safe snapshot blocks rollback', async t => {
  const f = await fixture(t); await f.controller.execute(); await writeFile(join(f.options.runDir, 'safe/home/profiles/desktop/cordis.patch.yml'), 'tamper');
  await assert.rejects(f.controller.rollback(), /Fallback snapshot changed/);
});
test('ambiguous and experimental selections fail explicitly', () => {
  const base = { dependencies: { [product]: 'file:x' }, dsh: { profile: { bundles: [official, product] } } };
  for (const extra of [legacy, official, 'dsh-bot-native-compat', 'dsh-bot']) {
    const value = structuredClone(base); value.dsh.profile.bundles.push(extra); assert.throws(() => officialManifest(value));
  }
  assert.throws(() => assertOfficialComposition([]));
  assert.throws(() => assertOfficialComposition([{ id: 'custom-adapter', name: '/package/dsh-bot-web-app/adapters/ui-chat/lib/index.js', disabled: { __jsExpr: 'false' } }]));
  assert.throws(() => parseNativeMigrationArguments(['install', '--artifact', '/a', '--artifact', '/b']));
});

test('profile symlink to mutable outside data is refused before staging/install', async t => {
  const f = await fixture(t); await symlink(f.options.userData, join(f.profile, 'escape')); const before = await treeManifest(f.profile);
  await assert.rejects(f.controller.execute(), /Profile links/); assert.deepEqual(await treeManifest(f.profile), before); assert.equal(f.calls.length, 0);
});

test('native defaults require exact reviewed composition hashes, never a broad ignore', async t => {
  const f = await fixture(t, 'active-legacy', { nativeDrift: true });
  await assert.rejects(f.controller.execute(), /exact reviewed receipt/);
  const reviewPath = join(f.options.runDir, 'composition-diff.json');
  const receipt = await json(reviewPath); assert.notEqual(receipt.beforeSha256, receipt.afterSha256);
  f.options.runDir += '-reviewed'; f.options.compositionReview = reviewPath;
  const next = await createNativeWorkspaceMigration(f.options, f.deps); assert.equal((await next.execute()).status, 'PASS');
  await writeFile(join(f.profile, 'cordis.patch.yml'), 'new-profile-setting');
  f.options.runDir += '-stale'; const stale = await createNativeWorkspaceMigration(f.options, f.deps);
  await assert.rejects(stale.execute(), /Composition review does not match/);
});
