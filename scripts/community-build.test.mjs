import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { moduleManifestKey } from '../packages/dsh-bot/build/manifest-path.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../.dsh-dev/', import.meta.url), { recursive: true });
async function fixture(run) {
  const directory = await mkdtemp(`${root}.dsh-dev/community-中文 空格-%-`);
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Windows paths become the same URL-relative manifest keys as POSIX builds', () => {
  assert.equal(moduleManifestKey('C:\\项目 空格\\lib', 'C:\\项目 空格\\lib\\host\\registry.js', win32), 'host/registry.js');
  assert.equal(moduleManifestKey('/项目 空格/lib', '/项目 空格/lib/host/registry.js'), 'host/registry.js');
});

test('pnpm wrapper contains version-manager data, state and temp files within its checkout', async () => fixture(async (directory) => {
  await mkdir(`${directory}/scripts`);
  await mkdir(`${directory}/bin`);
  await copyFile(`${root}scripts/pnpm`, `${directory}/scripts/pnpm`);
  await writeFile(`${directory}/bin/pnpm`, '#!/bin/sh\nprintf "%s\\n" "$PNPM_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$TMPDIR"\n', { mode: 0o755 });
  const output = execFileSync(`${directory}/scripts/pnpm`, ['--version'], {
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, DSH_BOT_KEEP_USER_STATE: '' }, encoding: 'utf8',
  }).trim().split('\n');
  assert.deepEqual(output, ['pnpm-home', 'data', 'state', 'tmp'].map(name => `${directory}/.dsh-dev/${name}`));
}));

test('Host stamping works in a checkout containing Chinese, spaces and percent signs', async () => fixture(async (directory) => {
  await mkdir(`${directory}/build`);
  await mkdir(`${directory}/lib/shared`, { recursive: true });
  for (const file of ['host-versions.mjs', 'manifest-path.mjs'])
    await copyFile(`${root}packages/dsh-bot/build/${file}`, `${directory}/build/${file}`);
  await writeFile(`${directory}/package.json`, JSON.stringify({ version: '1.2.3' }));
  await writeFile(`${directory}/lib/index.js`, "export const VERSION = '1.2.3';\n");
  await writeFile(`${directory}/lib/shared/version.js`, "export const version = '1.2.3';\n");
  execFileSync(process.execPath, [`${directory}/build/host-versions.mjs`]);
  const manifest = JSON.parse(await readFile(`${directory}/lib/module-manifest.json`, 'utf8'));
  assert.deepEqual(Object.keys(manifest.files), ['shared/version.js']);
  assert.match(await readFile(`${directory}/lib/shared/version.js`, 'utf8'), /DSH_BOT_MODULE_VERSION = '1\.2\.3'/);
}));

test('DSH override wins over PATH, and a broken explicit override fails clearly', async () => fixture(async (directory) => {
  const mock = `${directory}/chosen dsh`;
  await writeFile(mock, '#!/bin/sh\nprintf "override:%s\\n" "$1"\n', { mode: 0o755 });
  await writeFile(`${directory}/dsh`, '#!/bin/sh\nprintf "path:%s\\n" "$1"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, DSH_BOT_DSH_BIN: mock };
  assert.equal(execFileSync(`${root}scripts/dsh`, ['a b'], { env, encoding: 'utf8' }).trim(), 'override:a b');
  assert.equal(execFileSync(`${root}scripts/dsh`, ['--version'], { env: { ...env, DSH_BOT_DSH_BIN: '' }, encoding: 'utf8' }).trim(), 'path:--version');
  const bad = spawnSync(`${root}scripts/dsh`, [], { env: { ...env, DSH_BOT_DSH_BIN: `${directory}/missing` }, encoding: 'utf8' });
  assert.equal(bad.status, 127);
  assert.match(bad.stderr, /DSH_BOT_DSH_BIN is not executable/);
  const self = spawnSync(`${root}scripts/dsh`, [], { env: { ...env, DSH_BOT_DSH_BIN: `${root}scripts/dsh` }, encoding: 'utf8' });
  assert.equal(self.status, 127);
  assert.match(self.stderr, /points to scripts\/dsh itself/);
}));

test('Dev profile separates exact rc.2 from explicit rc.3 compatibility evidence and isolates state', async () => fixture(async (directory) => {
  await mkdir(`${directory}/scripts`);
  await mkdir(`${directory}/packages/dsh-bot/lib`, { recursive: true });
  for (const script of ['dsh', 'dev-profile.sh']) await copyFile(`${root}scripts/${script}`, `${directory}/scripts/${script}`);
  for (const file of ['index.js', 'client.js']) await writeFile(`${directory}/packages/dsh-bot/lib/${file}`, 'fixture');
  const mock = `${directory}/mock dsh`;
  await writeFile(mock, '#!/bin/sh\ncase "$1" in\n--version) echo "$MOCK_VERSION";;\nplugin) test "$DSH_HOME" = "$PWD/.dsh-dev"; printf "%s\\n" "$*" >> "$DSH_HOME/calls";;\n--profile) printf "# == dsh-bot\\ndsh-bot: fixture\\n";;\nesac\n', { mode: 0o755 });
  const env = { ...process.env, DSH_BOT_DSH_BIN: mock, MOCK_VERSION: '0.2.1-rc.3', DSH_HOME: '/must-not-be-used' };
  const invoke = (args, settings = env) => spawnSync(`${directory}/scripts/dev-profile.sh`, args, { env: settings, encoding: 'utf8' });
  const refused = invoke([]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Expected exactly DSH 0.2.1-rc.2/);
  await assert.rejects(readFile(`${directory}/.dsh-dev/calls`), { code: 'ENOENT' });
  const compatible = invoke(['--compatible']);
  assert.equal(compatible.status, 0, compatible.stderr);
  const receipt = JSON.parse(await readFile(`${directory}/.dsh-dev/dev-profile-version.json`, 'utf8'));
  assert.equal(receipt.actualVersion, '0.2.1-rc.3');
  assert.equal(receipt.exactRc2, false);
  assert.equal(receipt.runtimeActivation, 'NOT_RUN');
  assert.match(await readFile(`${directory}/.dsh-dev/calls`, 'utf8'), /^plugin --profile dev add /);
  assert.equal(invoke(['--compatible'], { ...env, MOCK_VERSION: '0.3.0' }).status, 1);
  const exact = invoke([], { ...env, MOCK_VERSION: '0.2.1-rc.2' });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(await readFile(`${directory}/.dsh-dev/dev-profile-version.json`, 'utf8')).exactRc2, true);
}));

