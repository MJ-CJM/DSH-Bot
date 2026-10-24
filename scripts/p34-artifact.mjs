import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function command(bin, args, options = {}) {
  let output = '';
  const code = await new Promise((accept, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', accept);
  });
  return { code, output };
}
async function files(dir, base = dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected symlink: ${path}`);
    if (entry.isDirectory()) result.push(...await files(path, base));
    else { assert.ok(entry.isFile()); result.push(relative(base, path)); }
  }
  return result.sort();
}
export async function auditArtifact(root, artifact, runDir) {
  const listing = await command('/usr/bin/tar', ['-tzf', artifact]);
  assert.equal(listing.code, 0);
  for (const path of listing.output.trim().split('\n')) {
    assert.ok(path.startsWith('package/') && !path.split('/').includes('..'), `Unsafe entry ${path}`);
    assert.ok(/^package\/(?:package\.json|README\.md|LICENSE|cordis\.patch\.yml|icon\.svg|locale\/(?:en|zh)\.json|lib\/.*)$/.test(path));
  }
  const unpacked = resolve(runDir, 'unpacked');
  await mkdir(unpacked, { recursive: true });
  assert.equal((await command('/usr/bin/tar', ['-xzf', artifact, '-C', unpacked])).code, 0);
  const packedRoot = resolve(unpacked, 'package');
  const manifest = JSON.parse(await readFile(resolve(packedRoot, 'package.json')));
  assert.equal(manifest.name, 'dsh-bot');
  assert.equal(manifest.version, JSON.parse(await readFile(resolve(root, 'packages/dsh-bot/package.json'))).version);
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.2 <0.3.0');
  assert.equal(manifest.license, 'UNLICENSED');
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.1-rc.2', name);
  }
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], '4.0.5');
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '^4.0.5');
  const paths = await files(packedRoot);
  const audit = [];
  for (const file of paths) {
    const bytes = await readFile(resolve(packedRoot, file));
    const source = await readFile(resolve(root, 'packages/dsh-bot', file));
    // pnpm serializes package.json again (including its final newline).
    if (file === 'package.json') assert.deepEqual(JSON.parse(bytes), JSON.parse(source));
    else assert.deepEqual(bytes, source, `Source/packed mismatch: ${file}`);
    assert.ok(!/P34_PRODUCT_SENTINEL_[a-f0-9-]{36}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString()), `Secret in ${file}`);
    // Sourcemaps are checked too: no local checkout path is distributed.
    assert.ok(!bytes.includes(Buffer.from(root)), `Machine path in ${file}`);
    audit.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const leaves = value => typeof value === 'string' ? [value] : Object.values(value).flatMap(leaves);
  for (const target of leaves(manifest.exports)) {
    if (target.includes('*')) continue;
    assert.ok(paths.includes(target.replace(/^\.\//, '')), `Missing export ${target}`);
  }
  const en = JSON.parse(await readFile(resolve(packedRoot, 'locale/en.json')));
  const zh = JSON.parse(await readFile(resolve(packedRoot, 'locale/zh.json')));
  assert.deepEqual(Object.keys(en.ui).sort(), Object.keys(zh.ui).sort());
  assert.ok(en.meta.title && zh.meta.title && en.meta.description && zh.meta.description);
  const git = await command('git', ['rev-parse', 'HEAD'], { cwd: root });
  assert.equal(git.code, 0);
  const bytes = await readFile(artifact);
  const result = { name: manifest.name, version: manifest.version, dshPin: '0.2.1-rc.2',
    engines: manifest.engines, gitHead: git.output.trim(), workingTree: 'Release changes not committed',
    artifact: relative(root, artifact), sha256: sha256(bytes), bytes: bytes.length, files: audit,
    buildCommands: ['scripts/pnpm check', 'scripts/pnpm pack:plugin'], published: false };
  await writeFile(resolve(runDir, 'artifact-manifest.json'), `${JSON.stringify(result, null, 2)}\n`);
  return { ...result, packedRoot };
}
export async function auditInstalled(home, profile, artifact) {
  assert.match(profile, /^[a-z0-9-]+$/);
  const installedRoot = resolve(home, 'profiles', profile, 'node_modules/dsh-bot');
  for (const { file, sha256: expected } of artifact.files) {
    assert.equal(sha256(await readFile(resolve(installedRoot, file))), expected, `Installed mismatch: ${file}`);
  }
  return { profile, version: artifact.version, files: artifact.files.length, artifactSha256: artifact.sha256, status: 'PASS' };
}
