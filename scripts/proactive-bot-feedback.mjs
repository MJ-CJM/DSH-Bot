import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, scratch } from './proactive/worker.mjs';

const [entry, job] = process.argv.slice(2);
assert.ok(entry && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(job ?? ''), 'Pass a coordinator main.mjs and a single candidate job exclusion');
const dir = await scratch('feedback');
const source = new URL('../packages/dsh-bot/tests/fixtures/proactive/feedback-heldout-v1.json', import.meta.url);
const bytes = await readFile(source);
const hash = data => createHash('sha256').update(data).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
assert.equal(hash(bytes), 'faf0d0a1fd33a16147d982ed6e056d65fd3f04796cdf335c69712da4fb8a4592', 'Held-out v1 changed');
const fixture = JSON.parse(bytes);
const state = join(dir, 'store');
await mkdir(state, { mode: 0o700 });
const worker = launch(resolve(entry), state);
const sourceId = 'ci:synthetic-heldout';
const report = [];
const measure = (rows, predict) => {
  const tp = rows.filter(row => row.needsSuggestion && predict(row)).length;
  const fp = rows.filter(row => !row.needsSuggestion && predict(row)).length;
  const fn = rows.filter(row => row.needsSuggestion && !predict(row)).length;
  return { tp, fp, fn, recall: tp + fn ? tp / (tp + fn) : null };
};
try {
  const boot = await worker.send({ kind: 'hello', installationId: randomUUID(), expectedStoreId: null });
  assert.equal(boot.kind, 'hello');
  const { storeId } = boot;
  for (const [batch, rows] of fixture.batches.entries()) {
    const events = rows.map((row, i) => {
      const nativeId = `ci-${batch}-${i}`;
      return { ci: { attempt: 1, conclusion: row.conclusion }, nativeId, nativeRevision: '1',
        occurredAt: new Date().toISOString(), summary: nativeId, threadId: nativeId };
    });
    const body = { events, expectedCheckpoint: batch ? String(batch) : null, generation: 1,
      kind: 'ingest-batch', nextCheckpoint: String(batch + 1), sourceId };
    const receipt = await worker.send({ kind: 'command', command: {
      actorRef: 'local-host', body, commandId: randomUUID(), payloadDigest: hash(JSON.stringify(canonical(body))), storeId,
    } });
    assert.equal(receipt.kind, 'receipt');
    const suggestions = await worker.send({ kind: 'suggestions', storeId });
    assert.equal(suggestions.kind, 'suggestions');
    const seen = new Set(suggestions.suggestions.map(row => row.title));
    const facts = rows.map((row, i) => ({ ...row, suggested: seen.has(events[i].nativeId) }));
    const baseline = measure(facts, row => row.suggested);
    const candidate = measure(facts, row => row.suggested && row.job !== job);
    report.push({ batch: batch + 1, baseline, candidate, suppressed: facts.filter(row => row.suggested && row.job === job) });
  }
  assert.equal((await worker.send({ kind: 'snapshot', storeId })).snapshot.ticketCount, 0);
  const reducesFalsePositives = report.some(row => row.candidate.fp < row.baseline.fp);
  const preservesRecall = report.every(row => row.candidate.fn <= row.baseline.fn);
  const result = { fixtureSha256: hash(bytes), version: fixture.version, job, report, reducesFalsePositives,
    preservesRecall, permissionChanges: 0, decision: 'not-adopted', evidence: 'synthetic-only' };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Evaluated held-out candidate without applying it: ${dir}`);
} finally { await worker.stop(); }
