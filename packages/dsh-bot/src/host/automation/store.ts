import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  automationControlSchema, automationIdSchema, automationTimeSchema, createdBySchema, isTerminalRun,
  revisionSchema, routineCreateSchema, routineListSchema, routinePatchSchema, routineRecordSchema,
  runListSchema, runRecordSchema, runReportSchema, runRequestSchema,
} from '../../shared/automation.js';
import type {
  AutomationControl, RoutineCreate, RoutinePatch, RoutineRecord, RunRecord, RunRequest, RunStatus,
} from '../../shared/automation.js';
import type { BotRecord } from '../../shared/schema.js';
import { configSchema, type Config } from './config.js';
import { AutomationError, parse, unavailable } from './errors.js';
import { prepareRule } from './rules.js';

export const automationDomain = defineDomain({ name: 'dsh_bot_automation', version: 1, tables: {
  routines: domainTable(routineRecordSchema), runs: domainTable(runRecordSchema), control: domainTable(automationControlSchema),
} });
type AutomationDomain = Domain<typeof automationDomain>;
export interface AutomationOptions {
  config?: Partial<Config>;
  /** Caller must already hold the storage's single-Host lease. Rechecked for every write.
   * Lock acquisition belongs to the Host coordinator; this factory never acquires one. */
  assertOwner: () => void;
  ownerId: string;
  resolveBot: (botId: string) => { bot: BotRecord; presetId: string } | Promise<{ bot: BotRecord; presetId: string }>;
  now?: () => number;
}
interface State {
  domain: AutomationDomain; config: Config; options: AutomationOptions; now: () => number;
  tail: Promise<unknown>; closing: boolean;
}
const copy = <T>(value: T): T => structuredClone(value);
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const missing = () => new AutomationError('automation/not-found', 'Automation record not found');
const conflict = () => new AutomationError('automation/conflict', 'Automation record changed or operation identity conflicts');
const stamp = (s: State, previous = 0) => parse(automationTimeSchema, Math.max(s.now(), previous));
function read<T>(operation: () => T): T { try { return copy(operation()); } catch (error) { throw unavailable(error); } }
function write<T>(s: State, operation: () => Promise<T>): Promise<T> {
  if (s.closing) return Promise.reject(new AutomationError('automation/unavailable', 'Automation stores are closing'));
  const pending = s.tail.then(async () => { s.options.assertOwner(); return operation(); });
  s.tail = pending.catch(() => {});
  return pending.then(copy).catch((error: unknown) => { throw unavailable(error); });
}
async function putRoutine(s: State, record: RoutineRecord) {
  s.options.assertOwner();
  const valid = routineRecordSchema.parse(JSON.parse(JSON.stringify(record)));
  await s.domain.table('routines').put(valid.id, valid);
  return valid;
}
async function putRun(s: State, record: RunRecord) {
  s.options.assertOwner();
  const valid = runRecordSchema.parse(JSON.parse(JSON.stringify(record)));
  await s.domain.table('runs').put(valid.id, valid);
  return valid;
}
function freshId(s: State, table: 'routines' | 'runs'): string {
  let id = randomUUID();
  while (s.domain.table(table).get(id)) id = randomUUID();
  return id;
}
const allRuns = (s: State) => [...s.domain.table('runs').entries()].map(([, r]) => r);
function routine(s: State, id: string, includeDeleted = false): RoutineRecord {
  const row = s.domain.table('routines').get(id);
  if (!row || (!includeDeleted && row.deletedAt !== undefined)) throw missing();
  return row;
}
function run(s: State, id: string): RunRecord {
  const row = s.domain.table('runs').get(id);
  if (!row) throw missing();
  return row;
}
async function bot(s: State, id: string, expected?: number) {
  const resolved = await s.options.resolveBot(id);
  if (resolved.bot.id !== id || (expected !== undefined && resolved.bot.createdAt !== expected)) throw conflict();
  return resolved;
}
export function quotaDate(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${value('year')?.padStart(4, '0')}-${value('month')}-${value('day')}`;
}
export function runDedupeKey(request: RunRequest): string {
  return request.trigger === 'scheduled' ? JSON.stringify(['scheduled', request.routineId, request.ruleRevision, request.scheduledAt])
    : request.trigger === 'manual' ? JSON.stringify(['manual', request.routineId, request.operationId])
      : JSON.stringify(['delegate', request.originSessionId, request.operationId]);
}

/** Run rows are the authority. Control/cursor commits can be retried after any failure. */
async function rebuild(s: State): Promise<AutomationControl> {
  const table = s.domain.table('control');
  const previous = table.get('quota');
  if (previous && previous.quotaTimeZone !== s.config.quotaTimeZone) {
    throw new AutomationError('automation/clock', 'Quota time zone differs from the persisted policy');
  }
  let high = previous?.quotaDateHighWater;
  const counts = new Map<string, { botId: string; date: string; count: number }>();
  const seen = new Set<string>();
  for (const r of allRuns(s)) {
    if (seen.has(r.dedupeKey)) throw new AutomationError('automation/unavailable', 'Duplicate persisted operation key');
    seen.add(r.dedupeKey);
    if (r.quotaCharged && r.quotaDate) {
      if (r.quotaTimeZone !== s.config.quotaTimeZone) throw new AutomationError('automation/clock', 'Reservation quota policy mismatch');
      high = high === undefined || r.quotaDate > high ? r.quotaDate : high;
      const key = `${r.botId}/${r.quotaDate}`;
      const count = counts.get(key) ?? { botId: r.botId, date: r.quotaDate, count: 0 };
      count.count++;
      counts.set(key, count);
    }
  }
  const projection = automationControlSchema.parse({ schemaVersion: 1, quotaTimeZone: s.config.quotaTimeZone,
    ...(high === undefined ? {} : { quotaDateHighWater: high }),
    counts: [...counts.values()].sort((a, b) => cmp(a.botId, b.botId) || cmp(a.date, b.date)) });
  if (JSON.stringify(previous) !== JSON.stringify(projection)) {
    s.options.assertOwner();
    await table.put('quota', projection);
  }
  for (const r of allRuns(s)) {
    if (r.trigger !== 'scheduled' || !r.routineId || r.scheduledAt === undefined) continue;
    const current = s.domain.table('routines').get(r.routineId);
    if (!current || current.deletedAt !== undefined || current.ruleRevision !== r.ruleRevision
      || current.botCreatedAt !== r.botCreatedAt || !current.enabled
      || (current.lastDecidedOccurrenceAt !== undefined && current.lastDecidedOccurrenceAt >= r.scheduledAt)) continue;
    await putRoutine(s, { ...current, nextRunAt: r.nextRunAt ?? undefined, lastDecidedOccurrenceAt: r.scheduledAt,
      lastDecisionKey: r.dedupeKey, lastRunId: r.id, revision: current.revision + 1, updatedAt: stamp(s, current.updatedAt) });
  }
  return projection;
}

export class RoutineService {
  constructor(private readonly s: State) {}
  list(options: z.input<typeof routineListSchema> = {}): RoutineRecord[] {
    const filter = parse(routineListSchema, options);
    return read(() => [...this.s.domain.table('routines').entries()].map(([, r]) => r)
      .filter((r) => (filter.botId === undefined || r.botId === filter.botId) && (filter.includeDeleted || r.deletedAt === undefined))
      .sort((a, b) => b.createdAt - a.createdAt || cmp(a.id, b.id)));
  }
  get(id: string): RoutineRecord { const key = parse(automationIdSchema, id); return read(() => routine(this.s, key, true)); }
  async create(input: RoutineCreate, createdBy: z.input<typeof createdBySchema> = { kind: 'user' }): Promise<RoutineRecord> {
    const fields = parse(routineCreateSchema, input);
    const origin = parse(createdBySchema, createdBy);
    return write(this.s, async () => {
      const { bot: target } = await bot(this.s, fields.botId);
      const now = stamp(this.s); const id = freshId(this.s, 'routines');
      const prepared = prepareRule(id, fields.rule, fields.timeZone, now);
      return putRoutine(this.s, routineRecordSchema.parse({ ...fields, ...prepared, id, schemaVersion: 1, revision: 1, ruleRevision: 1,
        botCreatedAt: target.createdAt, createdBy: origin, workspacePolicy: 'bots', anchorAt: now, createdAt: now, updatedAt: now,
        nextRunAt: fields.enabled ? prepared.nextRunAt : undefined }));
    });
  }
  async update(id: string, patch: RoutinePatch, expectedRevision: number): Promise<RoutineRecord> {
    const key = parse(automationIdSchema, id); const fields = parse(routinePatchSchema, patch);
    const expected = parse(revisionSchema, expectedRevision);
    return write(this.s, async () => {
      const current = routine(this.s, key);
      if (current.revision !== expected) throw conflict();
      await bot(this.s, current.botId, current.botCreatedAt);
      const now = stamp(this.s, current.updatedAt);
      let next = { ...current, ...fields, revision: current.revision + 1, updatedAt: now };
      // Equivalent normalized rules do not change occurrence identity.
      const candidate = fields.rule !== undefined || fields.timeZone !== undefined
        ? prepareRule(key, next.rule, next.timeZone, next.rule.kind === 'at' && next.rule.at <= now ? next.rule.at - 1 : now) : undefined;
      const timingChanged = candidate !== undefined && (JSON.stringify(candidate.rule) !== JSON.stringify(current.rule) || next.timeZone !== current.timeZone);
      if (timingChanged || (!current.enabled && next.enabled)) {
        // Resuming an expired one-shot does not move its absolute target.
        const prepared = next.rule.kind === 'at' && next.rule.at <= now && !timingChanged
          ? { rule: next.rule, nextRunAt: undefined } : prepareRule(key, next.rule, next.timeZone, now);
        next = { ...next, ...prepared, anchorAt: now, ruleRevision: current.ruleRevision + 1,
          lastDecidedOccurrenceAt: undefined, lastDecisionKey: undefined };
      }
      if (!next.enabled) next.nextRunAt = undefined;
      return putRoutine(this.s, next);
    });
  }
  async remove(id: string, expectedRevision: number): Promise<RoutineRecord> {
    const key = parse(automationIdSchema, id); const expected = parse(revisionSchema, expectedRevision);
    return write(this.s, async () => {
      const current = routine(this.s, key, true);
      if (current.deletedAt !== undefined) return current;
      if (current.revision !== expected) throw conflict();
      const now = stamp(this.s, current.updatedAt);
      return putRoutine(this.s, { ...current, enabled: false, nextRunAt: undefined, deletedAt: now,
        revision: current.revision + 1, updatedAt: now });
    });
  }
}

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['cancelled', 'skipped'], running: ['waiting_approval', 'succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_needed'],
  waiting_approval: ['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_needed'],
  recovery_needed: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [], failed: [], cancelled: [], timed_out: [], skipped: [],
};
export const runProgressSchema = z.strictObject({
  step: runRecordSchema.shape.step.optional(), startedAt: automationTimeSchema.optional(),
  workspaceId: runRecordSchema.shape.workspaceId, cwd: runRecordSchema.shape.cwd,
  inputMessageId: runRecordSchema.shape.inputMessageId, inputTurn: runRecordSchema.shape.inputTurn,
  lastEventSeq: runRecordSchema.shape.lastEventSeq, execution: runRecordSchema.shape.execution, summary: runRecordSchema.shape.summary,
  errorCode: runRecordSchema.shape.errorCode, report: runReportSchema.optional(), skipReason: runRecordSchema.shape.skipReason,
}).refine((v) => Object.values(v).every((x) => x !== undefined), 'Undefined progress field');
export class RunService {
  constructor(private readonly s: State) {}
  get(id: string): RunRecord { const key = parse(automationIdSchema, id); return read(() => run(this.s, key)); }
  list(options: z.input<typeof runListSchema> = {}): RunRecord[] {
    const filter = parse(runListSchema, options);
    return read(() => allRuns(this.s).filter((r) => (filter.botId === undefined || r.botId === filter.botId)
      && (filter.routineId === undefined || r.routineId === filter.routineId)
      && (!filter.before || r.requestedAt < filter.before.requestedAt || (r.requestedAt === filter.before.requestedAt && r.id > filter.before.id)))
      .sort((a, b) => b.requestedAt - a.requestedAt || cmp(a.id, b.id)).slice(0, filter.limit));
  }
  control(): AutomationControl { return read(() => this.s.domain.table('control').get('quota') ?? (() => { throw missing(); })()); }
  /** Durable queue acceptance; no session or model side effect, no quota charged yet. */
  async enqueue(input: RunRequest): Promise<RunRecord> {
    const fields = parse(runRequestSchema, input);
    return write(this.s, async () => {
      await rebuild(this.s);
      const key = runDedupeKey(fields);
      const prior = allRuns(this.s).find((r) => r.dedupeKey === key);
      if (prior) {
        if (fields.trigger === 'delegate' && (prior.botId !== fields.botId || prior.snapshot.prompt !== fields.prompt
          || prior.snapshot.title !== fields.title || prior.originBotId !== fields.originBotId || prior.originBotCreatedAt !== fields.originBotCreatedAt)) throw conflict();
        return prior;
      }
      const now = stamp(this.s);
      const r = fields.trigger === 'delegate' ? undefined : routine(this.s, fields.routineId);
      if (r) await bot(this.s, r.botId, r.botCreatedAt);
      if (fields.trigger === 'scheduled' && r) {
        if (!r.enabled || r.ruleRevision !== fields.ruleRevision || r.nextRunAt === undefined || fields.scheduledAt < r.nextRunAt
          || fields.scheduledAt > now || (fields.nextRunAt !== null && fields.nextRunAt <= fields.scheduledAt)
          || (r.lastDecidedOccurrenceAt !== undefined && fields.scheduledAt <= r.lastDecidedOccurrenceAt)) throw conflict();
      }
      if (fields.trigger === 'delegate') await bot(this.s, fields.originBotId, fields.originBotCreatedAt);
      const { bot: target, presetId } = await bot(this.s, r?.botId ?? (fields as Extract<RunRequest, { trigger: 'delegate' }>).botId);
      const skipReason = fields.trigger === 'scheduled' ? fields.skipReason : undefined;
      if (!skipReason && allRuns(this.s).filter((v) => v.status === 'queued').length >= this.s.config.maxQueuedRuns) {
        throw new AutomationError('automation/busy', 'Automation queue is full');
      }
      const record = runRecordSchema.parse({
        id: freshId(this.s, 'runs'), schemaVersion: 1, revision: 1, dedupeKey: key, trigger: fields.trigger,
        ...(fields.trigger === 'scheduled' ? { scheduledAt: fields.scheduledAt, nextRunAt: fields.nextRunAt } : { operationId: fields.operationId }),
        ...(r ? { routineId: r.id, routineRevision: r.revision, ruleRevision: r.ruleRevision } : {}),
        botId: target.id, botCreatedAt: target.createdAt,
        snapshot: { title: r?.title ?? (fields as Extract<RunRequest, { trigger: 'delegate' }>).title,
          prompt: r?.prompt ?? (fields as Extract<RunRequest, { trigger: 'delegate' }>).prompt,
          timeZone: r?.timeZone ?? this.s.config.quotaTimeZone, presetId, botUpdatedAt: target.updatedAt },
        requestedAt: now, updatedAt: now, status: skipReason ? 'skipped' : 'queued', step: skipReason ? 'settled' : 'queued',
        decision: skipReason ? 'skip' : 'run', ...(skipReason ? { skipReason, endedAt: now } : {}),
        sessionId: `session-${randomUUID()}`, requestId: randomUUID(), quotaCharged: false, slotHeld: false,
        depth: fields.trigger === 'delegate' ? 1 : 0,
        ...(fields.trigger === 'delegate' ? { originSessionId: fields.originSessionId, originBotId: fields.originBotId,
          originBotCreatedAt: fields.originBotCreatedAt } : {}),
      });
      await putRun(this.s, record);
      await rebuild(this.s);
      return record;
    });
  }
  /** Reservation commits quota and slot in the SAME Run row, before any external action. */
  async reserve(id: string): Promise<RunRecord> {
    const key = parse(automationIdSchema, id);
    return write(this.s, async () => {
      const control = await rebuild(this.s);
      const current = run(this.s, key);
      if (current.status !== 'queued') return current;
      await bot(this.s, current.botId, current.botCreatedAt);
      const now = stamp(this.s, current.updatedAt);
      if (current.routineId) {
        const r = routine(this.s, current.routineId, true);
        if (r.deletedAt !== undefined || (current.trigger === 'scheduled' && (!r.enabled || r.ruleRevision !== current.ruleRevision))) {
          return putRun(this.s, { ...current, status: 'cancelled', step: 'settled', endedAt: now, updatedAt: now,
            revision: current.revision + 1, errorCode: 'routine/inactive' });
        }
        if (allRuns(this.s).some((v) => v.id !== key && v.routineId === current.routineId && v.slotHeld)) {
          return putRun(this.s, { ...current, status: 'skipped', decision: 'skip', skipReason: 'overlap', step: 'settled',
            endedAt: now, updatedAt: now, revision: current.revision + 1 });
        }
      }
      if (allRuns(this.s).filter((v) => v.slotHeld).length >= this.s.config.maxConcurrentRuns) {
        throw new AutomationError('automation/busy', 'All automation slots are occupied');
      }
      const date = quotaDate(stamp(this.s), control.quotaTimeZone);
      if (control.quotaDateHighWater && date < control.quotaDateHighWater) throw new AutomationError('automation/clock', 'Quota clock moved backwards');
      if ((control.counts.find((v) => v.botId === current.botId && v.date === date)?.count ?? 0) >= this.s.config.maxRunsPerBotPerDay) {
        throw new AutomationError('automation/quota', 'Bot daily automation quota exhausted');
      }
      const reserved = await putRun(this.s, { ...current, status: 'running', step: 'reserved', slotHeld: true,
        quotaCharged: true, admittedAt: now, quotaDate: date, quotaTimeZone: control.quotaTimeZone, ownerId: this.s.options.ownerId,
        revision: current.revision + 1, updatedAt: now });
      await rebuild(this.s);
      return reserved;
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

export async function openAutomationStores(ctx: Context, options: AutomationOptions): Promise<{
  routines: RoutineService; runs: RunService; close: () => Promise<void>;
}> {
  let state!: State; let closing: Promise<void> | undefined;
  try {
    options.assertOwner();
    const config = parse(configSchema, options.config ?? {});
    parse(z.string().min(1).max(256), options.ownerId);
    const release = ctx.effect(async () => {
      options.assertOwner();
      const domain = await ctx.storageDomain.open(automationDomain);
      if (options.config?.quotaTimeZone === undefined) config.quotaTimeZone = domain.table('control').get('quota')?.quotaTimeZone
        ?? [...domain.table('runs').entries()].find(([, r]) => r.quotaCharged)?.[1].quotaTimeZone ?? config.quotaTimeZone;
      state = { domain, config, options, now: options.now ?? Date.now, tail: Promise.resolve(), closing: false };
      try {
        // Validate every row and key before any recovery mutation; bad input remains untouched.
        for (const [key, r] of domain.table('routines').entries()) {
          if (key !== r.id) throw new Error('Routine key mismatch');
          prepareRule(r.id, r.rule, r.timeZone, r.rule.kind === 'at' ? Math.min(r.anchorAt, r.rule.at - 1) : r.anchorAt);
        }
        for (const [key, r] of domain.table('runs').entries()) {
          if (key !== r.id) throw new Error('Run key mismatch');
          const expected = r.trigger === 'scheduled' ? JSON.stringify(['scheduled', r.routineId, r.ruleRevision, r.scheduledAt])
            : r.trigger === 'manual' ? JSON.stringify(['manual', r.routineId, r.operationId])
              : JSON.stringify(['delegate', r.originSessionId, r.operationId]);
          if (expected !== r.dedupeKey) throw new Error('Run dedupe key mismatch');
          if (r.routineId) {
            const parent = domain.table('routines').get(r.routineId);
            if (!parent || parent.botId !== r.botId || parent.botCreatedAt !== r.botCreatedAt
              || (r.ruleRevision ?? 0) > parent.ruleRevision) throw new Error('Run routine identity mismatch');
          }
        }
        for (const [key] of domain.table('control').entries()) if (key !== 'quota') throw new Error('Unknown control key');
        await rebuild(state);
        for (const r of allRuns(state)) {
          if (r.slotHeld && r.status !== 'recovery_needed') await putRun(state, { ...r, status: 'recovery_needed', step: 'unknown',
            revision: r.revision + 1, updatedAt: stamp(state, r.updatedAt), errorCode: 'restart/unconfirmed' });
        }
      } catch (error) {
        state.closing = true; await domain.close();
        if (error instanceof AutomationError && ['automation/clock', 'automation/read-only', 'automation/unavailable'].includes(error.code)) throw error;
        throw new AutomationError('automation/unavailable', 'Invalid persisted automation state', { cause: error });
      }
      return () => closing ??= (async () => { state.closing = true; await state.tail; await domain.close(); })();
    });
    await release;
    return { routines: new RoutineService(state), runs: new RunService(state),
      close: async () => { await release(); await closing; } };
  } catch (error) { throw unavailable(error); }
}
