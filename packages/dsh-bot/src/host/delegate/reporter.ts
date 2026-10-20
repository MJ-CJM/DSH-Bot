import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { reportMessageSchema, type RunRecord } from '../../shared/automation.js';
import { hasCredential } from '../../shared/secrets.js';
import type { openAutomationStores } from '../automation/store.js';
import { configSchema, type Config } from '../automation/config.js';

type Stores = Awaited<ReturnType<typeof openAutomationStores>>;
export type ReportMessage = NonNullable<NonNullable<RunRecord['report']>['message']>;
export interface ReportTarget {
  /** Recheck identity/archive state immediately before the synchronous send. */
  validate(): Promise<void>;
  evidence(message: ReportMessage): 'committed' | 'pending' | 'absent';
  /** Synchronous enqueue, verified against the newly appended Inbox splice. */
  followup(message: ReportMessage): void;
  flush(): Promise<boolean>;
}
export interface ReportRuntime { resolve(run: RunRecord): Promise<ReportTarget> }
export function reportMessage(run: RunRecord, maxChars: number): ReportMessage {
  const raw = run.summary ?? '';
  const summary = hasCredential(raw) ? '[redacted]' : raw;
  const prefix = `Delegate ${run.id}: ${run.status}\n`;
  const text = prefix + summary.slice(0, Math.min(maxChars, 8192 - prefix.length)).replace(/[\uD800-\uDBFF]$/u, '');
  return reportMessageSchema.parse(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-bot-delegate', form: 'notice', summary: `Delegate ${run.status}`,
      runId: run.id, sourceSessionId: run.sessionId },
  }));
}

/** One Host owns one serialized outbox. Uncertain sends are never replayed. */
export class DelegateReporter {
  private requested = false;
  private closed = false;
  private task?: Promise<void>;
  private readonly unsubscribe: () => void;
  private readonly maxChars: number;
  constructor(ctx: Context, private readonly stores: Stores, private readonly runtime: ReportRuntime,
    private readonly assertOwner: () => void, config: Partial<Config> = {},
    private readonly onError: (error: unknown) => void = () => ctx.logger.warn('[dsh-bot] delegate report persistence unavailable')) {
    this.maxChars = configSchema.parse(config).delegateReportMaxChars;
    this.unsubscribe = stores.subscribe(() => this.wake());
    ctx.effect(() => () => this.close(), 'dsh-bot: delegate reports');
    this.wake();
  }
  private wake() { if (!this.closed) void this.tick().catch(this.onError); }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.requested = true;
    this.task ??= Promise.resolve().then(async () => {
      while (this.requested && !this.closed) {
        this.requested = false;
        for (const run of this.stores.runs.reportable()) {
          if (this.closed) break;
          await this.deliver(run);
        }
      }
    }).finally(() => { this.task = undefined; if (this.requested && !this.closed) return this.tick(); });
    return this.task;
  }
  async close() { this.closed = true; this.unsubscribe(); await this.task?.catch(() => {}); }
  private async deliver(initial: RunRecord) {
    this.assertOwner();
    let run = initial;
    const update = async (report: NonNullable<RunRecord['report']>) => {
      this.assertOwner();
      run = await this.stores.runs.updateReport(run.id, report, run.revision);
    };
    if (!run.report?.message) {
      const message = reportMessage(run, this.maxChars);
      await update({ state: 'pending', originSessionId: run.originSessionId ?? '', attempts: 0, messageId: message.id, message });
    }
    const report = run.report;
    if (!report?.message) throw new Error('Missing persisted report');
    try {
      const target = await this.runtime.resolve(run);
      if (this.closed) return;
      await target.validate();
      this.assertOwner();
      const evidence = target.evidence(report.message);
      if (evidence === 'committed') {
        if (!await target.flush()) throw new Error('Report flush unavailable');
        await update({ ...report, state: 'sent', durableAt: Date.now() });
        return;
      }
      if (report.attempts > 0 || evidence === 'pending') {
        // Cold Inbox has no public safe wake-only API. Do not double insert it.
        await update({ ...report, state: 'blocked', reason: evidence === 'pending' ? 'report/pending-recovery' : 'report/delivery-uncertain' });
        return;
      }
      await update({ ...report, attempts: 1, lastAttemptAt: Date.now() });
      if (this.closed) return;
      await target.validate();
      this.assertOwner();
      if (this.closed) return;
      target.followup(report.message);
      if (!await target.flush()) throw new Error('Report delivery unconfirmed');
      await update({ ...(run.report ?? report), state: 'sent', durableAt: Date.now() });
    } catch {
      // No raw transport errors or model text in diagnostic metadata.
      await update({ ...(run.report ?? report), state: 'blocked', reason: 'report/unreachable-or-unconfirmed' });
    }
  }
}
