import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { awaitSubmissionBarrier, faultPoints } from './proactive/fault-points.mjs';
import { frozenArtifactAudit } from './proactive/artifact-audit.mjs';

assert.ok(process.argv[2], 'Pass the exact built plugin tarball');
const artifact = resolve(process.argv[2]);
assert.ok(process.argv.length <= 4);
const selected = process.argv[3] ? process.argv[3].split(',') : Object.keys(faultPoints);
const budget = process.env.DSH_BOT_FAULT_RESPONSIBILITY === '1';
assert.ok(selected.length && selected.every(point => Object.hasOwn(faultPoints, point)));
assert.equal(execFileSync(resolve('scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.1-rc.2');
const dir = await scratch('faults');
const artifactAudit = process.env.DSH_BOT_ARTIFACT_AUDIT
  ? await frozenArtifactAudit(artifact, process.env.DSH_BOT_ARTIFACT_AUDIT, dir) : undefined;
const fixture = resolve('packages/dsh-bot/tests/proactive-fault-profile.mjs');
const flags = ['- id: dsh-bot', '  config:', '    proactiveEnabled: true', '    proactiveExecutionEnabled: true',
  '    proactiveProvider: dp-loopback', '    proactiveModel: fixture',
  `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`];
const results = { artifact, packageHash: createHash('sha256').update(await readFile(artifact)).digest('hex'),
  startedAt: new Date().toISOString(), currentWorktreeCompared: !artifactAudit, responsibilityBudget: budget,
  scope: 'real rc.2 Host with loopback model; no real tools or external writes', cases: [] };
const stop = new AbortController();
const interrupt = () => stop.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
let live;
async function waitJSON(folder, name, predicate = () => true) {
  const deadline = Date.now() + 30000;
  while (!stop.signal.aborted && Date.now() < deadline) {
    const error = await readFile(join(folder, 'fault-error.txt'), 'utf8').catch(() => '');
    assert.equal(error, '', 'Host fault fixture failed');
    const value = await readFile(join(folder, name), 'utf8').then(JSON.parse).catch(() => undefined);
    if (value && predicate(value)) return value;
    await delay(25, undefined, { signal: stop.signal });
  }
  throw new Error(`Timed out reading ${name}`);
}
async function start(folder, point, phase, nonce) {
  return webHost(folder, `proactive-fault-${point}-${phase}-${nonce}${budget ? '-budget' : ''}`, artifact, fixture, flags, { offline: false, artifactAudit });
}
try {
  for (const point of selected) {
    if (stop.signal.aborted) break;
    const record = { point, status: 'FAIL', startedAt: new Date().toISOString() };
    try {
      const control = join(dir, `${point}-control`), injected = join(dir, `${point}-injected`);
      await mkdir(control, { mode: 0o700 }); await mkdir(injected, { mode: 0o700 });
      const controlNonce = randomBytes(16).toString('hex');
      live = await start(control, point, 'control', controlNonce);
      const ready = await waitJSON(control, 'workflow-ready.json');
      record.controlBarrier = await awaitSubmissionBarrier({ dir: control, point, nonce: controlNonce, hostPid: ready.pid });
      await writeFile(join(control, 'fault-release'), controlNonce, { flag: 'wx', mode: 0o600 });
      record.control = await waitJSON(control, 'fault-control-result.json');
      assert.equal(record.control.work.state, 'delivered');
      assert.equal(live.requests(), 1, 'Control must execute exactly one loopback model request');
      await live.stop(); live = undefined;

      const nonce = randomBytes(16).toString('hex');
      live = await start(injected, point, 'inject', nonce);
      const before = await waitJSON(injected, 'workflow-ready.json');
      record.barrier = await awaitSubmissionBarrier({ dir: injected, point, nonce, hostPid: before.pid });
      record.beforeRequests = live.requests();
      await live.crash();
      record.kill = { pid: before.pid, signal: 'SIGKILL' };
      await live.stop(); live = undefined;
      live = await start(injected, point, 'recover', nonce);
      const after = await waitJSON(injected, 'workflow-ready.json', value => value.pid !== before.pid);
      record.recovered = await waitJSON(injected, 'fault-recover-result.json', value => value.pid === after.pid);
      record.afterRequests = live.requests();
      assert.notEqual(after.pid, before.pid);
      assert.equal(record.recovered.work.assignmentId, record.barrier.work.assignmentId);
      assert.equal(record.recovered.work.ticketId, record.barrier.work.ticketId);
      const expected = point === 'F08' || point.startsWith('F13') ? 'delivered' : 'unknown';
      record.expectedState = expected;
      assert.equal(record.recovered.work.state, expected,
        point === 'F13A' ? 'Host result must survive before core acknowledgement, without another model call' : 'Cold recovery violated the durable phase');
      assert.equal(record.afterRequests, point === 'F08' ? 1 : 0, 'Cold recovery duplicated an already issued request');
      assert.equal(record.beforeRequests + record.afterRequests, point === 'F09' || point === 'F10' ? 0 : 1);
      if (budget) {
        const beforeUsage = record.barrier.responsibility?.usage, coldUsage = record.recovered.responsibility?.usage;
        assert.ok(beforeUsage && coldUsage, 'Budget binding must survive the exact assignment');
        assert.equal(coldUsage.requestsUsed, 1);
        assert.equal(coldUsage.activeTasks, 0);
        assert.ok(coldUsage.tokensAvailable <= beforeUsage.tokensAvailable, 'Cold recovery must not refund uncertain usage');
        if (point === 'F13A') assert.equal(coldUsage.unknownTokens, 32768);
        if (point === 'F13B') assert.equal(coldUsage.knownTokens, 60);
        if (point.startsWith('F13')) assert.deepEqual(record.recovered.work.usage,
          { inputTokens: 50, outputTokens: 10 }, 'Original synthetic report usage must survive journal replay');
      }
      record.status = 'PASS';
    } catch (error) {
      record.error = String(error.stack ?? error);
    } finally {
      if (live) { await live.stop(); live = undefined; }
      record.finishedAt = new Date().toISOString(); results.cases.push(record);
      await writeFile(join(dir, 'result.json'), JSON.stringify(results, null, 2));
      console.log(`${record.status} ${point}`);
    }
  }
} finally {
  if (live) await live.stop();
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
  results.finishedAt = new Date().toISOString();
  results.status = results.cases.length === selected.length && results.cases.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
  await writeFile(join(dir, 'result.json'), JSON.stringify(results, null, 2));
  console.log(`Fault receipts: ${dir}`);
  if (results.status !== 'PASS') process.exitCode = 1;
}
