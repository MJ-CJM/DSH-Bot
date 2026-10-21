import type { Context } from '@deepseek-ai/cordis';
import { setTimeout as delay } from 'node:timers/promises';
import { isTerminalRun, type RunRecord } from '../../shared/automation.js';
import type { BotRecord } from '../../shared/schema.js';
import { configSchema, type Config } from './config.js';
import { AutomationError } from './errors.js';
import { inspectBarrier, type Observation } from './barrier.js';
import type { RunService } from './store.js';

export interface ExecutorRuntime {
  resolveBot(id: string): Promise<{ bot: BotRecord; presetId: string }>;
  workspace(): Promise<{ workspaceId: string; path: string }>;
  create(run: RunRecord): Promise<{ sessionId: string }>;
  verify(run: RunRecord): Promise<void>;
  rename(run: RunRecord, title: string): Promise<void>;
  prompt(run: RunRecord, signal: AbortSignal): Promise<void>;
  observe(run: RunRecord): Promise<Observation>;
  stop(run: RunRecord): Promise<void>;
  flush(run: RunRecord): Promise<boolean>;
}
export function runTitle(run: RunRecord): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: run.snapshot.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(run.admittedAt ?? run.requestedAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
  return `[Run now] ${run.snapshot.title} · ${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${run.snapshot.timeZone}`;
}
type StopIntent = 'cancelled' | 'timed_out' | 'unloaded';
interface Active { abort: AbortController; intent?: StopIntent; done: Promise<RunRecord> }

