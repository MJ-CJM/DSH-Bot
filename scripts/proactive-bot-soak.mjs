import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { launch, scratch } from './proactive/worker.mjs';

const dir = await scratch('soak');
assert.ok(process.argv[2], 'Pass an extracted or built coordinator main.mjs');
assert.ok(process.argv.length === 3 || process.argv[3] === '--smoke');
const smoke = process.argv[3] === '--smoke';
const durationMs = smoke ? 3000 : 72 * 60 * 60 * 1000;
const interval = smoke ? 400 : 60000;
const entry = resolve(process.argv[2]);
const entryHash = createHash('sha256').update(await readFile(entry)).digest('hex');
const start = performance.now();
const startedAt = new Date().toISOString();
const signal = new AbortController();
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => signal.abort());
const state = join(dir, 'store');
await mkdir(state, { mode: 0o700 });
const worker = launch(entry, state);
const installationId = randomUUID();
let samples = 0;
let maxGapMs = 0;
let peakRssKiB = 0;
let previous = performance.now();
const timings = [];
let status = 'FAIL';
try {
  const hello = await worker.send({ kind: 'hello', installationId, expectedStoreId: null });
  assert.equal(hello.kind, 'hello');
  await writeFile(join(dir, 'running.json'), JSON.stringify({
    mode: smoke ? 'smoke' : '72h', startedAt, durationMs, entryHash, pid: process.pid, workerPid: worker.pid,
  }, null, 2));
  console.log(`RUNNING ${smoke ? 'smoke' : '72h'} ${dir}`);
  const { storeId } = hello;
  do {
    const checkpoint = String(samples + 1);
    const event = {
      nativeId: checkpoint, nativeRevision: '1', occurredAt: new Date().toISOString(),
      summary: 'Synthetic coordinator soak observation', threadId: checkpoint,
    };
    const body = { events: [event], expectedCheckpoint: samples ? String(samples) : null,
      generation: 1, kind: 'ingest-batch', nextCheckpoint: checkpoint, sourceId: 'soak-fixture' };
    const command = { commandId: randomUUID(), actorRef: 'local-host', storeId, body,
      payloadDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
    const at = performance.now();
    const first = await worker.send({ kind: 'command', command });
    assert.equal(first.receipt.status, 'committed');
    assert.equal(first.receipt.stored, 1);
    const duplicate = await worker.send({ kind: 'command', command });
    assert.equal(duplicate.receipt.receiptId, first.receipt.receiptId);
    assert.equal(duplicate.receipt.status, 'duplicate');
    const checkpointReply = await worker.send({ kind: 'checkpoint', storeId, sourceId: body.sourceId });
    assert.equal(checkpointReply.source.checkpoint, checkpoint);
    const read = await worker.send({ kind: 'snapshot', storeId });
    assert.equal(read.snapshot.committedSeq, ++samples);
    assert.equal(read.snapshot.ticketCount, 0);
    assert.equal(read.snapshot.triggerCount, samples);
    const now = performance.now();
    const gap = now - previous;
    maxGapMs = Math.max(maxGapMs, gap);
    previous = now;
    const roundTripMs = now - at;
    timings.push(roundTripMs);
    const [rssKiB, cpuPercent] = execFileSync('ps', ['-p', String(worker.pid), '-o', 'rss=,pcpu='],
      { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
    assert.ok(Number.isFinite(rssKiB) && rssKiB > 0);
    peakRssKiB = Math.max(peakRssKiB, rssKiB);
    await appendFile(join(dir, 'samples.ndjson'), JSON.stringify({
      elapsedMs: now - start, roundTripMs, committedSeq: samples, rssKiB, cpuPercent, gap,
    }) + '\n');
    if (!signal.signal.aborted && performance.now() - start < durationMs)
      await delay(interval, undefined, { signal: signal.signal }).catch(error => { if (!signal.signal.aborted) throw error; });
  } while (!signal.signal.aborted && performance.now() - start < durationMs);
  if (!signal.signal.aborted && maxGapMs <= interval * 3 && samples >= Math.floor(durationMs / (interval * 1.05)))
    status = smoke ? 'PASS(SMOKE)' : 'PASS';
} finally {
  await worker.stop();
  timings.sort((a, b) => a - b);
  const percentile = q => timings.length ? timings[Math.ceil(q * timings.length) - 1] : null;
  await writeFile(join(dir, 'result.json'), JSON.stringify({
    status, startedAt, elapsedMs: performance.now() - start, samples, entryHash, aborted: signal.signal.aborted, peakRssKiB, maxGapMs,
    p50Ms: percentile(0.50), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
  }, null, 2));
  console.log(`${status} ${dir}`);
}

if (!status.startsWith('PASS')) process.exitCode = 1;
