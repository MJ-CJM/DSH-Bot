import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webHost } from './deepening/b4-web-host.mjs';
import { scratch } from './proactive/worker.mjs';
import { frozenArtifactAudit } from './proactive/artifact-audit.mjs';
import { awaitSubmissionBarrier } from './proactive/fault-points.mjs';

assert.equal(process.argv.length, 3, 'Pass the selected plugin tarball');
assert.equal(execFileSync(resolve('scripts/dsh'), ['--version'], { encoding: 'utf8' }).trim(), '0.2.1-rc.2');
const dir = await scratch('warm-recovery'), artifact = resolve(process.argv[2]);
const artifactAudit = process.env.DSH_BOT_ARTIFACT_AUDIT
  ? await frozenArtifactAudit(artifact, process.env.DSH_BOT_ARTIFACT_AUDIT, dir) : undefined;
const stop = new AbortController(), interrupt = () => stop.abort();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, interrupt);
function coordinator(hostPid, folder) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .flatMap(line => { const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return match ? [{ pid: Number(match[1]), parent: Number(match[2]), args: match[3] }] : []; });
  const byId = new Map(rows.map(row => [row.pid, row]));
  const selected = rows.filter(row => row.args.includes('/lib/proactive-coordinator/main.mjs ') && row.args.endsWith(join(folder, 'home/dsh-bot-proactive')));
  assert.equal(selected.length, 1, 'One exact isolated coordinator must be alive');
  const row = selected[0], ancestry = [row.pid]; let parent = row.parent;
  while (parent !== hostPid && parent > 1 && !ancestry.includes(parent)) {
    ancestry.push(parent); parent = byId.get(parent)?.parent ?? 0;
  }
  assert.equal(parent, hostPid, 'Refuse to kill a process outside this Host');
  ancestry.push(hostPid); return { pid: row.pid, ancestry };
}
async function waitJSON(folder, name) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    stop.signal.throwIfAborted();
    const error = await readFile(join(folder, 'warm-error.txt'), 'utf8').catch(() => ''); assert.equal(error, '');
    const value = await readFile(join(folder, name), 'utf8').then(JSON.parse).catch(() => undefined); if (value) return value;
    await delay(25, undefined, { signal: stop.signal });
  }
  throw new Error(`Missing warm recovery result: ${name}`);
}
const results = { artifact, currentWorktreeCompared: !artifactAudit, cases: [] };
for (const point of ['F09', 'F13A']) {
  if (stop.signal.aborted) break;
  const folder = join(dir, point); await mkdir(folder, { mode: 0o700 });
  const nonce = randomBytes(16).toString('hex'); let host;
  const record = { point, status: 'FAIL' };
  try {
    host = await webHost(folder, `proactive-warm-${point}-${nonce}`, artifact, resolve('packages/dsh-bot/tests/proactive-warm-profile.mjs'), [
      '- id: dsh-bot', '  config:', '    proactiveEnabled: true', '    proactiveExecutionEnabled: true',
      '    proactiveProvider: dp-loopback', '    proactiveModel: fixture', '    proactiveMaintenanceIntervalMs: 250',
      '    proactiveRecoveryIntervalMs: 100', `    proactiveNodeExecutable: ${JSON.stringify(process.execPath)}`,
    ], { offline: false, artifactAudit });
    const ready = await waitJSON(folder, 'warm-ready.json');
    record.barrier = await awaitSubmissionBarrier({ dir: folder, nonce, point, hostPid: ready.pid });
    record.before = coordinator(ready.pid, folder);
    process.kill(record.before.pid, 'SIGKILL');
    await writeFile(join(folder, 'fault-release'), nonce, { flag: 'wx', mode: 0o600 });
    record.result = await waitJSON(folder, 'warm-result.json');
    assert.equal(record.result.pid, ready.pid); assert.equal(record.result.storeId, ready.storeId);
    assert.equal(record.result.recovered.assignmentId, record.barrier.work.assignmentId);
    record.after = coordinator(ready.pid, folder); assert.notEqual(record.after.pid, record.before.pid);
    assert.equal(host.requests(), point === 'F13A' ? 2 : 1);
    record.status = 'PASS';
  } catch (error) { record.error = String(error.stack ?? error); }
  finally {
    if (host) await host.stop(); results.cases.push(record);
    await writeFile(join(dir, 'result.json'), JSON.stringify(results, null, 2)); console.log(`${record.status} warm ${point}`);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, interrupt);
results.status = results.cases.length === 2 && results.cases.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
await writeFile(join(dir, 'result.json'), JSON.stringify(results, null, 2));
console.log(`Warm recovery receipts: ${dir}`);
if (results.status !== 'PASS') process.exitCode = 1;
