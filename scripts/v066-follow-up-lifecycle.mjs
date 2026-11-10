import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { auditArtifact, sha256 } from './p34-artifact.mjs';
import { scratch } from './proactive/worker.mjs';

assert.ok(process.argv[2], 'Pass the product candidate tgz');
const artifact = resolve(process.argv[2]);
const noModelRoute = process.argv[3] === '--no-model-route';
const nativeChild = process.argv[3] === '--native-child';
const fixture = resolve('packages/dsh-bot/tests', noModelRoute ? 'v066-follow-up-no-route-profile.mjs'
  : nativeChild ? 'v066-follow-up-native-child-profile.mjs' : 'v066-follow-up-lifecycle-profile.mjs');
const legacy = process.argv[3] === '--legacy-recovery';
const groupMembership = process.argv[3] === '--group-membership';
const groupWatchTool = process.argv[3] === '--group-watch-tool' || groupMembership;
const watchTool = process.argv[3] === '--watch-tool' || groupWatchTool;
const crash = ['--before-hello', '--before-receipt'].includes(process.argv[3]) ? process.argv[3].slice(2) : undefined;
const suite = noModelRoute ? 'v066-follow-up-no-model-route' : nativeChild ? 'v066-follow-up-native-child'
  : groupMembership ? 'v066-follow-up-group-membership' : groupWatchTool ? 'v066-follow-up-group-watch-tool' :
  watchTool ? 'v066-follow-up-watch-tool' : legacy ? 'v066-follow-up-legacy' :
  crash ? 'v066-follow-up-crash' : 'v066-follow-up-lifecycle';
const dir = await scratch(suite);
let executable = process.execPath;
if (crash) {
  executable = join(dir, 'gated-node');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const args = [process.execPath, resolve('packages/dsh-bot/tests/v066-bootstrap-gate.mjs'), crash, dir];
  await writeFile(executable, `#!/bin/sh\nexec ${args.map(shellQuote).join(' ')} "$@"\n`);
  await chmod(executable, 0o700);
}
const flags = ['- id: dsh-bot', '  config:', `    proactiveEnabled: ${legacy}`,
  `    proactiveExecutionEnabled: ${legacy}`, `    proactiveNodeExecutable: ${JSON.stringify(executable)}`,
  ...(watchTool || noModelRoute || nativeChild ? ['    proactiveMaintenanceIntervalMs: 250'] : []),
  ...(legacy ? ['    proactiveProvider: dp-loopback', '    proactiveModel: fixture',
    '    proactiveNotificationPolicy: v066-old-notice', '    proactiveMaintenanceIntervalMs: 20000',
    '    proactiveNoticeConfig: {mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000}'] : [])];
console.log(dir);
// The acceptance probes reuse the archived byte audit while the checkout can rebuild independently.
const useArchivedAudit = groupMembership || noModelRoute || nativeChild;
const artifactAudit = useArchivedAudit
  ? JSON.parse(await readFile(join(dirname(artifact), 'audit', 'artifact-manifest.json'), 'utf8'))
  : await auditArtifact(process.cwd(), artifact, dir);
