import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
const artifact = resolve(process.argv[2]);
const compatArtifact = process.argv.find(a => a.startsWith('--compat='))?.slice('--compat='.length);
const proof = process.argv.find(a => a.startsWith('--audit='))?.slice('--audit='.length);
const artifactAudit = proof ? JSON.parse(await readFile(proof, 'utf8')) : undefined;
process.env.DSH_BOT_DSH_BIN = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const dir = await scratch('group-export-rc3'); console.log(dir);
await writeFile(resolve('.dsh-dev/group-export-repair/host-directory.txt'), dir);
let host;
try {
  host = await webHost(dir, 'group-export', artifact, resolve('packages/dsh-bot/tests/group-export-profile.mjs'), [], { offline: false, compatArtifact, artifactAudit });
  const report = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')); assert.equal(report.status, 'PASS');
  console.log('HOST_PASS', report.checks);
  if (process.argv.includes('--browser')) {
    const { verifyGroupExportBrowser } = await import('./group-export-browser.mjs');
    await verifyGroupExportBrowser(host, dir, report, { botMode: Boolean(compatArtifact) });
  }
  await host.stop(); host = undefined;
  const verifiedArtifact = artifactAudit ?? JSON.parse(await readFile(join(dir, 'artifact-manifest.json'), 'utf8'));
  host = await webHost(dir, 'group-export', artifact, resolve('packages/dsh-bot/tests/group-export-profile.mjs'), [], { preserveProfile: true, artifactAudit: verifiedArtifact });
  assert.equal(JSON.parse(await readFile(join(dir, 'cold-result.json'), 'utf8')).status, 'PASS');
  console.log('COLD_PASS no model replay');
} finally { await host?.stop(); }
