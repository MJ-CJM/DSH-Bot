import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SHA256, MARKER, patchBotModeRenderer } from '../adapters/bot-mode-renderer/patch.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Copy the immutable rc.2 package, retaining its MIT license and public metadata. */
export async function buildBotModeRendererAdapter({ output = resolve(root, '.dsh-dev/bot-mode-adapter/renderer-package') } = {}) {
  assert.ok(resolve(output).startsWith(`${root}/.dsh-dev/`), 'Adapter output must stay in repository .dsh-dev');
  const require = createRequire(resolve(root, '.dsh-dev/proactive-bot/host-runtime/package.json'));
  const cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
  const original = dirname(cli.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json'));
  const metadata = JSON.parse(await readFile(resolve(original, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '0.2.1-rc.2'); assert.equal(metadata.license, 'MIT');
  const client = patchBotModeRenderer(await readFile(resolve(original, 'lib/client.js')));
  await mkdir(output, { recursive: true }); await cp(original, output, { recursive: true, dereference: true });
  await writeFile(resolve(output, 'lib/client.js'), client);
  await unlink(resolve(output, 'lib/client.js.map')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  assert.deepEqual(await readFile(resolve(output, 'LICENSE')), await readFile(resolve(original, 'LICENSE')));
  const receipt = { experimental: true, baseline: '0.2.1-rc.2', marker: MARKER, package: output, originalPackage: await realpath(original),
    originalClientSha256: BASELINE_SHA256, sha256: createHash('sha256').update(client).digest('hex'), bytes: Buffer.byteLength(client),
    metadataChanged: false, sourceTag: 'dsh-v0.2.1-rc.2', license: 'MIT',
    scope: 'RootOutlet waits through an empty registration gap only after a committed valid root; initial and abdicated-root failures unchanged' };
  await writeFile(resolve(output, 'adapter-manifest.json'), JSON.stringify(receipt, null, 2)); return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await buildBotModeRendererAdapter(), null, 2));
