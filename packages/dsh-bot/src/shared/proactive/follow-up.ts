import { z } from 'zod';
import { groupKeySchema } from '../groups.js';
import { botKeySchema, resourceId } from '../identity.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(512);
const summary = z.string().trim().min(1).max(500);
const payloadDigest = z.string().regex(/^[a-f0-9]{64}$/);

export const subjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('bot'), bot: botKeySchema }),
  z.strictObject({ kind: z.literal('group'), group: groupKeySchema }),
]);
export type Subject = z.output<typeof subjectSchema>;

export function subjectKey(subject: Subject) {
  return JSON.stringify(subject.kind === 'bot'
    ? ['bot', subject.bot.botId, subject.bot.botCreatedAt]
    : ['group', subject.group.groupId, subject.group.groupCreatedAt]);
}

export const followUpPolicySchema = z.strictObject({
  subject: subjectSchema,
  revision,
  pauseEpoch: revision,
  localEnabled: z.boolean(),
  legacyCi: z.enum(['inherit', 'denied']),
  observationStart: revision.nullable(),
});
export type FollowUpPolicy = z.output<typeof followUpPolicySchema>;

const policyChange = { subject: subjectSchema, expectedRevision: revision };
export const followUpPolicyChangeSchema = z.strictObject({
  ...policyChange,
  action: z.enum(['enable-local', 'pause']),
});
export const followUpBootstrapSchema = z.strictObject({
  ...policyChange,
  expectedRevision: revision.nullable(),
  kind: z.literal('enable-local'),
  operationId: z.uuid(),
  configEpoch: z.uuid(),
});
export type FollowUpBootstrap = z.output<typeof followUpBootstrapSchema>;

const localOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('work'), ticketId: resourceId, assignmentId: resourceId }),
  z.strictObject({ kind: z.literal('delegate'), runId: resourceId, sessionId: resourceId.optional() }),
  z.strictObject({ kind: z.literal('native-subagent'), sessionId: resourceId, childSessionId: resourceId, turn: revision }),
  z.strictObject({ kind: z.literal('team-task'), teamId: resourceId, taskId: resourceId, sessionId: resourceId.optional() }),
  z.strictObject({ kind: z.literal('group-turn'), turnId: resourceId }),
]);
export const followUpOriginSchema = z.discriminatedUnion('kind', [
  ...localOriginSchema.options,
  z.strictObject({ kind: z.literal('watch'), watchId: resourceId }),
]);
export type FollowUpOrigin = z.output<typeof followUpOriginSchema>;

export const followUpWaitSchema = z.strictObject({
  reason: summary,
  request: summary,
  deadlineAt: z.iso.datetime().optional(),
});

const approvalPending = z.strictObject({
  kind: z.literal('approval-pending'), completion: summary, wait: followUpWaitSchema.optional(),
});

const activeCondition = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('needs-review') }),
  z.strictObject({
    kind: z.literal('failed'),
    reason: summary.optional(),
    members: z.array(z.strictObject({ deliveryId: resourceId, memberId: resourceId, reason: summary })).max(16).optional(),
  }),
  z.strictObject({ kind: z.literal('waiting-input'), wait: followUpWaitSchema }),
  z.strictObject({ kind: z.literal('tracking'), completion: summary.optional() }),
]);
const conditionSchema = z.union([activeCondition, z.strictObject({
  kind: z.literal('closed'), reason: z.enum(['cancelled', 'completed', 'resolved']),
})]);

export const followUpFactSchema = z.strictObject({
  nativeId: resourceId,
  nativeRevision: revision,
  occurredAt: z.iso.datetime(),
  current: z.literal(true).optional(),
  payloadDigest,
  origin: followUpOriginSchema,
  title: summary,
  condition: conditionSchema,
});
export type FollowUpFact = z.output<typeof followUpFactSchema>;

export const maxFollowUpFactBatchBytes = 96 * 1024;

export const followUpIngestSchema = z.strictObject({
  kind: z.literal('local-task-state/v1'),
  subject: subjectSchema,
  sourceId: resourceId,
  sourceGeneration: revision,
  pauseEpoch: revision,
  expectedCursor: cursor.nullable(),
  nextCursor: cursor.nullable(),
  facts: z.array(followUpFactSchema.extend({ origin: localOriginSchema })).max(16)
    .refine(facts => new TextEncoder().encode(JSON.stringify(facts)).byteLength <= maxFollowUpFactBatchBytes),
});
export type FollowUpIngest = z.output<typeof followUpIngestSchema>;