/** One owner, one in-flight promise per Run. No recovery replay and no scheduler. */
export class RunExecutor {
  readonly config: Config;
  private readonly active = new Map<string, Active>();
  private closing = false;
  private closeTask?: Promise<void>;
  private uncertain = false;
  constructor(ctx: Context, private readonly runs: RunService, private readonly runtime: ExecutorRuntime,
    private readonly assertOwner: () => void, config: Partial<Config> = {}) {
    this.config = configSchema.parse(config);
    ctx.effect(() => () => this.close(), 'dsh-bot: RunExecutor');
  }
  /** False retains the execution resources on unload while an external operation may still be running. */
  get safeToRelease() { return !this.uncertain; }
  execute(id: string): Promise<RunRecord> {
    if (this.closing) return Promise.reject(new AutomationError('automation/unavailable', 'Executor is closing'));
    this.assertOwner();
    const prior = this.active.get(id);
    if (prior) return prior.done;
    const active: Active = { abort: new AbortController(), done: Promise.resolve(this.runs.get(id)) };
    this.active.set(id, active);
    active.done = this.perform(id, active).finally(() => { this.active.delete(id); });
    return active.done;
  }
  async cancel(id: string): Promise<RunRecord> {
    this.assertOwner();
    const active = this.active.get(id);
    if (active) {
      active.intent ??= 'cancelled'; active.abort.abort(); return active.done;
    }
    const run = this.runs.get(id);
    if (run.status === 'queued') return this.runs.transition(id, 'cancelled', run.revision, {}, true);
    // Unknown recovered chains require explicit reconciliation, never a blind slot release.
    return run;
  }
  close(): Promise<void> {
    this.closeTask ??= (async () => {
      this.closing = true;
      for (const active of this.active.values()) { active.intent ??= 'unloaded'; active.abort.abort(); }
      await Promise.allSettled([...this.active.values()].map(a => a.done));
    })();
    return this.closeTask;
  }
  private async perform(id: string, active: Active): Promise<RunRecord> {
    let run = this.runs.get(id);
    if (run.status !== 'queued' || run.trigger !== 'manual') return run;
    // reserve errors may follow an authoritative Run commit. Do not retry creation.
    try { run = await this.runs.reserve(id); }
    catch (error) {
      run = this.runs.get(id);
      if (run.slotHeld) return this.runs.transition(id, 'recovery_needed', run.revision, { errorCode: 'reservation/unconfirmed' });
      throw error;
    }
    if (run.status !== 'running') return run;
    const timer = setTimeout(() => { active.intent ??= 'timed_out'; active.abort.abort(); }, this.config.runTimeoutMs);
    let externalStarted = false;
    let unknownTurn = false;
    let pending = 0;
    const guard = () => { this.assertOwner(); active.abort.signal.throwIfAborted(); };
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      guard();
      pending++;
      const task = Promise.resolve().then(() => { guard(); return work(); }).finally(() => { pending--; });
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Execution interrupted'));
        active.abort.signal.addEventListener('abort', abort, { once: true });
        if (active.abort.signal.aborted) abort();
      });
      try { const value = await Promise.race([task, interrupted]); guard(); return value; }
      finally { active.abort.signal.removeEventListener('abort', abort); }
    };
    const progress = async (fields: Parameters<RunService['transition']>[3], waiting = false) => {
      guard();
      run = await this.runs.transition(id, waiting ? 'waiting_approval' : 'running', run.revision, fields);
    };
    try {
      const current = await bounded(() => this.runtime.resolveBot(run.botId));
      if (current.bot.createdAt !== run.botCreatedAt) throw new Error('Bot identity changed');
      await progress({ snapshot: { ...run.snapshot, presetId: current.presetId, botUpdatedAt: current.bot.updatedAt } });
      const workspace = await bounded(() => this.runtime.workspace());
      await progress({ step: 'creating', workspaceId: workspace.workspaceId, cwd: workspace.path });
      externalStarted = true;
      const created = await bounded(() => this.runtime.create(run));
      await progress({ sessionId: created.sessionId, startedAt: Math.max(Date.now(), run.admittedAt ?? run.requestedAt) });
      await bounded(() => this.runtime.verify(run));
      await bounded(() => this.runtime.rename(run, runTitle(run)));
      // Persist the blank session header and title before admitting model input.
      if (!await bounded(() => this.runtime.flush(run))) throw new Error('Header flush failed');
      const admitted = await bounded(() => this.runtime.resolveBot(run.botId));
      if (admitted.bot.createdAt !== run.botCreatedAt || admitted.bot.updatedAt !== run.snapshot.botUpdatedAt
        || admitted.presetId !== run.snapshot.presetId) throw new Error('Bot changed during session creation');
      await progress({ step: 'submitting' });
      await bounded(() => this.runtime.prompt(run, active.abort.signal));
      await progress({ step: 'executing' });
      for (;;) {
        const observation = await bounded(() => this.runtime.observe(run));
        const barrier = inspectBarrier(observation, run);
        // Avoid writing identical polling snapshots.
        const wantedStatus = barrier.waitingApproval ? 'waiting_approval' : 'running';
        if (run.status !== wantedStatus || run.lastEventSeq !== barrier.progress.lastEventSeq
          || JSON.stringify(run.execution) !== JSON.stringify(barrier.progress.execution)) {
          await progress(barrier.progress, barrier.waitingApproval);
        }
        if (barrier.outcome === 'recovery_needed') {
          unknownTurn = true;
          throw new Error('Unknown recovered turn');
        }
        if (barrier.chainStopped && barrier.outcome) {
          if (!await bounded(() => this.runtime.flush(run))) throw new Error('Final flush failed');
          // flush and descendant reads are async; recheck after them before committing.
          const after = inspectBarrier(await bounded(() => this.runtime.observe(run)), run);
          if (after.chainStopped && after.outcome === barrier.outcome && after.progress.lastEventSeq === barrier.progress.lastEventSeq) {
            guard();
            return await this.runs.transition(id, after.outcome, run.revision,
              { ...after.progress, ...(after.errorCode ? { errorCode: after.errorCode } : {}) }, true);
          }
        }
        await bounded(() => delay(this.config.executorPollMs, undefined, { signal: active.abort.signal }));
      }
    } catch {
      // Stop admission first. Never label a cancellation/timeout terminal on signal alone.
      active.abort.abort();
      try {
        run = this.runs.get(id);
        if (isTerminalRun(run.status)) return run;
        let stopped = !externalStarted && pending === 0;
        if (externalStarted) {
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          let expired = false;
          try {
            stopped = await Promise.race([
              (async () => {
                await this.runtime.stop(run);
                const limit = Date.now() + this.config.stopGraceMs;
                while (!expired && Date.now() < limit) {
                  const barrier = inspectBarrier(await this.runtime.observe(run), run);
                  if (expired) return false;
                  if (pending === 0 && barrier.chainStopped) return await this.runtime.flush(run);
                  await delay(this.config.executorPollMs);
                }
                return false;
              })(),
              new Promise<false>(resolve => { graceTimer = setTimeout(() => resolve(false), this.config.stopGraceMs); }),
            ]);
          } catch { stopped = false; }
          finally { expired = true; clearTimeout(graceTimer); }
        }
        const status = unknownTurn ? 'recovery_needed' : stopped ? active.intent === 'timed_out' ? 'timed_out'
          : active.intent ? 'cancelled' : 'failed' : 'recovery_needed';
        if (!stopped) this.uncertain = true;
        return await this.runs.transition(id, status, run.revision,
          { errorCode: unknownTurn ? 'turn/unknown' : active.intent ? `executor/${active.intent}` : 'executor/unconfirmed' }, stopped);
      } catch (error) {
        this.uncertain = true;
        throw error;
      }
    } finally { clearTimeout(timer); }
  }
}
