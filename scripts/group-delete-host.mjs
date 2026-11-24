import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { auditArtifact } from './p34-artifact.mjs';

assert.ok(process.argv[2], 'Usage: node scripts/group-delete-host.mjs <candidate.tgz>');
const file = resolve(process.argv[2]), dir = await scratch('group-delete-host');
console.log(dir);
const audit = await auditArtifact(process.cwd(), file, dir);
const runs = [];
for (const cold of [false, true]) {
  const host = await webHost(dir, 'group-delete', file, resolve('packages/dsh-bot/tests/group-delete-profile.mjs'), [], { preserveProfile: cold, artifactAudit: audit });
  try {
    const result = JSON.parse(await readFile(resolve(dir, cold ? 'cold-result.json' : 'result.json'), 'utf8'));
    assert.equal(result.status, 'PASS');
    assert.equal(host.requests(), 0);
    runs.push(result);
  } finally { await host.stop(); }
}
await writeFile(resolve(dir, 'verified.json'), JSON.stringify({sha256:audit.sha256, runs}, null, 2));
console.log('GROUP_DELETE_HOST_PASS', JSON.stringify(runs));
