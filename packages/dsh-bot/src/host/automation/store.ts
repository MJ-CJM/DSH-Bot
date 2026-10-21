import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { automationIdSchema, automationTimeSchema, revisionSchema, isTerminalRun, runListSchema,
  runRecordSchema, runReportSchema, runRequestSchema, type RunRecord, type RunRequest, type RunStatus } from '../../shared/automation.js';
import type { BotRecord } from '../../shared/schema.js';
import { AutomationError, parse, unavailable } from './errors.js';

/** Fresh manual/delegate executions only. The retired v1 domain is never resumed. */
export const executionDomain = defineDomain({ name: 'dsh_bot_executions', version: 1,
  tables: { runs: domainTable(runRecordSchema) } });
export interface AutomationOptions {
  resolveBot: (id: string) => { bot: BotRecord; presetId: string } | Promise<{ bot: BotRecord; presetId: string }>;
  now?: () => number; beforeClose?: () => Promise<void>;
}
interface State { domain: Domain<typeof executionDomain>; options: AutomationOptions; now: () => number;
  tail: Promise<unknown>; closing: boolean; listeners: Set<() => void> }
const copy = <T>(value: T): T => structuredClone(value);
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const missing = () => new AutomationError('automation/not-found', 'Execution not found');
const conflict = () => new AutomationError('automation/conflict', 'Execution identity or revision changed');
const stamp = (s: State, previous = 0) => parse(automationTimeSchema, Math.max(s.now(), previous));
function read<T>(operation: () => T): T { return copy(operation()); }
function write<T>(s: State, operation: () => Promise<T>): Promise<T> {
  if (s.closing) return Promise.reject(new AutomationError('automation/unavailable', 'Executions are closing'));
  const pending = s.tail.then(operation); s.tail = pending.catch(() => {});
  return pending.then(value => { for (const listener of s.listeners) listener(); return copy(value); })
    .catch((error: unknown) => { throw unavailable(error); });
}
async function putRun(s: State, record: RunRecord) {
  const valid = runRecordSchema.parse(JSON.parse(JSON.stringify(record)));
  await s.domain.table('runs').put(valid.id, valid); return valid;
}
const allRuns = (s: State) => [...s.domain.table('runs').entries()].map(([, r]) => r);
function run(s: State, id: string): RunRecord { const row = s.domain.table('runs').get(id); if (!row) throw missing(); return row; }
async function bot(s: State, id: string, expected?: number) {
  const value = await s.options.resolveBot(id);
  if (value.bot.id !== id || (expected !== undefined && value.bot.createdAt !== expected)) throw conflict();
  return value;
}
export function runDedupeKey(request: RunRequest) {
  return JSON.stringify(request.trigger === 'manual' ? ['manual', request.nativeScheduleId, request.operationId]
    : ['delegate', request.originSessionId, request.operationId]);
}
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['cancelled', 'skipped'], running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_needed'],
  waiting_approval: ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_needed'],
  recovery_needed: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [], failed: [], cancelled: [], timed_out: [], skipped: [],
};
export const runProgressSchema = z.strictObject({
  step: runRecordSchema.shape.step.optional(), startedAt: automationTimeSchema.optional(),
  sessionId: runRecordSchema.shape.sessionId.optional(), snapshot: runRecordSchema.shape.snapshot.optional(),
  workspaceId: runRecordSchema.shape.workspaceId, cwd: runRecordSchema.shape.cwd,
  inputMessageId: runRecordSchema.shape.inputMessageId, inputTurn: runRecordSchema.shape.inputTurn,
  lastEventSeq: runRecordSchema.shape.lastEventSeq, execution: runRecordSchema.shape.execution, summary: runRecordSchema.shape.summary,
  errorCode: runRecordSchema.shape.errorCode, report: runReportSchema.optional(), skipReason: runRecordSchema.shape.skipReason,
}).refine((v) => Object.values(v).every((x) => x !== undefined), 'Undefined progress field');
export class RunService {
  constructor(private readonly s: State) {}
  forSession(id: string) { return read(() => allRuns(this.s).find(r => r.sessionId === id)); }
  reportable() { return read(() => allRuns(this.s).filter(r => r.trigger === 'delegate' && isTerminalRun(r.status) && (!r.report || r.report.state === 'pending'))); }
  get(id: string) { return read(() => run(this.s, parse(automationIdSchema, id))); }
  list(options: z.input<typeof runListSchema> = {}): RunRecord[] {
    const f = parse(runListSchema, options);
    return read(() => allRuns(this.s).filter(r => (!f.botId || r.botId === f.botId)
      && (!f.nativeScheduleId || r.nativeScheduleId === f.nativeScheduleId)
      && (!f.before || r.requestedAt < f.before.requestedAt || (r.requestedAt === f.before.requestedAt && r.id > f.before.id)))
      .sort((a, b) => b.requestedAt - a.requestedAt || cmp(a.id, b.id)).slice(0, f.limit));
  }
  async enqueue(input: RunRequest): Promise<RunRecord> {
    const fields = parse(runRequestSchema, input);
    return write(this.s, async () => {
      const key = runDedupeKey(fields);
      const prior = allRuns(this.s).find(r => r.dedupeKey === key);
      if (prior) {
        if (prior.botId !== fields.botId || prior.snapshot.prompt !== fields.prompt || prior.snapshot.title !== fields.title
          || (fields.trigger === 'manual' && prior.botCreatedAt !== fields.botCreatedAt)
          || (fields.trigger === 'delegate' && (prior.originBotId !== fields.originBotId || prior.originBotCreatedAt !== fields.originBotCreatedAt))) throw conflict();
        return prior;
      }
      const { bot: target, presetId } = await bot(this.s, fields.botId, fields.trigger === 'manual' ? fields.botCreatedAt : undefined);
      if (fields.trigger === 'delegate') await bot(this.s, fields.originBotId, fields.originBotCreatedAt);
      const now = stamp(this.s);
      return putRun(this.s, runRecordSchema.parse({ id: randomUUID(), schemaVersion: 1, revision: 1,
        dedupeKey: key, trigger: fields.trigger, operationId: fields.operationId,
        ...(fields.trigger === 'manual' ? { nativeScheduleId: fields.nativeScheduleId } : {}),
        botId: target.id, botCreatedAt: target.createdAt,
        snapshot: { title: fields.title, prompt: fields.prompt, timeZone: fields.trigger === 'manual' ? fields.timeZone : 'UTC', presetId, botUpdatedAt: target.updatedAt },
        requestedAt: now, updatedAt: now, status: 'queued', step: 'queued', decision: 'run',
        sessionId: `session-${randomUUID()}`, requestId: randomUUID(), slotHeld: false, depth: fields.trigger === 'delegate' ? 1 : 0,
        ...(fields.trigger === 'delegate' ? { originSessionId: fields.originSessionId, originBotId: fields.originBotId, originBotCreatedAt: fields.originBotCreatedAt } : {}),
      }));
    });
  }
  async reserve(id: string): Promise<RunRecord> {
    const key = parse(automationIdSchema, id);
    return write(this.s, async () => {
      const current = run(this.s, key); if (current.status !== 'queued') return current;
      const now = stamp(this.s, current.updatedAt);
      try {
        await bot(this.s, current.botId, current.botCreatedAt);
        if (current.originBotId) await bot(this.s, current.originBotId, current.originBotCreatedAt);
      } catch {
        return putRun(this.s, { ...current, status: 'cancelled', step: 'settled', endedAt: now, updatedAt: now,
          revision: current.revision + 1, errorCode: 'delegate/identity-unavailable' });
      }
      return putRun(this.s, { ...current, status: 'running', step: 'reserved', slotHeld: true, admittedAt: now,
        revision: current.revision + 1, updatedAt: now });
    });
  }
  /** Internal executor boundary. Terminal transitions require confirmed chain termination. */
  async transition(id: string, status: RunStatus, expectedRevision: number,
    progress: z.input<typeof runProgressSchema> = {}, confirmedStopped = false): Promise<RunRecord> {
    const key = parse(automationIdSchema, id); const target = parse(runRecordSchema.shape.status, status);
    const expected = parse(revisionSchema, expectedRevision); const fields = parse(runProgressSchema, progress);
    return write(this.s, async () => {
      const current = run(this.s, key);
      if (current.revision !== expected) throw conflict();
      // Only the create receipt may replace the preallocated session identity.
      if ((fields.sessionId !== undefined && current.step !== 'creating')
        || (fields.snapshot !== undefined && current.step !== 'reserved')) throw conflict();
      if ((current.status === target && isTerminalRun(target))
        || (current.status !== target && !transitions[current.status].includes(target))) throw conflict();
      if (isTerminalRun(target) && current.slotHeld && !confirmedStopped) {
        throw new AutomationError('automation/conflict', 'Execution chain termination is not confirmed');
      }
      const now = stamp(this.s, current.updatedAt);
      return putRun(this.s, { ...current, ...fields, status: target, revision: current.revision + 1, updatedAt: now,
        ...(isTerminalRun(target) ? { endedAt: now, slotHeld: false, step: 'settled' as const } : {}),
        ...(target === 'skipped' ? { decision: 'skip' as const } : {}),
        ...(target === 'recovery_needed' ? { step: 'unknown' as const } : {}),
      });
    });
  }
  async updateReport(id: string, report: z.input<typeof runReportSchema>, expectedRevision: number): Promise<RunRecord> {
    const key = parse(automationIdSchema, id); const fields = parse(runReportSchema, report); const expected = parse(revisionSchema, expectedRevision);
    return write(this.s, async () => {
      const current = run(this.s, key);
      if (current.revision !== expected || !isTerminalRun(current.status) || current.trigger !== 'delegate') throw conflict();
      if (current.report?.state === 'sent' || (current.report?.messageId && (current.report.messageId !== fields.messageId
        || JSON.stringify(current.report.message) !== JSON.stringify(fields.message)))
        || fields.attempts < (current.report?.attempts ?? 0)) throw conflict();
      return putRun(this.s, { ...current, report: fields, revision: current.revision + 1, updatedAt: stamp(this.s, current.updatedAt) });
    });
  }
}

