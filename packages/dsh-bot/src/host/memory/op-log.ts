import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { metaSchema, opSchema, type MemoryOp } from '../../shared/memory-ops.js';
import { payloadSchema, type MemoryPayload, type MemoryVersion } from '../../shared/memory-v2.js';
import type { MemoryDomain } from './domain-v2.js';
import { applyOp, emptyProjection, rebuild, persistProjection, type Projection } from './projection.js';

export type Commit = Omit<MemoryOp, 'seq' | 'versions' | 'payloadRefs' | 'receiptRefs'> & {
  versions?: MemoryVersion[]; payloads?: Record<string, MemoryPayload>;
};
/** One queue for durable memory admission, commits and barriers. Not a cross-process lock. */
export class MemoryKernel {
  private tail: Promise<unknown> = Promise.resolve();
  private state: Projection = emptyProjection();
  frozen = true;
  stopped = false;
  cacheFailures = 0;
  readonly listeners = new Set<() => void>();
  constructor(readonly domain: MemoryDomain, private readonly assertOwner: () => void) {}

  async recover(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<void> {
    await this.serial(async () => {
      this.assertOwner();
      if (!this.domain.table('meta').get('scope')) {
        if (this.domain.table('ops').size || this.domain.table('migration').size) throw new Error('Missing durable memory UserScope');
        await this.domain.table('meta').put('scope', metaSchema.parse({
          scope: { id: randomUUID(), createdAt: Date.now() }, policyRevision: 1, quotaTimeZone: timeZone,
        }));
      }
      this.state = rebuild(this.domain);
      // Forget intent is authority even when the barrier cache write was interrupted.
      for (const [, op] of this.domain.table('ops').entries()) if (op.kind === 'forget' && !this.domain.table('barriers').get(op.opId)) {
        await this.domain.table('barriers').put(op.opId, { id: op.opId, epoch: op.forgetEpoch, targets: op.subjectIds,
          affectedSessionIds: [], state: 'blocked', scope: 'private', previewRevision: op.seq - 1, receipts: [] });
      }
      await persistProjection(this.domain, this.state);
      this.frozen = false;
    });
  }
  get snapshot(): Projection { this.assertReadable(); return this.state; }
  get scope() {
    const meta = this.domain.table('meta').get('scope');
    if (!meta) throw new Error('Memory scope is not ready'); return meta;
  }
  get epoch(): number { return this.state.epoch; }
  get seq(): number { return this.state.seq; }
  get blocked(): boolean {
    return this.frozen || this.stopped || [...this.domain.table('barriers').entries()].some(([, b]) => b.state !== 'verified');
  }
  assertReadable(): void {
    if (this.frozen || this.stopped) throw new Error('Memory unavailable: reconciliation required');
  }
  assertOwnership(): void { this.assertOwner(); }
  serial<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result;
  }
  async commit(input: Commit): Promise<MemoryOp> {
    return this.serial(async () => {
      this.assertReadable();
      this.assertOwner();
      const payloads = Object.fromEntries(Object.entries(input.payloads ?? {}).map(([id, p]) => [id, payloadSchema.parse(p)]));
      const old = this.domain.table('ops').get(input.opId);
      const { payloads: _payloads, ...header } = input;
      const op = opSchema.parse({ ...header, seq: old?.seq ?? this.state.seq + 1,
        versions: input.versions ?? [], payloadRefs: Object.keys(payloads), receiptRefs: [] });
      if (old) {
        if (!isDeepStrictEqual(old, op) || Object.entries(payloads).some(([id, p]) =>
          !isDeepStrictEqual(this.domain.table('payloads').get(id), p))) throw new Error('Memory opId reused with different or erased parameters');
        return structuredClone(old);
      }
      if (this.blocked && !['forget', 'cleanup'].includes(op.kind)) throw new Error('Memory cleanup pending; writes blocked');
      if (input.forgetEpoch !== this.state.epoch + Number(input.kind === 'forget')) throw new Error('Stale memory epoch');
      if (input.expectedRevision !== this.state.seq) throw new Error('Memory revision conflict');
      if (!Number.isSafeInteger(op.seq)) throw new Error('Memory sequence exhausted');
      if (op.versions.some(v => v.userScope !== this.scope.scope.id || !op.subjectIds.includes(v.memoryId) ||
        (!payloads[v.contentRef] && !this.domain.table('payloads').get(v.contentRef)))) throw new Error('Invalid memory version references');
      const next = applyOp(this.state, op);
      for (const [id, payload] of Object.entries(payloads)) {
        const previous = this.domain.table('payloads').get(id);
        if (previous && !isDeepStrictEqual(previous, payload)) throw new Error('Payload identity conflict');
        await this.domain.table('payloads').put(id, payload);
      }
      // Install the in-memory barrier before waiting on the authoritative forget commit.
      if (op.kind === 'forget') this.frozen = true;
      try { this.assertOwner(); await this.domain.table('ops').put(op.opId, op); }
      catch (cause) {
        this.frozen = true;
        this.publish();
        throw new Error('Memory commit outcome unknown; reopen and reconcile this opId', { cause });
      }
      this.state = next;
      if (op.kind === 'forget') {
        try {
          await this.domain.table('barriers').put(op.opId, { id: op.opId, epoch: op.forgetEpoch, targets: op.subjectIds,
            affectedSessionIds: [], state: 'blocked', scope: 'private', previewRevision: op.expectedRevision, receipts: [] });
          this.frozen = false;
        } catch (cause) { this.publish(); throw new Error('Forget committed; barrier recovery required', { cause }); }
      }
      this.publish();
      try { await persistProjection(this.domain, next); } catch { this.cacheFailures++; }
      return structuredClone(op);
    });
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
  async close(): Promise<void> { this.stopped = true; this.publish(); await this.tail; await this.domain.close(); }
}
