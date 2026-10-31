import { randomUUID } from 'node:crypto';
import { forgetChoiceSchema, forgetJobSchema, type ForgetJob, type ForgetChoice, type CleanupStatus,
  type CleanupReason, type ForgetPreview } from '../../shared/memory-forget.js';
import type { MemoryKernel } from './op-log.js';
import type { ForgetPreviews } from './forget-preview.js';
import { persistProjection } from './projection.js';

export interface ForgetIO {
  drain(): Promise<void>;
  captureHeads?(preview: ForgetPreview): Promise<string[]>;
  history(sessionId: string, job: ForgetJob): Promise<CleanupReason[]>;
  copies(): Promise<void>;
  verifyInventory(job: ForgetJob): Promise<CleanupReason[]>;
}
export class ForgetRunner {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly choosing = new Set<Promise<CleanupStatus>>();
  constructor(private readonly kernel: MemoryKernel, private readonly previews: ForgetPreviews, private readonly io: ForgetIO) {}
  choose(choice: ForgetChoice): Promise<CleanupStatus> {
    const task = this.chooseInternal(choice);
    this.choosing.add(task);
    void task.finally(() => this.choosing.delete(task)).catch(() => {});
    return task;
  }
  private async chooseInternal(choice: ForgetChoice): Promise<CleanupStatus> {
    const input = forgetChoiceSchema.parse(choice);
    // Capture only a server preview. Commit revalidates it under the same queue as stream admission.
    const preview = await this.kernel.serial(() => this.previews.validate(input.previewRevision));
    const id = randomUUID();
    await this.kernel.commit({ opId: id, kind: 'forget', subjectIds: preview.targets,
      expectedRevision: preview.revision, forgetEpoch: this.kernel.epoch + 1 }, async () => {
      if (this.stopped) throw new Error('Memory cleanup is stopping');
      await this.previews.validate(input.previewRevision);
      await this.save({ id, targets: preview.targets, sessionIds: preview.sessionIds, epoch: this.kernel.epoch + 1,
        revision: preview.revision, choice: input.choice, phase: 'intent', reasons: [], historyVerified: [], copiesVerified: false,
        blockedHeads: await this.io.captureHeads?.(preview), pendingInbox: preview.pendingMessages > 0 });
    });
    this.previews.clear();
    await this.phase(id, 'stopped');
    return input.choice === 'clean' ? this.resume(id) : this.status(id);
  }
  status(id: string): CleanupStatus {
    const job = this.job(id), committed = !!this.kernel.domain.table('ops').get(id);
    const released = this.kernel.domain.table('barriers').get(id)?.state === 'verified';
    return { id, stopped: committed, strong: committed && released && job.phase === 'verified', phase: job.phase,
      reasons: job.reasons, sessions: job.sessionIds.length };
  }
  statuses(): CleanupStatus[] { return [...this.kernel.domain.table('forget_jobs').entries()].map(([id]) => this.status(id)); }
  resume(id: string): Promise<CleanupStatus> {
    const run = this.tail.then(() => this.run(id)); this.tail = run.catch(() => {}); return run;
  }
  async recover(): Promise<void> {
    for (const [id, job] of this.kernel.domain.table('forget_jobs').entries()) {
      if (job.phase === 'verified') { await this.release(job); continue; }
      if (!this.kernel.domain.table('ops').get(id)) {
        // Intent survived without its op. Complete that exact operation, never discard it or manufacture a new ID.
        await this.kernel.commit({ opId: id, kind: 'forget', subjectIds: job.targets,
          expectedRevision: job.revision, forgetEpoch: job.epoch });
      }
      if (job.choice === 'clean') await this.resume(id);
      else await this.phase(id, 'stopped');
    }
  }
  async close(): Promise<void> {
    this.stopped = true; this.previews.clear();
    await Promise.allSettled([...this.choosing]); await this.tail;
  }
  private job(id: string): ForgetJob {
    const job = this.kernel.domain.table('forget_jobs').get(id);
    if (!job) throw new Error('Unknown cleanup operation');
    return structuredClone(job);
  }
  private save(job: ForgetJob): Promise<void> {
    return this.kernel.domain.table('forget_jobs').put(job.id, forgetJobSchema.parse(job));
  }
  private async phase(id: string, phase: ForgetJob['phase'], reasons: CleanupReason[] = []): Promise<void> {
    await this.kernel.serial(() => this.save({ ...this.job(id), phase, reasons: [...new Set(reasons)] }));
  }
  private async run(id: string): Promise<CleanupStatus> {
    if (this.stopped) throw new Error('Memory cleanup is stopping');
    if (this.job(id).phase === 'verified') { await this.release(this.job(id)); return this.status(id); }
    if (!this.kernel.domain.table('ops').get(id)) throw new Error('Forget intent has not committed');
    await this.kernel.serial(() => this.save({ ...this.job(id), phase: 'cleaning', reasons: [],
      historyVerified: [], copiesVerified: false }));
    const reasons: CleanupReason[] = [];
    try {
      await this.io.drain();
      // Remove all obsolete projections/payloads, including every prior revision of the tombstoned logical memory.
      await this.kernel.serial(() => persistProjection(this.kernel.domain, this.kernel.snapshot));
      for (const sessionId of this.job(id).sessionIds) {
        if (this.stopped) throw new Error('Memory cleanup stopped');
        const result = await this.io.history(sessionId, this.job(id));
        reasons.push(...result);
        if (!result.length) await this.kernel.serial(async () => {
          const job = this.job(id);
          await this.save({ ...job, historyVerified: [...new Set([...job.historyVerified, sessionId])] });
        });
      }
      try {
        await this.io.copies();
        await this.kernel.serial(() => this.save({ ...this.job(id), copiesVerified: true }));
      } catch { reasons.push('copies'); }
      reasons.push(...await this.io.verifyInventory(this.job(id)));
      if (this.stopped) reasons.push('unavailable');
    } catch { reasons.push('unavailable'); }
    const job = this.job(id);
    if (job.sessionIds.some(s => !job.historyVerified.includes(s))) reasons.push('history');
    if (!job.copiesVerified) reasons.push('copies');
    if (job.pendingInbox) reasons.push('inbox');
    if (reasons.length) { await this.phase(id, 'blocked', reasons); return this.status(id); }
    await this.kernel.serial(async () => {
      // Receipt first, barrier release last. A crash between them leaves admission closed.
      const receiptId = randomUUID();
      await this.kernel.domain.table('receipts').put(receiptId, {
        id: receiptId, epoch: job.epoch, sessionId: '', versionIds: [], state: 'verified',
      });
      await this.save({ ...this.job(id), phase: 'verified', reasons: [], verificationReceipt: receiptId });
      const barrier = this.kernel.domain.table('barriers').get(id);
      if (!barrier) throw new Error('Missing forget barrier');
      await this.kernel.domain.table('barriers').put(id, { ...barrier, state: 'verified', receipts: [receiptId] });
    });
    return this.status(id);
  }
  private async release(job: ForgetJob): Promise<void> {
    await this.kernel.serial(async () => {
      const receipt = job.verificationReceipt ? this.kernel.domain.table('receipts').get(job.verificationReceipt) : undefined;
      const barrier = this.kernel.domain.table('barriers').get(job.id);
      if (receipt?.state !== 'verified' || receipt.epoch !== job.epoch || !barrier)
        throw new Error('Cleanup verification receipt missing');
      if (barrier.state !== 'verified') await this.kernel.domain.table('barriers').put(job.id, {
        ...barrier, state: 'verified', receipts: [receipt.id],
      });
    });
  }
}
