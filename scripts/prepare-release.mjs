import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Prepare a local candidate only. Publishing and runtime acceptance remain explicit.
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.argv.length, 3, 'Usage: node scripts/prepare-release.mjs <verified.tgz>');
const artifact = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'), 'utf8'));
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid release version');
assert.ok(['MIT', 'Apache-2.0'].includes(manifest.license), 'Select and review the community license first');
const license = await readFile(resolve(root, 'LICENSE'), 'utf8');
assert.equal(await readFile(resolve(root, 'packages/dsh-bot/LICENSE'), 'utf8'), license, 'Root/package licenses differ');
assert.ok(license.includes(manifest.license === 'MIT' ? 'MIT License' : 'Apache License'), 'License text/metadata mismatch');
execFileSync(process.execPath, [resolve(root, 'scripts/verify-package.mjs'), artifact], { cwd: root, stdio: 'inherit' });
const bytes = await readFile(artifact);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const asset = `${manifest.name}-${manifest.version}.tgz`;
const stableAsset = 'dsh-bot.tgz';
const stableChecksumAsset = `${stableAsset}.sha256`;
const tag = `v${manifest.version}`;
const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
assert.equal(repository, 'https://github.com/MJ-CJM/DSH-Bot');
const download = `${repository}/releases/download/${tag}/${asset}`;
const stableDownload = `${repository}/releases/latest/download/${stableAsset}`;
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const identity = {
  status: 'candidate', published: false, name: manifest.name, version: manifest.version, license: manifest.license,
  gitHead: git(['rev-parse', 'HEAD']), workingTreeDirty: Boolean(git(['status', '--porcelain'])),
  asset, bytes: bytes.length, sha256, tag, plannedDownloadUrl: download,
  stableAsset, stableChecksumAsset, plannedStableDownloadUrl: stableDownload,
  runtimeAcceptance: 'NOT_RUN_BY_THIS_SCRIPT',
};
const parent = resolve(root, 'dist/release-candidates');
await mkdir(parent, { recursive: true });
const destination = resolve(parent, `${tag}-${sha256.slice(0, 12)}`);
// A repeated run refuses to overwrite an existing candidate and its evidence.
await mkdir(destination);
await copyFile(artifact, resolve(destination, asset), constants.COPYFILE_EXCL);
await copyFile(artifact, resolve(destination, stableAsset), constants.COPYFILE_EXCL);
const write = (name, value) => writeFile(resolve(destination, name), value, { flag: 'wx' });
await write('SHA256SUMS', `${sha256}  ${asset}\n`);
// Keep the original single-file checksum usable for versioned-only downloads.
await write(stableChecksumAsset, `${sha256}  ${stableAsset}\n`);
await write('release.json', `${JSON.stringify(identity, null, 2)}\n`);
await write('MJ-CJM__DSH-Bot--packages-dsh-bot.yml', [
  '# Each latest stable Release must include the version-free dsh-bot.tgz asset.',
  `url: ${repository}/tree/main/packages/dsh-bot`,
  'name: MJ-CJM/DSH-Bot#dsh-bot',
  'category: workflow',
  'description:',
  '  en: Personal agents with persistent memory, multi-Bot group collaboration and native background tasks for DeepSeek Harness.',
  '  zh: DeepSeek Harness 个人智能体插件，支持持久记忆、多 Bot 群聊协作和原生后台任务。',
  'icon: https://raw.githubusercontent.com/MJ-CJM/DSH-Bot/main/packages/dsh-bot/assets/icon-256.png',
  `tarball: ${stableDownload}`, '',
].join('\n'));
const notes = await readFile(resolve(root, 'docs/release-notes-template.md'), 'utf8');
await write('RELEASE_NOTES.md', notes.replaceAll('{{VERSION}}', manifest.version)
  .replaceAll('{{ASSET}}', asset).replaceAll('{{SHA256}}', sha256).replaceAll('{{LICENSE}}', manifest.license));
await write('PUBLISH_CHECKLIST.md', [
  '# Candidate review / 候选包审核', '',
  'This directory is not a public release. 本目录不表示已经发布或通过运行验收。', '',
  '- [ ] Review license, current source and the exact artifact hash; retain third-party notices.',
  '- [ ] Run isolated Host/UI and applicable upgrade checks against this exact tgz; record DSH version and evidence.',
  '- [ ] Replace the release-notes validation checklist with actual results and limitations.',
  '- [ ] Confirm the eventual tag points at the reviewed source; explain any dirty working-tree provenance in release.json.',
  '- [ ] Maintainer uploads both byte-identical tgz files, SHA256SUMS, dsh-bot.tgz.sha256, release.json and completed release notes to the same Release.',
  '- [ ] Keep prereleases separate. Promote a stable Release to latest only after every asset is uploaded.',
  '- [ ] Independently download the pinned and latest URLs and verify their matching hashes; do not rebuild between validation and upload.',
  '- [ ] Verify latest resolves to the intended stable tag; never use a versioned filename after latest/download/.',
  '- [ ] Update README publication status and install links only when the Release is live.',
  '- [ ] Set repository topic dsh-plugin and description; confirm a private security-reporting channel.',
  '- [ ] Publish the exact verified archive to npm; re-download and compare its contents and registry integrity.',
  '- [ ] Keep the default-branch package name and npm repository metadata aligned. The existing awesome-dsh-plugin entry automatically discovers npm; do not add an unsupported npm YAML field.',
  '- [ ] Verify plugins.json npm/install mapping and the dated npm download figure after the catalog refresh. GitHub asset downloads remain separate.', '',
].join('\n'));
console.log(`Prepared candidate (NOT published or runtime-accepted): ${destination}`);