const watchDraft = z.strictObject({
  title: summary,
  completion: summary,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('manual') }),
    z.strictObject({ kind: z.literal('message'), sessionId: resourceId, messageId: resourceId, confirmationId: resourceId }),
  ]),
  wait: followUpWaitSchema.optional(),
});
const groupProposalSource = z.strictObject({
  kind: z.literal('group-proposal'), sessionId: resourceId, messageId: resourceId,
  workerSessionId: resourceId, toolCallId: z.string().min(1).max(512),
});
export const followUpWatchSchema = watchDraft.extend({
  kind: z.literal('explicit-watch/v1'), id: resourceId, subject: subjectSchema, revision,
  source: z.union([watchDraft.shape.source, groupProposalSource.extend({ confirmationId: resourceId.optional() })]),
  state: z.enum(['pending', 'active', 'stopped', 'completed']),
});
export type FollowUpWatch = z.output<typeof followUpWatchSchema>;
export const followUpWatchCreateSchema = z.strictObject({
  subject: subjectSchema,
  expectedRevision: revision,
  id: resourceId,
  watch: watchDraft,
});
export const followUpGroupWatchProposalSchema = followUpWatchCreateSchema.extend({
  subject: z.strictObject({ kind: z.literal('group'), group: groupKeySchema }),
  watch: watchDraft.extend({ source: groupProposalSource }),
});
export const followUpWatchUpdateSchema = z.strictObject({
  subject: subjectSchema,
  cardId: resourceId,
  expectedRevision: revision,
  expectedPolicyRevision: revision,
  watch: watchDraft,
});
export const followUpActionSchema = z.strictObject({
  subject: subjectSchema,
  cardId: resourceId,
  expectedRevision: revision,
  expectedPolicyRevision: revision,
  action: z.enum(['ignore', 'stop', 'complete', 'forget', 'confirm-watch']),
});
export const followUpCardSchema = z.strictObject({
  id: resourceId,
  decisionId: resourceId,
  subject: subjectSchema,
  origin: followUpOriginSchema,
  revision,
  observedAt: z.iso.datetime(),
  title: summary,
  condition: z.union([conditionSchema, approvalPending]),
  state: z.enum(['open', 'ignored', 'stopped', 'closed']),
});
export type FollowUpCard = z.output<typeof followUpCardSchema>;

export const followUpPageRequestSchema = z.strictObject({
  subject: subjectSchema,
  cursor: z.string().min(1).max(2048).optional(),
});
export const followUpPageSchema = z.strictObject({
  rows: z.array(followUpCardSchema).max(20),
  next: followUpPageRequestSchema.shape.cursor,
});
export const followUpSubjectsSchema = z.strictObject({
  rows: z.array(followUpPolicySchema).max(20),
  next: followUpPageRequestSchema.shape.cursor,
});
export const followUpSourceRequestSchema = followUpIngestSchema.pick({ subject: true, sourceId: true, sourceGeneration: true });
export const followUpSourceCursorSchema = cursor.nullable();
export const followUpSummarySchema = z.strictObject({
  policy: followUpPolicySchema,
  legacyCiActive: z.boolean(),
  rows: z.array(followUpCardSchema).max(3),
});

export type FollowUpPolicyChange = z.output<typeof followUpPolicyChangeSchema>;
export type FollowUpWatchCreate = z.output<typeof followUpWatchCreateSchema>;
export type FollowUpGroupWatchProposal = z.output<typeof followUpGroupWatchProposalSchema>;
export type FollowUpWatchUpdate = z.output<typeof followUpWatchUpdateSchema>;
export type FollowUpAction = z.output<typeof followUpActionSchema>;
export type FollowUpPageRequest = z.output<typeof followUpPageRequestSchema>;
export type FollowUpSummary = z.output<typeof followUpSummarySchema>;
export type FollowUpSourceRequest = z.output<typeof followUpSourceRequestSchema>;
