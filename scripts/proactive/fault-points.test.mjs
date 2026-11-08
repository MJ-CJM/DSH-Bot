import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { installSubmissionFault, awaitSubmissionBarrier } from './fault-points.mjs';

async function scratch() {
  const base = resolve('.dsh-dev/proactive-bot'); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'fault-unit-'));
}
test('submission barrier verifies the committed original call, exact nonce and actual PID', async () => {
  const dir = await scratch(), nonce = randomBytes(16).toString('hex');
  const receipt = { kind: 'receipt', receipt: { status: 'committed', receiptId: randomUUID(), committedSeq: 1 } };
  let called = 0;
  const original = async () => { called++; return receipt; };
  const service = { submit: original, workList: async () => [{ decisionId: 'decision', ticketId: 'ticket', assignmentId: 'assignment', state: 'pending', revision: 0 }] };
  const release = await installSubmissionFault({ service, dir, nonce, point: 'F08', emit() {} });
  const request = service.submit(randomUUID(), { kind: 'accept-decision', decisionId: 'decision' });
  try {
    const barrier = await awaitSubmissionBarrier({ dir, nonce, point: 'F08', hostPid: process.pid });
    assert.equal(called, 1); assert.equal(barrier.committed, true);
    assert.equal(barrier.receiptId, receipt.receipt.receiptId);
    await assert.rejects(awaitSubmissionBarrier({ dir, nonce: '0'.repeat(32), point: 'F08', hostPid: process.pid }));
    await writeFile(join(dir, 'fault-release'), nonce);
    assert.equal(await request, receipt);
  } finally { release(); await request.catch(() => {}); assert.equal(service.submit, original); await rm(dir, { recursive: true, force: true }); }
});

test('F13A waits for durable journal staging and does not substitute a pre-stage boundary', async () => {
  const dir = await scratch(), nonce = randomBytes(16).toString('hex');
  let staged = false;
  const original = async () => { staged = true; };
  const service = { stageResult: original, workList: async () => [{ decisionId: 'decision', ticketId: 'ticket', assignmentId: 'assignment', state: 'sent', revision: 2 }] };
  const release = await installSubmissionFault({ service, dir, nonce, point: 'F13A', emit() {} });
  const request = service.stageResult(randomUUID(), { kind: 'report-result', assignmentId: 'assignment', result: { state: 'delivered' } });
  try {
    const barrier = await awaitSubmissionBarrier({ dir, nonce, point: 'F13A', hostPid: process.pid });
    assert.equal(staged, true); assert.equal(barrier.committed, false); assert.equal(barrier.durableHostResult, true);
    await writeFile(join(dir, 'fault-release'), nonce); await request;
  } finally { release(); await request.catch(() => {}); assert.equal(service.stageResult, original); await rm(dir, { recursive: true, force: true }); }
});

test('disposal cancels a suspended barrier and restores the original plugin method', async () => {
  const dir = await scratch(), nonce = randomBytes(16).toString('hex');
  const original = async () => ({ kind: 'receipt', receipt: { status: 'committed', receiptId: randomUUID(), committedSeq: 1 } });
  const service = { submit: original, workList: async () => [{ decisionId: 'decision', ticketId: 'ticket', assignmentId: 'assignment', state: 'claimed', revision: 1 }] };
  const release = await installSubmissionFault({ service, dir, nonce, point: 'F09', emit() {} });
  const request = service.submit(randomUUID(), { kind: 'dispatch-claim', assignmentId: 'assignment' });
  try {
    await awaitSubmissionBarrier({ dir, nonce, point: 'F09', hostPid: process.pid });
    release(); await assert.rejects(request); assert.equal(service.submit, original);
  } finally { release(); await request.catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('F13B kills after core commit while the Host journal acknowledgement is still pending', async () => {
  const dir = await scratch(), nonce = randomBytes(16).toString('hex');
  let acknowledged = false;
  const original = async () => { acknowledged = true; };
  const receipt = { kind: 'receipt', receipt: { status: 'committed', receiptId: randomUUID(), committedSeq: 3 } };
  const service = { acknowledgeResult: original, workList: async () => [{ decisionId: 'decision', ticketId: 'ticket', assignmentId: 'assignment', state: 'delivered', revision: 3 }] };
  const release = await installSubmissionFault({ service, dir, nonce, point: 'F13B', emit() {} });
  const request = service.acknowledgeResult(randomUUID(), { kind: 'report-result', assignmentId: 'assignment', result: { state: 'delivered' } }, receipt);
  try {
    const barrier = await awaitSubmissionBarrier({ dir, nonce, point: 'F13B', hostPid: process.pid });
    assert.equal(acknowledged, false); assert.equal(barrier.committed, true);
    await writeFile(join(dir, 'fault-release'), nonce); await request;
    assert.equal(acknowledged, true);
  } finally { release(); await request.catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
