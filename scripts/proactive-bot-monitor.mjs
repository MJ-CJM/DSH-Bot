import assert from 'node:assert/strict';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base = await realpath(resolve('.dsh-dev/proactive-bot'));
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
const dir = await realpath(resolve(process.argv[2] ?? ''));
assert.ok(dir.startsWith(base + sep) && process.argv.length === 3);
const initial = JSON.parse(await readFile(join(dir, 'running.json'), 'utf8'));
assert.equal(initial.mode, '72h');
assert.equal(initial.durationMs, 72 * 60 * 60 * 1000);
assert.ok(/^[a-f0-9]{64}$/.test(initial.entryHash));
for (const pid of [initial.pid, initial.workerPid]) assert.ok(Number.isSafeInteger(pid) && pid > 1);
const started = Date.parse(initial.startedAt);
const due = new Date(started + initial.durationMs).toISOString();
const report = join(dir, 'monitor.json');
async function readOptional(file) {
  return readFile(join(dir, file), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function record(status, counts, result) {
  const temp = join(dir, `monitor-${process.pid}.tmp`);
  const now = new Date().toISOString();
  await writeFile(temp, JSON.stringify({ status, ...initial, due, checkedAt: now, ...counts, result }, null, 2));
  await rename(temp, report);
  if (status !== 'RUNNING') console.log(`${status} ${report}`);
}

for (;;) {
  const raw = await readOptional('samples.ndjson');
  // The last write can be in progress. The writer appends newline-terminated samples.
  const samples = raw.split('\n').slice(0, -1).map(line => JSON.parse(line));
  const latest = samples.at(-1);
  const maxGapMs = samples.reduce((max, sample) => Math.max(max, sample.gap), 0);
  const counts = { samples: samples.length, lastElapsedMs: latest?.elapsedMs, maxGapMs };
  const finalText = await readOptional('result.json');
  let final;
  if (finalText) {
    try { final = JSON.parse(finalText); } catch { /* writer may still be flushing */ }
  }
  const ordered = samples.every((sample, index) =>
    sample.committedSeq === index + 1 && Number.isFinite(sample.elapsedMs) &&
    sample.elapsedMs >= (samples[index - 1]?.elapsedMs ?? 0) && Number.isFinite(sample.gap) && sample.gap >= 0);
  if (final) {
    const passed = ordered && final.status === 'PASS' && final.entryHash === initial.entryHash &&
      final.startedAt === initial.startedAt && final.elapsedMs >= initial.durationMs && Date.now() >= Date.parse(due) &&
      final.samples === samples.length && !final.aborted && maxGapMs <= 180000;
    await record(passed ? 'PASS' : 'FAIL', counts, final);
    if (!passed) process.exitCode = 1;
    break;
  }
  if (!alive(initial.pid)) {
    // The writer has exited and no final receipt exists.
    await record('FAIL_NO_RECEIPT', counts);
    process.exitCode = 1;
    break;
  }
  await record('RUNNING', counts, {
    workerAlive: alive(initial.workerPid), observedGapWithinLimit: ordered && maxGapMs <= 180000,
  });
  await delay(60000);
}