if (useArchivedAudit) {
  const file = relative(process.cwd(), artifact);
  assert.ok(file && !file.startsWith('..'));
  assert.equal(artifactAudit.artifact, file);
  assert.equal(artifactAudit.sha256, sha256(await readFile(artifact)));
}
const receipt = name => readFile(join(dir, name), 'utf8').then(JSON.parse);
async function crashAtGate(host) {
  const intent = await receipt('product-crash-intent.json');
  await writeFile(join(dir, 'begin-crash-enable'), 'begin');
  let held;
  for (let i = 0; i < 200 && !held; i++) {
    held = await receipt('worker-held.json').catch(() => undefined);
    if (!held) await delay(30);
  }
  assert.equal(held?.phase, crash, 'The requested native recovery boundary was not reached');
  const profile = await readFile(join(host.env.DSH_HOME, 'profiles', 'b4-browser', 'cordis.patch.yml'), 'utf8');
  assert.ok(profile.includes(intent.first.commandId));
  assert.match(profile, /proactiveEnabled: true/);
  await host.crash();
  for (const pid of [held.worker, held.proxy]) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await writeFile(join(dir, 'release-worker'), 'resume');
  return intent;
}
let host;
if (noModelRoute) {
  try {
    host = await webHost(dir, suite, artifact, fixture, flags, { artifactAudit, mockModel: false });
    const report = await receipt('product-no-model-route.json');
    assert.equal(report.members, 4);
    assert.equal(report.personal.localEnabled, true);
    assert.equal(report.group.localEnabled, true);
    for (const counter of ['providers', 'agentRequests', 'modelStreams', 'nativeDispatches', 'externalSends']) assert.equal(report[counter], 0);
    console.log('PASS exact personal and four-member group activation without a model route or credentials');
  } finally { await host?.stop(); }
} else if (nativeChild) {
  try {
    host = await webHost(dir, suite, artifact, fixture, flags, { artifactAudit });
    const warm = await receipt('product-native-child-warm.json');
    await host.stop();
    host = undefined;
    host = await webHost(dir, suite, artifact, fixture, flags, { preserveProfile: true, artifactAudit });
    const cold = await receipt('product-native-child-cold.json');
    assert.equal(cold.sessionId, warm.sessionId);
    assert.equal(warm.explicitModelRequests, 3);
    assert.equal(warm.additionalModelRequests + cold.modelRequests + cold.duplicateCards, 0);
    assert.equal(cold.cards, 3);
    console.log('PASS native child failure, completion, cancellation, and cold reconciliation without extra model requests');
  } finally { await host?.stop(); }
} else try {
  host = await webHost(dir, suite, artifact, fixture, flags, { artifactAudit });
  const warm = crash ? await crashAtGate(host) : await receipt(watchTool ? 'product-watch-warm.json' : 'product-warm.json');
  if (!crash && !watchTool) {
    assert.equal(warm.guards.requests, 5);
    assert.equal(warm.configurationModelRequests, 0);
  }
  await host.stop();
  host = undefined;
  host = await webHost(dir, suite, artifact, fixture, flags, { preserveProfile: true, artifactAudit });
  const cold = await receipt(crash ? 'product-crash-cold.json' : watchTool ? 'product-watch-cold.json' : 'product-cold.json');
  assert.equal(cold.sessionId, warm.sessionId);
  if (groupWatchTool) {
    assert.equal(cold.confirmationReceipt.stored, 1);
    assert.equal(cold.groupCard, warm.card.id);
    assert.equal(warm.additionalModelRequests + cold.additionalModelRequests, 0);
    console.log('PASS native group watch draft, cold original source proof, and one owner confirmation');
    if (groupMembership) {
      const result = await receipt('product-membership.json');
      assert.equal(result.card, warm.card.id);
      assert.equal(result.rejectedModelRequests, 0);
      assert.equal(result.acceptedModelRequests, 1);
      assert.equal(result.activePersonalScopesWithoutCards, 3);
      assert.equal(result.privateInputReachedOnlyMain, true);
      console.log('PASS native member departure and rejoin, stale choice fence, fresh exact choice, and private input isolation');
    }
  } else if (watchTool) {
    assert.equal(cold.recoveredApprovals, 4);
    assert.equal(cold.forgotCard, warm.card.id);
    assert.equal(cold.nativeHistoryRetained, true);
    assert.equal(warm.additionalModelRequests + cold.additionalModelRequests, 0);
    console.log('PASS native Bot conversation watch rejection, creation, update, completion, and cold owner forget');
  } else {
    assert.equal(cold.guards.requests, 5);
    if (legacy) assert.deepEqual(cold.legacy, warm.legacy);
    if (crash) assert.equal(cold.staleReplayRejected, true);
    console.log(`PASS exact Subject bootstrap, stale global-off replay, and retained Agent lifecycle${crash ? ` (${crash})` : ''}`);
  }
} finally {
  await host?.stop();
}