test('Tarball verification accepts complete bytes and rejects corrupt payloads or module digests', async () => fixture(async (directory) => {
  await mkdir(`${directory}/scripts`);
  await copyFile(`${root}scripts/verify-package.mjs`, `${directory}/scripts/verify-package.mjs`);
  const source = `${directory}/packages/dsh-bot`;
  const hostSource = "export const DSH_BOT_MODULE_VERSION = '1.2.3';\n";
  const files = {
    'package.json': JSON.stringify({ name: 'dsh-bot', version: '1.2.3', engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, exports: {}, dsh: {}, dependencies: { fixture: '1.0.0' } }),
    'lib/index.js': "export const VERSION = '1.2.3';\n",
    'lib/index.d.ts': 'export declare const VERSION: string;\n',
    'lib/client.js': 'window.__ModuleLoader__.load({});\n',
    'lib/client.js.map': '{}',
    'lib/shared/version.js': hostSource,
    'lib/module-manifest.json': JSON.stringify({ version: '1.2.3', files: { 'shared/version.js': createHash('sha256').update(hostSource).digest('hex') } }),
    'cordis.patch.yml': 'fixture: true\n', 'locale/en.json': '{}', 'locale/zh.json': '{}',
    'icon.svg': '<svg/>', 'assets/logo-1024.png': 'Fixture image',
    'README.md': 'Fixture', 'README.en.md': 'English fixture', LICENSE: 'Fixture license', 'THIRD_PARTY_NOTICES.txt': 'Fixture notices',
  };
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(`${source}/${file.slice(0, file.lastIndexOf('/') + 1)}`, { recursive: true });
    await writeFile(`${source}/${file}`, bytes);
  }
  await cp(source, `${directory}/stage/package`, { recursive: true });
  const metadata = JSON.parse(files['package.json']);
  await writeFile(`${directory}/stage/package/package.json`, `${JSON.stringify(Object.fromEntries(Object.entries(metadata).reverse()), null, 2)}\n`);
  const archive = `${directory}/fixture.tgz`;
  const pack = () => execFileSync('tar', ['-czf', archive, '-C', `${directory}/stage`, 'package']);
  const verify = () => spawnSync(process.execPath, [`${directory}/scripts/verify-package.mjs`, archive], { encoding: 'utf8' });
  pack();
  const complete = verify();
  assert.equal(complete.status, 0, complete.stderr);
  await rm(`${directory}/stage/package/assets/logo-1024.png`);
  pack();
  const missingLogo = verify();
  assert.equal(missingLogo.status, 1);
  assert.match(missingLogo.stderr, /ENOENT.*assets\/logo-1024\.png/);
  await writeFile(`${directory}/stage/package/assets/logo-1024.png`, files['assets/logo-1024.png']);
  await writeFile(`${directory}/stage/package/README.en.md`, 'Stale English documentation');
  pack();
  const staleReadme = verify();
  assert.equal(staleReadme.status, 1);
  assert.match(staleReadme.stderr, /Packed bytes differ: README.en.md/);
  await writeFile(`${directory}/stage/package/README.en.md`, files['README.en.md']);
  await writeFile(`${directory}/stage/package/package.json`, JSON.stringify({ ...metadata, dependencies: { fixture: '2.0.0' } }));
  pack();
  const changedDependency = verify();
  assert.equal(changedDependency.status, 1);
  assert.match(changedDependency.stderr, /Packed package metadata differs from source/);
  await writeFile(`${directory}/stage/package/package.json`, files['package.json']);
  await writeFile(`${directory}/stage/package/lib/shared/version.js`, 'corrupted');
  pack();
  const corrupt = verify();
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /Packed bytes differ/);
  await writeFile(`${directory}/stage/package/lib/shared/version.js`, hostSource);
  const badDigest = JSON.stringify({ version: '1.2.3', files: { 'shared/version.js': '0'.repeat(64) } });
  await writeFile(`${source}/lib/module-manifest.json`, badDigest);
  await writeFile(`${directory}/stage/package/lib/module-manifest.json`, badDigest);
  pack();
  const digest = verify();
  assert.equal(digest.status, 1);
  assert.match(digest.stderr, /Module hash mismatch/);
}));
