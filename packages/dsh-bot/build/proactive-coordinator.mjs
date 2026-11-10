import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = resolve(root, 'coordinator/vendor');
const output = resolve(root, 'lib/proactive-coordinator');
const pin = JSON.parse(await readFile(resolve(vendor, 'pin.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [file, digest] of Object.entries(pin.files)) {
  assert.ok(
    /^(?:LICENSE$|(?:src|prompts|skills)\/[\w./-]+$)/.test(file) &&
      !file.split('/').includes('..'),
  );
  assert.equal(
    sha256(await readFile(resolve(vendor, file))),
    digest,
    `Pinned upstream file changed: ${file}`,
  );
}
await mkdir(output, { recursive: true });
const options = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  metafile: true,
  absWorkingDir: root,
};
const core = await build({
  ...options,
  stdin: {
    resolveDir: vendor,
    sourcefile: 'coordinator-core.ts',
    contents: [
      "export * from './src/core/index.ts'",
      "export { Store, SCHEMA_VERSION } from './src/app/store.ts'",
      "export { Effects } from './src/app/effects.ts'",
      "export { Outbox as DurableOutbox } from './src/app/outbox.ts'",
    ].join('\n'),
  },
  outfile: resolve(output, 'core.mjs'),
});
const worker = await build({
  ...options,
  entryPoints: ['coordinator/main.ts'],
  external: ['./core.mjs'],
  outfile: resolve(output, 'main.mjs'),
});
for (const bundle of [core, worker]) {
  for (const { imports } of Object.values(bundle.metafile.outputs))
    for (const entry of imports) {
      assert.ok(
        entry.path.startsWith('node:') || entry.path === './core.mjs',
        `Unbundled coordinator import: ${entry.path}`,
      );
    }
}
for (const name of ['LICENSE', 'prompts', 'skills'])
  await cp(resolve(vendor, name), resolve(output, name), { recursive: true });
await writeFile(
  resolve(output, 'package.json'),
  '{"name":"dsh-superagent","private":true,"type":"module","license":"MIT"}\n',
);
const entryHashes = {};
for (const name of ['core.mjs', 'main.mjs'])
  entryHashes[name] = sha256(await readFile(resolve(output, name)));
await writeFile(
  resolve(output, 'provenance.json'),
  `${JSON.stringify({ revision: pin.revision, files: entryHashes }, null, 2)}\n`,
);
