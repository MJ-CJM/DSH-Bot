// Local-only staged profile migration. No Host is started and no model is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { treeManifest, stoppedProcessPids } from './deploy-official-desktop.mjs';
import { exchangeProfileDirectories, verifyAdapterProvenance, withProfileLock } from './update-bot-mode-desktop-plugin.mjs';
import { openArchive } from '../adapters/bot-mode-desktop022/archive.mjs';
import { auditArtifact, auditInstalled } from './p34-artifact.mjs';

const root = process.cwd(), [mode, directory, artifactFile] = process.argv.slice(2);
assert.ok(['prepare', 'install'].includes(mode));
const run = resolve(directory); assert.ok(run.startsWith(join(root, '.dsh-dev/')));
const paths = { app: '/Applications/DeepSeek Harness.app', home: join(homedir(), '.dsh'),
  userData: join(homedir(), 'Library/Application Support/@deepseek-ai/dsh-desktop') };
const profile = join(paths.home, 'profiles/desktop'), stageHome = join(run, 'stage-home'), stage = join(stageHome, 'profiles/desktop');
const expectedAsar = 'c0ce89f77d25e98e11952728d1fc054b6e2300db17402af83a1a225c8b36e843';
const expectedCompat = '70c79c27778bb4f08a2e39cc4da735f74ea80cf002d4a892b97353ffc18476ee';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => readFile(path, 'utf8').then(JSON.parse);
await mkdir(run, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFile(join(run, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const env = { ...process.env, DSH_HOME: stageHome, DSH_BOT_DSH_BIN: join(paths.app, 'Contents/Resources/runtime/cli/bin/dsh'),
  HOME: join(run, 'environment-home'), XDG_STATE_HOME: join(run, 'state'), XDG_DATA_HOME: join(run, 'data'),
  XDG_CONFIG_HOME: join(run, 'config'), XDG_CACHE_HOME: join(run, 'cache'), TMPDIR: join(run, 'tmp'),
  NODE_COMPILE_CACHE: join(run, 'node-cache'), DSH_TELEMETRY_DISABLED: '1',
  pnpm_config_store_dir: join(root, '.dsh-dev/pnpm-store'), pnpm_config_cache_dir: join(root, '.dsh-dev/pnpm-cache'),
  pnpm_config_offline: 'true', npm_config_offline: 'true', pnpm_config_ignore_scripts: 'true', npm_config_ignore_scripts: 'true' };
for (const name of ['HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) await mkdir(env[name], { recursive: true });
function command(file, args, overrides = {}) {
  const result = spawnSync(file, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...overrides });
  assert.ok(!result.error && result.status === 0, `${file.split('/').at(-1)} failed: ${result.stderr?.slice(-1200)}`);
  return result.stdout;
}
async function identity() {
  const asar = await readFile(join(paths.app, 'Contents/Resources/app.asar'));
  assert.equal(sha(asar), expectedAsar);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', paths.app]);
  command('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', '=anchor apple generic and certificate leaf[subject.OU] = "NAN929V4UM" and identifier "com.deepseek.dsh"', paths.app]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', paths.app]);
  const adapter = await realpath(join(profile, 'node_modules/dsh-bot-web-app')), tree = await treeManifest(adapter);
  assert.equal(tree.sha256, expectedCompat);
  await verifyAdapterProvenance(adapter, await json(join(adapter, 'compatibility.json')), openArchive(asar), tree);
}
function cold() {
  assert.deepEqual(stoppedProcessPids(command('/bin/ps', ['-axo', 'pid=,command=']), paths), [], 'Quit desktop and Host first');
  for (const path of Object.values(paths)) {
    const r = spawnSync('/usr/sbin/lsof', ['-nP', '-t', '+D', path], { encoding: 'utf8' });
    assert.ok(!r.error && [0, 1].includes(r.status) && !r.stdout.trim() && !r.stderr.trim(), 'Protected files still open');
  }
}
const require = createRequire(join(root, 'packages/dsh-bot/package.json'));
const yaml = require('js-yaml'), { entryListSchema } = require('@deepseek-ai/cordis-plugin-include');
async function compose(dir, name) {
  const out = join(run, name + '.yml');
  command(join(paths.app, 'Contents/MacOS/DeepSeek Harness'), ['--expose-internals', join(root, 'scripts/compose-official-desktop-profile.mjs'),
    '--app', paths.app, '--profile-dir', dir, '--home', paths.home, '--output', out], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: paths.home } });
  const raw = await readFile(out, 'utf8');
  // Compare public effective settings after accounting only for package identity and staging location.
  return yaml.load(raw.replaceAll(stage, profile), { schema: entryListSchema });
}
if (mode === 'prepare') {
  await identity();
  const artifact = await realpath(resolve(artifactFile)); assert.ok(artifact.startsWith(root + '/'));
  const audit = await auditArtifact(root, artifact, run);
  assert.equal(audit.name, 'dsh-botgroup'); assert.equal(audit.version, '0.7.0');
  const before = await treeManifest(profile), manifest = await json(join(profile, 'package.json'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-bot-web-app', 'dsh-bot']);
  command('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', profile, stage]);
  assert.equal((await treeManifest(stage)).sha256, before.sha256);
  const previous = await compose(profile, 'effective-before');
  const patch = await readFile(join(stage, 'cordis.patch.yml'), 'utf8');
  const oldSelector = '- id: dsh-bot\n  name: dsh-bot\n', newSelector = '- id: dsh-bot\n  name: dsh-botgroup\n';
  assert.equal(patch.split(oldSelector).length, 2);
  for (const args of [['remove', 'dsh-bot'], ['add', artifact]])
    await writeFile(join(run, args[0] + '.log'), command(join(root, 'scripts/dsh'), ['plugin', '--profile', 'desktop', ...args]), { mode: 0o600 });
  assert.equal(await readFile(join(stage, 'cordis.patch.yml'), 'utf8'), patch);
  await writeFile(join(stage, 'cordis.patch.yml'), patch.replace(oldSelector, newSelector));
  const expected = structuredClone(manifest); delete expected.dependencies['dsh-bot']; expected.dependencies['dsh-botgroup'] = `file:${artifact}`;
  expected.dsh.profile.bundles = manifest.dsh.profile.bundles.map(name => name === 'dsh-bot' ? 'dsh-botgroup' : name);
  assert.deepEqual(await json(join(stage, 'package.json')), expected);
  const next = await compose(stage, 'effective-after');
  const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'name' && child === 'dsh-bot' ? 'dsh-botgroup' : normalize(child)])) : value;
  assert.deepEqual(next, normalize(previous), 'Effective settings changed beyond package name');
  assert.equal((await treeManifest(await realpath(join(stage, 'node_modules/dsh-bot-web-app')))).sha256, expectedCompat);
  await auditInstalled(stageHome, 'desktop', audit);
  assert.equal((await treeManifest(profile)).sha256, before.sha256, 'Daily profile changed during staging');
  await save('prepared.json', { status: 'PASS', paths, artifact, audit, before, staged: await treeManifest(stage),
    effectiveSettingsPreserved: true, realModelRequests: 0 });
  console.log(JSON.stringify({ status: 'PASS', mode, run, sha256: audit.sha256 }));
} else {
  const prepared = await json(join(run, 'prepared.json')); assert.equal(prepared.status, 'PASS');
  await withProfileLock(join(run, 'install.lock'), async () => {
    cold(); await identity();
    assert.equal((await treeManifest(profile)).sha256, prepared.before.sha256);
    assert.equal((await treeManifest(stage)).sha256, prepared.staged.sha256);
    assert.equal(sha(await readFile(prepared.artifact)), prepared.audit.sha256);
    const manifests = {};
    for (const [key, path] of Object.entries(paths)) {
      manifests[key] = await treeManifest(path);
      command('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', path, join(run, 'backup', key)]);
      assert.equal((await treeManifest(join(run, 'backup', key))).sha256, manifests[key].sha256);
    }
    await save('before.json', { status: 'PASS', paths, manifests }); cold();
    const outside = tree => tree.entries.filter(row => row.path !== 'profiles/desktop' && !row.path.startsWith('profiles/desktop/'));
    let exchanged = false;
    try {
      exchangeProfileDirectories(profile, stage); exchanged = true;
      await auditInstalled(paths.home, 'desktop', prepared.audit);
      assert.equal((await treeManifest(profile)).sha256, prepared.staged.sha256);
      assert.deepEqual(outside(await treeManifest(paths.home)), outside(manifests.home));
      for (const key of ['app', 'userData']) assert.equal((await treeManifest(paths[key])).sha256, manifests[key].sha256);
      await save('installed.json', { status: 'PASS', artifactSha256: prepared.audit.sha256, coldDataUnchanged: true, applicationUnchanged: true });
    } catch (error) {
      if (exchanged) exchangeProfileDirectories(profile, stage);
      await save('failed.json', { status: 'FAIL', profileRestored: exchanged, message: String(error.message) }); throw error;
    }
  });
  console.log(JSON.stringify({ status: 'PASS', mode, run }));
}