export async function openAutomationStores(ctx: Context, options: AutomationOptions) {
  let state!: State; let closing: Promise<void> | undefined;
  const release = ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(executionDomain);
    state = { domain, options, now: options.now ?? Date.now, tail: Promise.resolve(), closing: false, listeners: new Set() };
    try {
      for (const [key, r] of domain.table('runs').entries()) {
        if (key !== r.id) throw new Error('Execution key mismatch');
        // No persisted request is automatically replayed after restart.
        if (r.status === 'queued') await putRun(state, { ...r, status: 'cancelled', step: 'settled', endedAt: stamp(state, r.requestedAt),
          updatedAt: stamp(state, r.updatedAt), revision: r.revision + 1, errorCode: 'restart/not-started' });
        else if (r.slotHeld && r.status !== 'recovery_needed') await putRun(state, { ...r, status: 'recovery_needed', step: 'unknown',
          updatedAt: stamp(state, r.updatedAt), revision: r.revision + 1, errorCode: 'restart/unconfirmed' });
      }
    } catch (error) { await domain.close(); throw error; }
    return () => closing ??= (async () => {
      await options.beforeClose?.(); state.closing = true; state.listeners.clear(); await state.tail; await domain.close();
    })();
  });
  await release;
  return { runs: new RunService(state), subscribe: (listener: () => void) => {
    state.listeners.add(listener); return () => { state.listeners.delete(listener); };
  }, close: async () => { await release(); await closing; } };
}
