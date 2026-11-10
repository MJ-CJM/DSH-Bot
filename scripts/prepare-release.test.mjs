import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Candidate preparation rejects stale/unlicensed packages and never overwrites an accepted candidate', async () => {
  await mkdir(`${root}.dsh-dev`, { recursive: true });
  const directory = await mkdtemp(`${root}.dsh-dev/release-中文 空格-`);
  try {
    await mkdir(`${directory}/scripts`);
    await mkdir(`${directory}/docs`);
    for (const file of ['prepare-release.mjs', 'verify-package.mjs', 'p34-artifact.mjs'])
      await copyFile(`${root}scripts/${file}`, `${directory}/scripts/${file}`);
    await copyFile(`${root}docs/release-notes-template.md`, `${directory}/docs/release-notes-template.md`);
    const source = `${directory}/packages/dsh-bot`;
    const manifest = { name: 'dsh-bot', version: '0.6.3', license: 'MIT',
      engines: { dsh: '>=0.2.1-rc.2 <0.3.0' }, exports: {}, dsh: { bundle: { patch: './cordis.patch.yml' } },
      repository: { url: 'git+https://github.com/MJ-CJM/DSH-Bot.git' },
      devDependencies: { '@deepseek-ai/cordis': '4.0.5' }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.5' } };
    const hostSource = "export const DSH_BOT_MODULE_VERSION = '0.6.3';\n";
    const files = {
      'package.json': JSON.stringify(manifest), LICENSE: 'MIT License\nFixture license\n',
      'lib/index.js': "export const VERSION = '0.6.3';\n", 'lib/index.d.ts': 'export declare const VERSION: string;\n',
      'lib/client.js': 'window.__ModuleLoader__.load({});\n', 'lib/client.js.map': '{}',
      'lib/shared/version.js': hostSource,
      'lib/module-manifest.json': JSON.stringify({ version: '0.6.3', files: { 'shared/version.js': createHash('sha256').update(hostSource).digest('hex') } }),
      'cordis.patch.yml': '[]\n', 'locale/en.json': '{"ui":{},"meta":{"title":"Bot","description":"Bot"}}',
      'locale/zh.json': '{"ui":{},"meta":{"title":"Bot","description":"Bot"}}',
      'icon.svg': '<svg/>', 'assets/logo-1024.png': 'Fixture image',
      'README.md': 'Fixture', 'README.en.md': 'English fixture', 'THIRD_PARTY_NOTICES.txt': 'Fixture notices',
    };
    for (const [file, bytes] of Object.entries(files)) {
      await mkdir(`${source}/${file.slice(0, file.lastIndexOf('/') + 1)}`, { recursive: true });
      await writeFile(`${source}/${file}`, bytes);
    }
    await writeFile(`${directory}/LICENSE`, files.LICENSE);
    await cp(source, `${directory}/stage/package`, { recursive: true });
    const archive = `${directory}/fixture.tgz`;
    execFileSync('tar', ['-czf', archive, '-C', `${directory}/stage`, 'package/']);
    const invoke = () => spawnSync(process.execPath, [`${directory}/scripts/prepare-release.mjs`, archive], { cwd: directory, encoding: 'utf8' });
    await writeFile(`${source}/package.json`, JSON.stringify({ ...manifest, license: 'UNLICENSED' }));
    assert.match(invoke().stderr, /Select and review the community license first/);
    await writeFile(`${source}/package.json`, files['package.json']);
    await writeFile(`${source}/README.md`, 'Changed since packing');
    assert.match(invoke().stderr, /Packed bytes differ/);
    await writeFile(`${source}/README.md`, files['README.md']);
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    const [candidate] = await readdir(`${directory}/dist/release-candidates`);
    const output = `${directory}/dist/release-candidates/${candidate}`;
    const identity = JSON.parse(await readFile(`${output}/release.json`));
    assert.equal(identity.published, false);
    assert.equal(identity.runtimeAcceptance, 'NOT_RUN_BY_THIS_SCRIPT');
    const copied = await readFile(`${output}/dsh-bot-0.6.3.tgz`);
    assert.deepEqual(copied, await readFile(archive));
    assert.deepEqual(await readFile(`${output}/dsh-bot.tgz`), copied);
    assert.equal(identity.stableAsset, 'dsh-bot.tgz');
    assert.equal(identity.stableChecksumAsset, 'dsh-bot.tgz.sha256');
    assert.equal(identity.plannedDownloadUrl, 'https://github.com/MJ-CJM/DSH-Bot/releases/download/v0.6.3/dsh-bot-0.6.3.tgz');
    assert.equal(identity.plannedStableDownloadUrl, 'https://github.com/MJ-CJM/DSH-Bot/releases/latest/download/dsh-bot.tgz');
    assert.equal(identity.sha256, createHash('sha256').update(copied).digest('hex'));
    assert.equal(await readFile(`${output}/SHA256SUMS`, 'utf8'), `${identity.sha256}  dsh-bot-0.6.3.tgz\n`);
    assert.equal(await readFile(`${output}/dsh-bot.tgz.sha256`, 'utf8'), `${identity.sha256}  dsh-bot.tgz\n`);
    assert.match(await readFile(`${output}/MJ-CJM__DSH-Bot--packages-dsh-bot.yml`, 'utf8'), /tarball: https:\/\/github.com\/MJ-CJM\/DSH-Bot\/releases\/latest\/download\/dsh-bot\.tgz\n/);
    assert.doesNotMatch(await readFile(`${output}/RELEASE_NOTES.md`, 'utf8'), /\{\{/);
    assert.match(invoke().stderr, /EEXIST/);
    assert.deepEqual(await readFile(`${output}/dsh-bot-0.6.3.tgz`), copied);
    assert.deepEqual(await readFile(`${output}/dsh-bot.tgz`), copied);

    // The same archive must pass the real Host fixture's audit, including notices and a chosen license.
    await mkdir(`${directory}/runtime`);
    const audit = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const {auditArtifact}=await import(process.argv[1]); await auditArtifact(process.argv[2],process.argv[3],process.argv[4]);',
      `${directory}/scripts/p34-artifact.mjs`, directory, archive, `${directory}/runtime`], { encoding: 'utf8' });
    assert.equal(audit.status, 0, audit.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
