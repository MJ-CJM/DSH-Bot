import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, dir, mode] = process.argv.slice(2);
const installed = resolve(dir, 'package');
const artifact = version => resolve(root, `dist/dsh-bot-${version}.tgz`);
const url = path => pathToFileURL(resolve(installed, path)).href;
await mkdir(dir, { recursive: true });
await symlink(resolve(root, 'packages/dsh-bot/node_modules'), resolve(dir, 'node_modules'), 'dir');
if (mode === 'other-cache') {
  execFileSync('/usr/bin/tar', ['-xzf', artifact('0.4.0'), '-C', dir]);
  await import(url('lib/shared/version.js'));
}
if (mode === 'legacy') {
  execFileSync('/usr/bin/tar', ['-xzf', artifact('0.3.2'), '-C', dir]);
  const schema = await import(url('lib/shared/schema.js'));
  assert.equal('memoryFields' in schema, false);
  execFileSync('/usr/bin/tar', ['-xzf', artifact('0.4.0'), '-C', dir]);
  await assert.rejects(import(`${url('lib/shared/memory-v2.js')}?reproduce`),
    /does not provide an export named 'memoryFields'/);
}
execFileSync('/usr/bin/tar', ['-xzf', artifact('0.4.1'), '-C', dir]);
if (mode === 'mixed') {
  const path = resolve(installed, 'lib/shared/schema.js');
  await writeFile(path, `${await readFile(path, 'utf8')}\n// partial install\n`);
}
if (mode === 'link-error') {
  const path = resolve(installed, 'lib/host/index.js');
  await writeFile(path, `import { missing } from '../shared/version.js';\n${await readFile(path, 'utf8')}`);
  // Keep the integrity manifest consistent: this case must reach the dynamic linker boundary.
  const { createHash } = await import('node:crypto');
  const manifestPath = resolve(installed, 'lib/module-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files['host/index.js'] = createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest));
}
const plugin = await import(`${url('lib/index.js')}?new-entry`);
assert.equal(plugin.VERSION, '0.4.1');
if (mode === 'replaced-entry') {
  assert.equal(typeof plugin.Config, 'function');
  const manifestPath = resolve(installed, 'lib/module-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath)); manifest.version = '0.4.2';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal(await import(`${url('lib/index.js')}?new-entry`), plugin, 'The bootstrap stays cached');
}
if (mode === 'fresh') assert.equal(typeof plugin.Config, 'function');
else {
  if (mode !== 'replaced-entry') assert.deepEqual(plugin.inject, []);
  let touched = 0;
  const context = new Proxy({}, { get() { touched++; throw Error('Must not access Host services'); } });
  assert.throws(() => plugin.apply(context, {}), error => {
    assert.match(error.message, /请完全退出并重新打开 DSH/);
    assert.match(error.message, /Fully quit and reopen DSH/);
    assert.doesNotMatch(error.message, /SyntaxError|memoryFields|missing/);
    assert.equal(error.cause, undefined); return true;
  });
  assert.equal(touched, 0);
}
console.log(JSON.stringify({ status: 'PASS', mode, nativeEsm: true, fullHost: false, pid: process.pid }));
