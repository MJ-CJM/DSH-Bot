import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const IM_COMMIT = '4645cf767257b4bc32c80f4f18e1f9f6cfbb5060';
const IM_ARCHIVE_SHA256 = '20a961e996dfc5f26a63bc2f203a9149de2bf1cc0af3979566f725e64b2e9427';
/** Download immutable source only into the isolated home; never import private modules. */
export async function prepareIm(runDir: string) {
  const cache = resolve(process.cwd(), '.dsh-dev/p34-sources');
  await mkdir(cache, { recursive: true });
  const archive = resolve(cache, 'dsh-im-source.tgz');
  let bytes: Buffer;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://codeload.github.com/xmanrui/dsh-im/tar.gz/${IM_COMMIT}`, { signal: AbortSignal.timeout(120000) });
    assert.equal(response.ok, true, 'Cannot download the pinned dsh-im source archive');
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(archive, bytes, { flag: 'wx' });
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), IM_ARCHIVE_SHA256, 'dsh-im source archive digest drift');
  const source = resolve(runDir, 'im-source');
  await mkdir(source);
  await new Promise<void>((accept, reject) => {
    const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', source, '--strip-components', '1'], { stdio: 'ignore' });
    child.once('error', reject); child.once('close', code => code === 0 ? accept() : reject(new Error(`tar exit ${code}`)));
  });
  const manifest = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '5.5.0'); assert.equal(manifest.name, '@xmanrui/dsh-im');
  await writeFile(resolve(runDir, 'source-pin.json'), JSON.stringify({ commit: IM_COMMIT, archiveSha256: IM_ARCHIVE_SHA256, package: manifest.name, version: manifest.version, prebuiltEntrypointSha256: createHash('sha256').update(await readFile(resolve(source, 'lib/index.js'))).digest('hex') }, null, 2));
  return source;
}
