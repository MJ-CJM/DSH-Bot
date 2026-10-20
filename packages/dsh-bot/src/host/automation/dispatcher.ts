import type { Context } from '@deepseek-ai/cordis';
import type { RunRecord, RunRequest } from '../../shared/automation.js';
import { configSchema, type Config } from './config.js';
import { AutomationError } from './errors.js';
import { dueOccurrence } from './rules.js';
import type { openAutomationStores } from './store.js';
import type { RunExecutor } from './executor.js';

type Stores = Awaited<ReturnType<typeof openAutomationStores>>;
export interface DispatcherClock {
  now(): number;
  setTimer(callback: () => void, ms: number): () => void;
}
const wallClock: DispatcherClock = {
  now: Date.now,
  setTimer(callback, ms) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};

/** Host-only wakeups. Stores serialize every admission and remain the authority. */
export class Dispatcher {
  private readonly config: Config;
  private readonly inFlight = new Set<string>();
  private readonly unsubscribe: () => void;
  private dueTimer?: () => void;
  private sweepTimer?: () => void;
  private scan?: Promise<void>;
  private requested = false;
  private closed = false;
  private scannedAt = -Infinity;

  constructor(ctx: Context, private readonly stores: Stores, private readonly executor: Pick<RunExecutor, 'execute'>,
    private readonly assertOwner: () => void, config: Partial<Config> = {},
    private readonly clock: DispatcherClock = wallClock,
    private readonly onError: (error: unknown) => void = error => ctx.logger.warn('[dsh-bot] dispatcher', error)) {
    this.config = configSchema.parse(config);
    this.unsubscribe = stores.subscribe(() => this.wake());
    ctx.effect(() => () => this.close(), 'dsh-bot: Dispatcher');
    this.armSweep();
    this.wake();
  }

  /** Also used by future delegate tooling: all triggers share the durable pool. */
  async submit(request: RunRequest): Promise<RunRecord> {
    if (this.closed) throw new AutomationError('automation/unavailable', 'Dispatcher is closing');
    this.assertOwner();
    const run = await this.stores.runs.enqueue(request);
    this.wake();
    return run;
  }
  runNow(routineId: string, operationId: string) {
    return this.submit({ trigger: 'manual', routineId, operationId });
  }
  /** Public to internal Host tests/observers; no Remote tick or arbitrary clock. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.requested = true;
    this.scan ??= Promise.resolve().then(async () => {
      while (this.requested && !this.closed) {
        this.requested = false;
        // Ownership failures also count as an attempted scan for retry backoff.
        this.scannedAt = this.clock.now();
        this.assertOwner();
        await this.sweep();
      }
    }).finally(() => {
      this.scan = undefined;
      // A write can notify between the loop's last await and this finalizer.
      // Join that late wakeup instead of losing it until the fallback sweep.
      if (!this.closed && this.requested) return this.tick();
      if (!this.closed) this.armDue();
    });
    return this.scan;
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe(); this.dueTimer?.(); this.sweepTimer?.();
    await this.scan?.catch(() => {});
    // Executor.close joins active executions after admission has stopped.
  }
  private wake() { if (!this.closed) void this.tick().catch(this.onError); }
  private armSweep() {
    this.sweepTimer = this.clock.setTimer(() => {
      if (this.closed) return;
      this.armSweep(); this.wake();
    }, this.config.sweepIntervalMs);
  }
  private armDue() {
    this.dueTimer?.();
    const next = this.stores.routines.list().filter(r => r.enabled && r.nextRunAt !== undefined)
      .reduce((minimum, r) => Math.min(minimum, r.nextRunAt ?? Infinity), Infinity);
    if (!Number.isFinite(next)) return;
    // Retry a due point that crossed AFTER the scan snapshot immediately.
    // Already-scanned overdue failures still wait for the periodic sweep.
    const now = this.clock.now();
    if (next <= now && next <= this.scannedAt) return;
    this.dueTimer = this.clock.setTimer(() => this.wake(), Math.max(0, Math.min(next - now, 2147483647)));
  }
  private async skip(run: RunRecord, reason: string) {
    return this.stores.runs.transition(run.id, 'skipped', run.revision, { skipReason: reason }, true);
  }
  private async sweep() {
    const now = this.clock.now();
    this.scannedAt = now;
    const due = this.stores.routines.list().filter(r => r.nextRunAt !== undefined && r.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0) || a.id.localeCompare(b.id));
    for (const routine of due) {
      if (this.closed) return;
      const occurrence = dueOccurrence(routine, now);
      if (!occurrence) continue;
      // Skip-policy tolerates ordinary timer latency within one sweep interval.
      const reason = now - occurrence.scheduledAt > this.config.catchUpMaxAgeMs ? 'catch_up_expired'
        : routine.misfirePolicy === 'skip'
          && (occurrence.scheduledAt !== routine.nextRunAt || now - occurrence.scheduledAt >= this.config.sweepIntervalMs) ? 'misfire' : undefined;
      try {
        await this.stores.runs.enqueue({ trigger: 'scheduled', routineId: routine.id, ruleRevision: routine.ruleRevision,
          ...occurrence, ...(reason ? { skipReason: reason } : {}) });
      } catch (error) {
        // Concurrent pause/edit/delete wins; other failures remain visible and
        // cannot prevent unrelated routines from being considered.
        if (!(error instanceof AutomationError && ['automation/conflict', 'automation/not-found'].includes(error.code))) this.onError(error);
      }
    }
    for (const run of this.stores.runs.pending().filter(r => r.status === 'queued')) {
      if (this.closed) return;
      if (this.inFlight.has(run.id)) continue;
      if (run.routineId) {
        const routine = this.stores.routines.get(run.routineId);
        if (routine.deletedAt !== undefined || (run.trigger === 'scheduled' && (!routine.enabled || routine.ruleRevision !== run.ruleRevision))) {
          await this.stores.runs.transition(run.id, 'cancelled', run.revision, { errorCode: 'routine/inactive' }, true);
          continue;
        }
        if (run.trigger === 'scheduled' && now - (run.scheduledAt ?? now) > this.config.catchUpMaxAgeMs) {
          await this.skip(run, 'catch_up_expired'); continue;
        }
      }
      const pending = this.stores.runs.pending();
      if (run.routineId && pending.some(r => r.id !== run.id && r.routineId === run.routineId && r.slotHeld)) {
        await this.skip(run, 'overlap'); continue;
      }
      const occupied = pending.filter(r => r.slotHeld || this.inFlight.has(r.id)).length;
      if (occupied >= this.config.maxConcurrentRuns) continue;
      this.assertOwner(); this.inFlight.add(run.id);
      // Never await model completion inside the admission loop.
      void Promise.resolve().then(() => this.executor.execute(run.id)).then(() => {
        this.inFlight.delete(run.id); this.wake();
      }, async error => {
        this.inFlight.delete(run.id);
        if (this.closed) return;
        const current = this.stores.runs.get(run.id);
        if (current.status === 'queued' && error instanceof AutomationError && error.code === 'automation/quota') {
          try { await this.skip(current, 'quota'); } catch (failure) { this.onError(failure); }
        } else this.onError(error);
      }).catch(this.onError);
    }
  }
}
