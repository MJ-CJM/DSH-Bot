import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { hasCredential } from './secrets.js';

export const automationIdSchema = z.uuid();
export const automationTimeSchema = z.number().int().min(0).max(253402300799999);
export const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const timeZoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid time zone');
const text = (max: number) => z.string().trim().min(1).max(max);
const wallTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/);
export const routineRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: automationTimeSchema }),
  z.strictObject({ kind: z.literal('every'), everySeconds: z.number().int().min(60).max(2147483647) }),
  z.strictObject({ kind: z.literal('daily'), time: wallTime }),
  z.strictObject({ kind: z.literal('weekly'), time: wallTime,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((v) => new Set(v).size === v.length) }),
  // Host validation uses the public schedule factory; this is only the wire shape.
  z.strictObject({ kind: z.literal('cron'), expression: text(256) }),
]);
export const routineCreateSchema = z.strictObject({
  botId: botIdSchema, title: text(120), prompt: text(65536), rule: routineRuleSchema,
  timeZone: timeZoneSchema, enabled: z.boolean().default(true), misfirePolicy: z.enum(['latest', 'skip']).default('latest'),
});
export const routinePatchSchema = z.strictObject({
  title: text(120).optional(), prompt: text(65536).optional(), rule: routineRuleSchema.optional(),
  timeZone: timeZoneSchema.optional(), enabled: z.boolean().optional(), misfirePolicy: z.enum(['latest', 'skip']).optional(),
})
  .refine((v) => Object.keys(v).length > 0 && Object.values(v).every((x) => x !== undefined), 'Empty or undefined patch');
export const createdBySchema = z.strictObject({ kind: z.enum(['user', 'model']), sessionId: text(256).optional() });
export const routineRecordSchema = routineCreateSchema.extend({
  enabled: z.boolean(), misfirePolicy: z.enum(['latest', 'skip']),
  id: automationIdSchema, schemaVersion: z.literal(1), revision: revisionSchema, ruleRevision: revisionSchema,
  botCreatedAt: automationTimeSchema, createdBy: createdBySchema, workspacePolicy: z.literal('bots'),
  anchorAt: automationTimeSchema, nextRunAt: automationTimeSchema.optional(),
  lastDecidedOccurrenceAt: automationTimeSchema.optional(), lastDecisionKey: text(1024).optional(),
  lastRunId: automationIdSchema.optional(), deletedAt: automationTimeSchema.optional(),
  createdAt: automationTimeSchema, updatedAt: automationTimeSchema,
}).refine((r) => r.updatedAt >= r.createdAt && (r.enabled || r.nextRunAt === undefined)
  && (r.deletedAt === undefined || (!r.enabled && r.deletedAt >= r.createdAt && r.deletedAt <= r.updatedAt)), 'Invalid routine lifecycle');
export const runStatusSchema = z.enum(['queued', 'running', 'waiting_approval', 'delivered', 'succeeded', 'failed',
  'cancelled', 'timed_out', 'skipped', 'recovery_needed']);
export const terminalRunStatuses = ['delivered', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'] as const;
export const isTerminalRun = (status: RunStatus) => (terminalRunStatuses as readonly string[]).includes(status);
const safeSummary = z.string().max(8192).refine((value) => !hasCredential(value), 'Summary must be screened');
export const reportMessageSchema = z.strictObject({
  id: automationIdSchema, role: z.literal('user'),
  content: z.array(z.strictObject({ type: z.literal('text'), text: safeSummary })).length(1),
  source: z.strictObject({ kind: z.literal('dsh-bot-delegate'), form: z.literal('notice'),
    summary: z.string().min(1).max(120).refine((value) => !hasCredential(value)),
    runId: automationIdSchema, sourceSessionId: text(256),
  }),
});
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-delegate': { kind: 'dsh-bot-delegate'; form: 'notice'; summary: string; runId: string; sourceSessionId: string };
  }
}
export const runReportSchema = z.strictObject({
  state: z.enum(['pending', 'sent', 'blocked']), originSessionId: text(256),
  messageId: automationIdSchema.optional(), message: reportMessageSchema.optional(), attempts: z.number().int().nonnegative(),
  lastAttemptAt: automationTimeSchema.optional(), durableAt: automationTimeSchema.optional(), reason: text(256).optional(),
}).refine((r) => (r.message === undefined) === (r.messageId === undefined)
  && (r.message === undefined || r.message.id === r.messageId)
  && (r.state !== 'sent' || (r.messageId !== undefined && r.durableAt !== undefined)), 'Incomplete report receipt');
