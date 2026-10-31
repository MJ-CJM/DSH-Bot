/** Check installed npm manifests and their public entry points, not source deep imports. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTypertRemoteInfo, Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createTypertRemoteInfo as browserSafeFactory } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { RemoteSnapshotStream } from '@deepseek-ai/dsh-api-gateway/client';

for (const symbol of [createTypertRemoteInfo, browserSafeFactory, Remote, TypertRemoteService, TypertRegistry, RemoteSnapshotStream]) assert.equal(typeof symbol, 'function');
assert.equal(typeof TypertRegistry.prototype.register, 'function');
const require = createRequire(import.meta.url);
const results = [];
for (const name of ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-typert-registry', '@deepseek-ai/dsh-api-gateway']) {
  const path = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { version: string; exports: Record<string, unknown> };
  assert.equal(manifest.version, '0.2.1-rc.2');
  const declarations = await readFile(resolve(dirname(path), 'lib/types/index.d.ts'), 'utf8');
  if (name.endsWith('typert-protocol')) {
    assert.match(declarations, /export \{ createTypertRemoteInfo/);
    const types = await readFile(resolve(dirname(path), 'lib/types/types.d.ts'), 'utf8');
    assert.match(types, /\$mount\(contribution: TypertRemoteContribution\)/);
  }
  if (name.endsWith('typert-registry')) assert.match(declarations, /register\(contribution: TypertContribution\): TypertDisposer/);
  if (name.endsWith('api-gateway')) {
    const client = await readFile(resolve(dirname(path), 'lib/types/client/index.d.ts'), 'utf8');
    assert.match(client, /interface ClientRemote extends TypertClientRemote/);
  }
  results.push({ name, version: manifest.version, exports: manifest.exports, publicSymbols: 'PASS' });
}
const output = resolve(process.cwd(), '.dsh-dev/t02-review');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'public-exports.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log('PASS published rc.2 manifest exports, named runtime imports and public register/$mount declarations');
