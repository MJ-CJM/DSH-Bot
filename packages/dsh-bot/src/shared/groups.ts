import { z } from 'zod';
import { botKeySchema, resourceId } from './integrations.js';
import { botRecordFields } from './schema.js';
export const GROUP_ROOT_PRESET = 'dsh-bot-group-root';
export const GROUP_TEXT_MAX_BYTES = 65536;
export const GROUP_TIMELINE_LIMIT = 200;
const rev = z.number().int().positive();
export const groupKeySchema = z.strictObject({ groupId: resourceId, groupCreatedAt: z.number().nonnegative() });
export const groupModeSchema = z.enum(['natural', 'mention', 'round-robin']);
/** A group override is optional; absent records preserve each Bot's model defaults. */
export const groupModelSelectionSchema = z.strictObject({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
});
export const groupMemberModelSelectionsSchema = z.array(z.strictObject({
  memberId: resourceId,
  modelSelection: groupModelSelectionSchema,
})).max(16).refine(rows => new Set(rows.map(row => row.memberId)).size === rows.length);
export const groupSetModelSchema = z.strictObject({
  expectedModelRevision: z.number().int().nonnegative(),
  memberId: resourceId.optional(),
  modelSelection: groupModelSelectionSchema.nullable(),
});
const name = botRecordFields.shape.name;
export const groupRecordSchema = z.strictObject({
  id: resourceId,
  operationId: resourceId,
  createDigest: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  schemaVersion: z.literal(1),
  name,
  rootSessionId: z.string().min(1),
  rootPresetId: z.literal(GROUP_ROOT_PRESET),
  cwd: z.string(),
  mode: groupModeSchema,
  modelSelection: groupModelSelectionSchema.optional(),
  memberModelSelections: groupMemberModelSelectionsSchema.optional(),
  modelRevision: z.number().int().nonnegative().optional(),
  nextMemberId: resourceId.optional(),
  membershipRevision: rev,
  revision: rev,
  archived: z.boolean(),
  state: z.enum(['creating', 'ready', 'recovery_needed']),
});
export const groupMemberSchema = z.strictObject({
  id: resourceId,
  group: groupKeySchema,
  bot: botKeySchema,
  order: z.number().int().nonnegative(),
  joinedAt: z.number(),
  removedAt: z.number().optional(),
  enabled: z.boolean(),
});
export const groupTurnSchema = z.strictObject({
  id: resourceId,
  group: groupKeySchema,
  operationId: resourceId,
  requestDigest: z.string(),
  inputMessageId: z.string(),
  inputSeq: z.number().int().nonnegative().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: rev,
  schemaVersion: z.literal(1),
  membershipRevision: rev,
  orderedMemberIds: z.array(resourceId),
  mode: groupModeSchema,
  contextThroughSeq: z.number().int(),
  modelSelection: groupModelSelectionSchema.optional(),
  memberModelSelections: groupMemberModelSelectionsSchema.optional(),
  predecessorTurnIds: z.array(resourceId).optional(),
  followups: z.array(z.strictObject({
    operationId: resourceId, requestDigest: z.string(), deliveryId: resourceId,
    messageId: z.string(), childMessageId: z.string().optional(),
    state: z.enum(['dispatching', 'accepted', 'unknown']),
  })).optional(),
  replyTo: z.string().optional(),
  state: z.enum(['accepted', 'running', 'completed', 'partial', 'cancelled', 'recovery_needed']),
});
export const groupDeliverySchema = z.strictObject({
  id: resourceId,
  turnId: resourceId,
  memberId: resourceId,
  ordinal: z.number().int().nonnegative(),
  bot: botKeySchema,
  botRevision: z.number(),
  presetId: z.string(),
  contextOutputMessageIds: z.array(z.string()),
  contextTruncated: z.boolean(),
  state: z.enum(['pending', 'starting', 'running', 'completed', 'skipped', 'failed', 'cancelled', 'unknown']),
  childSessionId: z.string().optional(),
  triggerMessageId: z.string().optional(),
  returnMemberId: resourceId.optional(),
  requestDigest: z.string().optional(),
  skipped: z.boolean().optional(),
  outputMessageId: z.string().optional(),
  outputSeq: z.number().int().optional(),
  stopReason: z.string().optional(),
  reasonCode: z.string().optional(),
});
export const groupCreateSchema = z.strictObject({
  operationId: resourceId,
  name,
  members: z.array(botKeySchema).min(2).max(16),
  mode: groupModeSchema,
  cwd: z.string().min(1).optional(),
  historyConfirmed: z.literal(true),
});
export const groupEditSchema = z.strictObject({
  expectedRevision: rev,
  expectedMembershipRevision: rev,
  name,
  mode: groupModeSchema,
  members: z.array(botKeySchema).min(2).max(16),
  historyConfirmed: z.literal(true),
});
export const groupSendSchema = z.strictObject({
  operationId: resourceId,
  expectedMembershipRevision: rev,
  text: z
    .string()
    .trim()
    .refine((s) => new TextEncoder().encode(s).length <= GROUP_TEXT_MAX_BYTES)
    .default(''),
  fileReceiptIds: z.array(z.string().min(1)).max(16).default([]),
  memberIds: z.array(resourceId).max(16).default([]),
  round: z.boolean().default(false),
  followup: z.strictObject({ turnId: resourceId, deliveryId: resourceId }).optional(),
  replyTo: z.string().min(1).optional(),
}).refine(input => Boolean(input.text) || input.fileReceiptIds.length > 0);
export const speakerSchema = z.strictObject({
  bot: botKeySchema,
  name,
  avatar: botRecordFields.shape.avatar,
  avatarColor: botRecordFields.shape.avatarColor,
  avatarVariant: botRecordFields.shape.avatarVariant,
});
const dimensions = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });
export const groupAttachmentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('file'), attachment: z.strictObject({ attachmentId: z.string().min(1), name: z.string(), bytes: z.number().int().nonnegative() }) }),
  z.strictObject({ type: z.literal('image'), attachment: z.strictObject({ attachmentId: z.string().min(1),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional(), originalDimensions: dimensions.optional() }), offloaded: z.literal(true).optional() }),
]);
export type GroupAttachment = z.output<typeof groupAttachmentSchema>;
export const groupMessageSchema = z.strictObject({
  id: z.string(),
  seq: z.number().int(),
  at: z.number(),
  text: z.string(),
  hasNonText: z.boolean().optional(),
  attachments: z.array(groupAttachmentSchema).optional(),
  turnId: z.string(),
  replyTo: z.string().optional(),
  authorKind: z.enum(['user', 'bot']).optional(),
  causeId: z.string().optional(),
  speaker: speakerSchema.optional(),
  childSessionId: z.string().optional(),
  stopReason: z.string().optional(),
});
export const groupReadSchema = z.strictObject({
  id: resourceId,
  group: groupKeySchema,
  throughSeq: z.number().int(),
  revision: rev,
  createdAt: z.number(),
  updatedAt: z.number(),
  schemaVersion: z.literal(1),
});
export const groupSummarySchema = z.strictObject({
  latest: z.strictObject({ seq: z.number().int(), at: z.number(), speaker: speakerSchema.optional() }).optional(),
  unread: z.boolean().default(false),
  readRevision: z.number().int().nonnegative().default(0),
  group: groupRecordSchema,
  members: z.array(groupMemberSchema),
  unavailableMemberIds: z.array(z.string()),
  running: z.boolean(),
  reason: z.enum(['root-owned-elsewhere', 'root-unavailable', 'recovery-needed']).optional(),
});
export const groupViewSchema = groupSummarySchema.extend({
  turns: z.array(groupTurnSchema),
  deliveries: z.array(groupDeliverySchema),
  messages: z.array(groupMessageSchema),
  hasEarlier: z.boolean(),
});
export const groupPageSchema = z.strictObject({
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(GROUP_TIMELINE_LIMIT).default(100),
});
export type GroupModelSelection = z.output<typeof groupModelSelectionSchema>;
export type GroupSetModel = z.input<typeof groupSetModelSchema>;
export type GroupKey = z.output<typeof groupKeySchema>;
export type GroupRecord = z.output<typeof groupRecordSchema>;
export type GroupMember = z.output<typeof groupMemberSchema>;
export type GroupTurn = z.output<typeof groupTurnSchema>;
export type GroupDelivery = z.output<typeof groupDeliverySchema>;
export type GroupMessage = z.output<typeof groupMessageSchema>;
export type GroupView = z.output<typeof groupViewSchema>;
export type GroupSummary = z.output<typeof groupSummarySchema>;
export type GroupCreate = z.input<typeof groupCreateSchema>;
export type GroupEdit = z.input<typeof groupEditSchema>;
export type GroupSend = z.input<typeof groupSendSchema>;
export type GroupSpeaker = z.output<typeof speakerSchema>;
export const groupKey = (g: GroupRecord): GroupKey => ({ groupId: g.id, groupCreatedAt: g.createdAt });