const snapshotSchema = z.strictObject({
  title: text(120), prompt: text(65536), timeZone: timeZoneSchema, presetId: text(256), botUpdatedAt: automationTimeSchema,
});
export const runRecordSchema = z.strictObject({
  id: automationIdSchema, schemaVersion: z.literal(1), revision: revisionSchema, dedupeKey: text(1024),
  trigger: z.enum(['manual', 'delegate']), operationId: automationIdSchema.optional(),
  nativeScheduleId: text(256).optional(),
  botId: botIdSchema, botCreatedAt: automationTimeSchema, snapshot: snapshotSchema,
  requestedAt: automationTimeSchema, admittedAt: automationTimeSchema.optional(), startedAt: automationTimeSchema.optional(),
  endedAt: automationTimeSchema.optional(), updatedAt: automationTimeSchema,
  status: runStatusSchema, step: z.enum(['queued', 'reserved', 'creating', 'submitting', 'executing', 'settled', 'unknown']),
  decision: z.enum(['run', 'skip']), skipReason: text(256).optional(),
  sessionId: text(256), requestId: text(256), workspaceId: text(256).optional(), cwd: text(4096).optional(),
  inputMessageId: text(256).optional(), inputTurn: z.number().int().nonnegative().optional(),
  lastEventSeq: z.number().int().nonnegative().optional(),
  execution: z.strictObject({
    turns: z.array(z.number().int().nonnegative()).max(1024), jobIds: z.array(text(256)).max(1024),
    activationIds: z.array(text(256)).max(1024), childSessionIds: z.array(text(256)).max(1024),
  }).optional(),
  slotHeld: z.boolean(),
  originSessionId: text(256).optional(), originBotId: botIdSchema.optional(), originBotCreatedAt: automationTimeSchema.optional(),
  depth: z.number().int().min(0).max(1),
  summary: safeSummary.optional(), errorCode: text(256).optional(), report: runReportSchema.optional(),
}).superRefine((r, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!r.operationId) bad('Missing operation identity');
  if (r.trigger === 'manual' && !r.nativeScheduleId) bad('Missing native task identity');
  if (r.trigger === 'delegate' && (!r.originSessionId || !r.originBotId || r.originBotCreatedAt === undefined || r.depth !== 1)) bad('Missing delegate provenance');
  if (r.trigger !== 'delegate' && (r.originSessionId || r.originBotId || r.originBotCreatedAt !== undefined)) bad('Unexpected delegate provenance');
  if (r.report?.message && (r.report.message.source.runId !== r.id || r.report.message.source.sourceSessionId !== r.sessionId)) bad('Report message identity mismatch');
  if (r.trigger !== 'delegate' && r.depth !== 0) bad('Invalid routine depth');
  if (r.slotHeld && r.admittedAt === undefined) bad('Execution without admission');
  if (isTerminalRun(r.status) !== (r.endedAt !== undefined) || (isTerminalRun(r.status) && r.slotHeld)) bad('Invalid terminal receipt');
  if (isTerminalRun(r.status) && r.step !== 'settled') bad('Invalid terminal step');
  if (r.status === 'recovery_needed' && r.step !== 'unknown') bad('Invalid recovery step');
  if (['running', 'waiting_approval'].includes(r.status) && ['queued', 'settled', 'unknown'].includes(r.step)) bad('Invalid active step');
  if (r.status === 'queued' && (r.admittedAt !== undefined || r.step !== 'queued')) bad('Queued run already admitted');
  if (['running', 'waiting_approval', 'recovery_needed'].includes(r.status) && !r.slotHeld) bad('Active run without slot');
  if ((r.status === 'skipped') !== (r.decision === 'skip') || (r.status === 'skipped' && (!r.skipReason || r.admittedAt !== undefined))) bad('Invalid skip decision');
  if (r.report && (!isTerminalRun(r.status) || r.trigger !== 'delegate' || r.report.originSessionId !== r.originSessionId)) bad('Invalid report owner');
  if ((r.admittedAt !== undefined && r.admittedAt < r.requestedAt)
    || (r.startedAt !== undefined && (r.admittedAt === undefined || r.startedAt < r.admittedAt))
    || (r.endedAt !== undefined && r.endedAt < (r.startedAt ?? r.admittedAt ?? r.requestedAt))) bad('Invalid event timestamps');
  if (r.updatedAt < r.requestedAt) bad('Invalid run timestamps');
});
export const runListSchema = z.strictObject({ botId: botIdSchema.optional(), nativeScheduleId: text(256).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  before: z.strictObject({ requestedAt: automationTimeSchema, id: automationIdSchema }).optional(),
});
// Old delegate records remain readable, but no new ordinary-session delegate is admitted.
export const runRequestSchema = z.strictObject({ trigger: z.literal('manual'), nativeScheduleId: text(256), operationId: automationIdSchema,
  botId: botIdSchema, botCreatedAt: automationTimeSchema, title: text(120), prompt: text(65536), timeZone: timeZoneSchema });
export type RoutineRule = z.output<typeof routineRuleSchema>;
export type RoutineRecord = z.output<typeof routineRecordSchema>;
export type RoutineCreate = z.input<typeof routineCreateSchema>;
export type RoutinePatch = z.input<typeof routinePatchSchema>;
export type RunRecord = z.output<typeof runRecordSchema>;
export type RunStatus = z.output<typeof runStatusSchema>;
export type RunRequest = z.input<typeof runRequestSchema>;
