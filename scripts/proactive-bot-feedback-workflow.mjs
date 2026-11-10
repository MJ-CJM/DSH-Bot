import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { frozenArtifactAudit } from './proactive/artifact-audit.mjs';

assert.equal(process.argv.length, 3, 'Pass the exact plugin tarball');
assert.equal(execFileSync(resolve('scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.1-rc.2');
const artifact = resolve(process.argv[2]), dir = await scratch('general-feedback');
const artifactAudit = process.env.DSH_BOT_ARTIFACT_AUDIT
  ? await frozenArtifactAudit(artifact, process.env.DSH_BOT_ARTIFACT_AUDIT, dir) : undefined;
const stop = new AbortController(), interrupt = () => stop.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
let host;
try {
host = await webHost(dir, 'proactive-general-feedback', artifact,
  resolve('packages/dsh-bot/tests/proactive-feedback-workflow-profile.mjs'), [
    '- id: dsh-bot', '  config:', '    proactiveEnabled: true', '    proactiveExecutionEnabled: true',
    '    proactiveProvider: dp-loopback', '    proactiveModel: fixture',
    `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
  ], { offline: false, artifactAudit });
  const deadline = Date.now() + 50000;
  let result;
  while (!result) {
    stop.signal.throwIfAborted();
    const error = await readFile(join(dir, 'general-feedback-error.txt'), 'utf8').catch(() => '');
    assert.equal(error, '', 'General feedback Host fixture failed');
    result = await readFile(join(dir, 'general-feedback-result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (result) break;
    assert.ok(Date.now() < deadline, 'General feedback Host fixture timed out');
    await delay(50, undefined, { signal: stop.signal });
  }
  assert.equal(result.status, 'PASS'); assert.equal(host.requests(), 2, 'Only original and rework may call the loopback model');
  await writeFile(join(dir, 'result.json'), JSON.stringify({ ...result, modelRequests: host.requests(), artifact,
    currentWorktreeCompared: !artifactAudit }, null, 2));
  console.log(`PASS general feedback Host workflow: ${dir}`);
} finally {
  if (host) await host.stop();
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
}
