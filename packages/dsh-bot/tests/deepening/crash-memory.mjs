import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { memorySchema } from '../../lib/shared/schema.js';
import { privateVersion } from '../../lib/host/memory/version.js';
import { rebuild, applyOp } from '../../lib/host/memory/projection.js';
import { migratePrivate, assertCompatibleRecovery, FENCE_KEY } from '../../lib/host/memory/migration.js';
import { AutoShareQuota } from '../../lib/host/memory/quota.js';
import { accounting, alpha } from './property-runtime.mjs';
import { checkpoint, afterPut } from './crash-checkpoint.mjs';

export const memoryWindows = ['payload', 'op-projection', 'forget-barrier', 'migration-cutover', 'forget-rollback'];
export async function crashMemory({ kernel, legacy }, config) {
  const file = resolve(config.outputDir, 'identity.json'), crash = config.phase === 'crash';
  const save = value => writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx' });
  const pause = detail => checkpoint(config, { level: config.level, ...detail });
  if (config.window === 'harness') {
    if (crash) { await save({ pid: process.pid }); await pause({ phase: 'public-runtime-ready' }); }
    const first = JSON.parse(await readFile(file)); assert.notEqual(first.pid, process.pid);
    return { parentKillProtocol: true, differentPid: true };
  }
  if (crash) {
    const record = memorySchema.parse({ id: randomUUID(), botId: 'alpha', content: 'B7_CRASH_CANARY',
      kind: 'note', tags: [], pinned: false, createdAt: 10, updatedAt: 10 });
    if (config.window === 'migration-cutover') {
      await legacy.table('memories').put(record.id, record);
      afterPut(kernel.domain.table('migration'), (_key, value) => value.phase === 'cutover',
        (_key, value) => pause({ phase: 'fence-and-cutover-durable', cutoverSeq: value.cutoverSeq }));
      await save({ memoryId: record.id }); await migratePrivate(legacy, kernel);
      throw new Error('Cutover barrier not reached');
    }
    const { version, payload } = privateVersion(kernel, record, alpha);
    const input = { opId: randomUUID(), kind: 'propose', subjectIds: [version.memoryId], expectedRevision: kernel.seq,
      forgetEpoch: kernel.epoch, versions: [version], payloads: { [version.contentRef]: payload } };
    if (config.window === 'payload') {
      await save({ input, memoryId: version.memoryId });
      afterPut(kernel.domain.table('payloads'), key => key === version.contentRef,
        () => pause({ phase: 'payload-durable-before-op', opId: input.opId }));
      await kernel.commit(input);
    } else if (config.window === 'op-projection') {
      const quota = new AutoShareQuota(kernel, () => Date.UTC(2026, 9, 27));
      await quota.configure({ enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'UTC' });
      const charged = accounting({ kernel }, alpha);
      await save({ input: charged, memoryId: charged.subjectIds[0] });
      afterPut(kernel.domain.table('ops'), key => key === charged.opId,
        () => pause({ phase: 'op-durable-before-published-projection', liveSeq: kernel.seq, opId: charged.opId }));
      await quota.commit(charged.opId, alpha, kernel.policyRevision, () => charged);
    } else {
      await kernel.commit(input); const forgetId = randomUUID();
      await save({ input, memoryId: version.memoryId, forgetId });
      if (config.window === 'forget-barrier') afterPut(kernel.domain.table('barriers'), key => key === forgetId,
        () => pause({ phase: 'forget-op-and-barrier-durable-before-erasure', epoch: kernel.epoch }));
      await kernel.commit({ opId: forgetId, kind: 'forget', subjectIds: [version.memoryId],
        expectedRevision: kernel.seq, forgetEpoch: kernel.epoch + 1 });
      if (config.window === 'forget-rollback') await pause({ phase: 'tombstone-and-payload-erasure-durable', epoch: kernel.epoch });
    }
    throw new Error('Requested physical crash barrier not reached');
  }
  const identity = JSON.parse(await readFile(file));
  assert.deepEqual(rebuild(kernel.domain), kernel.snapshot);
  if (config.window === 'payload') {
    assert.equal(kernel.domain.table('ops').has?.(identity.input.opId) ?? !!kernel.domain.table('ops').get(identity.input.opId), false);
    assert.equal(kernel.snapshot.versions.size, 0); assert.equal(kernel.domain.table('payloads').size, 0);
    await kernel.commit(identity.input); assert.equal(kernel.snapshot.versions.size, 1);
  } else if (config.window === 'op-projection') {
    assert.equal(kernel.snapshot.quota.size, 1); assert.ok(kernel.snapshot.versions.has(identity.memoryId));
    const count = kernel.seq, quota = new AutoShareQuota(kernel);
    await quota.commit(identity.input.opId, alpha, kernel.policyRevision, () => identity.input);
    assert.equal(kernel.snapshot.quota.size, 1); assert.equal(kernel.seq, count);
  } else if (config.window === 'migration-cutover') {
    await migratePrivate(legacy, kernel);
    assert.equal(kernel.domain.table('migration').get('active').phase, 'done');
    assert.equal(legacy.table('memories').size, 1); assert.ok(legacy.table('memories').get(FENCE_KEY));
    assert.equal(kernel.snapshot.versions.size, 1);
    const seq = kernel.seq; await migratePrivate(legacy, kernel); assert.equal(kernel.seq, seq);
  } else {
    assert.equal(kernel.snapshot.forgotten.has(identity.memoryId), true);
    assert.equal(kernel.snapshot.versions.has(identity.memoryId), false);
    assert.equal(kernel.domain.table('payloads').size, 0); assert.equal(kernel.blocked, true);
    assert.throws(() => assertCompatibleRecovery(kernel, { fence: false, tombstone: false, epoch: false }));
    assertCompatibleRecovery(kernel, { fence: true, tombstone: true, epoch: true });
    const attempted = { ...identity.input, opId: randomUUID(), expectedRevision: kernel.seq, forgetEpoch: kernel.epoch,
      versions: identity.input.versions.map(v => ({ ...v, commitSeq: kernel.seq + 1 })) };
    await assert.rejects(kernel.commit(attempted));
    assert.throws(() => applyOp(kernel.snapshot, { ...attempted, seq: kernel.seq + 1,
      payloadRefs: Object.keys(attempted.payloads), receiptRefs: [] }), /resurrection/);
  }
  return { replayEquivalent: true, seq: kernel.seq, epoch: kernel.epoch, quota: kernel.snapshot.quota.size,
    blocked: kernel.blocked, versions: kernel.snapshot.versions.size, payloads: kernel.domain.table('payloads').size };
}
