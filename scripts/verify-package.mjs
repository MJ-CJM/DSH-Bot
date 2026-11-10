import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'packages/dsh-bot');
assert.ok(process.argv[2], 'Usage: node scripts/verify-package.mjs <tarball>');
const tarball = resolve(process.argv[2]);
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
for (const entry of entries) {
  assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..') && !entry.includes('\\'),
    `Unsafe archive path: ${entry}`);
  if (entry === 'package/' || entry === 'package/assets/') continue;
  assert.ok(/^package\/(?:lib\/|locale\/|package\.json$|cordis\.patch\.yml$|icon\.svg$|assets\/logo-1024\.png$|README(?:\.en)?\.md$|LICENSE$|THIRD_PARTY_NOTICES\.txt$)/.test(entry),
    `Unexpected published file: ${entry}`);
}
await mkdir(resolve(root, '.dsh-dev'), { recursive: true });
const temporary = await mkdtemp(resolve(root, '.dsh-dev/package-check-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const packed = resolve(temporary, 'package');
  const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const manifest = await json(resolve(packed, 'package.json'));
  const current = await json(resolve(source, 'package.json'));
  // pnpm pack may reformat/reorder JSON without changing published metadata.
  // Compare the entire object, including every dependency and publishing field.
  assert.deepEqual(manifest, current, 'Packed package metadata differs from source');
  assert.equal(manifest.name, 'dsh-bot');
  assert.equal(manifest.version, current.version);
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.2 <0.3.0');
  assert.deepEqual(manifest.exports, current.exports);
  assert.deepEqual(manifest.dsh, current.dsh);
  for (const required of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/client.js.map',
    'lib/module-manifest.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg',
    'assets/logo-1024.png', 'README.md', 'README.en.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
    assert.ok((await readFile(resolve(packed, required))).length > 0, `Missing or empty: ${required}`);
  }
  const hostManifest = await json(resolve(packed, 'lib/module-manifest.json'));
  assert.equal(hostManifest.version, manifest.version);
  const hostFiles = [];
  async function inspect(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, item.name);
      if (item.isDirectory()) await inspect(file);
      else {
        assert.ok(item.isFile(), `Unexpected archive entry: ${file}`);
        const name = relative(packed, file).split('\\').join('/');
        if (name === 'package.json') continue;
        assert.deepEqual(await readFile(file), await readFile(resolve(source, name)), `Packed bytes differ: ${name}`);
        const key = relative(resolve(packed, 'lib'), file).split('\\').join('/');
        if (name.startsWith('lib/') && key.endsWith('.js') && !['index.js', 'client.js'].includes(key)) hostFiles.push(key);
      }
    }
  }
  await inspect(packed);
  assert.deepEqual(Object.keys(hostManifest.files).sort(), hostFiles.sort(), 'Host manifest must cover every module');
  for (const [key, hash] of Object.entries(hostManifest.files)) {
    assert.ok(/^(?:host|shared)\/[\w./-]+\.js$|^typert[\w.-]*\.js$/.test(key) && !key.split('/').includes('..'),
      `Invalid module key: ${key}`);
    const bytes = await readFile(resolve(packed, 'lib', key));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, `Module hash mismatch: ${key}`);
    assert.ok(bytes.toString().includes(`DSH_BOT_MODULE_VERSION = '${manifest.version}'`), `Unstamped module: ${key}`);
  }
  const client = await readFile(resolve(packed, 'lib/client.js'), 'utf8');
  assert.ok(client.startsWith('window.__ModuleLoader__.load('), 'Missing DSH client closure factory');
  assert.ok((await readFile(resolve(packed, 'lib/index.js'), 'utf8')).includes(`VERSION = '${manifest.version}'`));
  console.log(`PASS: ${manifest.name}@${manifest.version} package bytes, metadata, client closure and ${hostFiles.length} Host module hashes`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
