import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { command, sha256 } from '../p34-artifact.mjs';

/** Recheck an earlier source audit against every byte of this immutable tgz.
 * This is package identity evidence, not a claim about the current worktree. */
export async function frozenArtifactAudit(artifact, manifestPath, runDir) {
  const audit = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(audit.name, 'dsh-bot'); assert.equal(audit.dshPin, '0.2.1-rc.2');
  const bytes = await readFile(artifact);
  assert.equal(sha256(bytes), audit.sha256, 'Previously audited artifact digest changed');
  assert.equal(bytes.length, audit.bytes);
  const expected = new Map(audit.files.map(row => [row.file, row]));
  assert.equal(expected.size, audit.files.length);
  const listing = await command('/usr/bin/tar', ['-tzf', artifact]); assert.equal(listing.code, 0);
  for (const path of listing.output.trim().split('\n')) {
    assert.ok(path.startsWith('package/') && !path.split('/').includes('..'));
    if (!path.endsWith('/')) assert.ok(expected.has(path.slice('package/'.length)), 'Archive has an unaudited entry');
  }
  const unpacked = resolve(runDir, 'frozen-audit'); await mkdir(unpacked, { recursive: true });
  assert.equal((await command('/usr/bin/tar', ['-xzf', artifact, '-C', unpacked])).code, 0);
  const packedRoot = resolve(unpacked, 'package'), seen = new Set();
  async function visit(dir) {
    for (const row of await readdir(dir, { withFileTypes: true })) {
      assert.ok(!row.isSymbolicLink(), 'Packed links are not allowed');
      const path = resolve(dir, row.name);
      if (row.isDirectory()) await visit(path);
      else {
        assert.ok(row.isFile());
        const name = relative(packedRoot, path), original = expected.get(name);
        assert.ok(original, `Unaudited package file: ${name}`);
        const content = await readFile(path);
        assert.equal(content.length, original.bytes); assert.equal(sha256(content), original.sha256, `Package file changed: ${name}`);
        seen.add(name);
      }
    }
  }
  await visit(packedRoot); assert.equal(seen.size, expected.size, 'Audited file missing from package');
  const result = { ...audit, packedRoot, originalManifest: resolve(manifestPath),
    currentWorktreeCompared: false, validation: 'all package files match the prior source-audited artifact' };
  await writeFile(resolve(runDir, 'frozen-artifact-audit.json'), JSON.stringify(result, null, 2));
  return result;
}
