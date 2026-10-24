import { z } from 'zod';
import { botKeySchema, p34Id } from './p34.js';
import { botRecordFields } from './schema.js';
export const GROUP_ROOT_PRESET = 'dsh-bot-group-root';
export const GROUP_TEXT_MAX_BYTES = 65536;
export const GROUP_TIMELINE_LIMIT = 200;
const rev = z.number().int().positive();
export const groupKeySchema = z.strictObject({ groupId: p34Id, groupCreatedAt: z.number().nonnegative() });
export const groupModeSchema = z.enum(['mention', 'round-robin']);
const name = botRecordFields.shape.name;
export const groupRecordSchema = z.strictObject({
  id: p34Id, operationId: p34Id, createDigest: z.string(), createdAt: z.number(), updatedAt: z.number(), schemaVersion: z.literal(1),
  name, rootSessionId: z.string().min(1), rootPresetId: z.literal(GROUP_ROOT_PRESET), cwd: z.string(),
  mode: groupModeSchema, nextMemberId: p34Id.optional(), membershipRevision: rev, revision: rev, archived: z.boolean(),
  state: z.enum(['creating', 'ready', 'recovery_needed']),
});
export const groupMemberSchema = z.strictObject({
  id: p34Id, group: groupKeySchema, bot: botKeySchema, order: z.number().int().nonnegative(), joinedAt: z.number(), removedAt: z.number().optional(), enabled: z.boolean(),
});
export const groupTurnSchema = z.strictObject({
  id: p34Id, group: groupKeySchema, operationId: p34Id, requestDigest: z.string(), inputMessageId: z.string(), inputSeq: z.number().int().nonnegative().optional(),
  createdAt: z.number(), updatedAt: z.number(), revision: rev, schemaVersion: z.literal(1),
  membershipRevision: rev, orderedMemberIds: z.array(p34Id), mode: groupModeSchema, contextThroughSeq: z.number().int(),
  state: z.enum(['accepted', 'running', 'completed', 'partial', 'cancelled', 'recovery_needed']),
});
export const groupDeliverySchema = z.strictObject({
  id: p34Id, turnId: p34Id, memberId: p34Id, ordinal: z.number().int().nonnegative(), bot: botKeySchema, botRevision: z.number(), presetId: z.string(),
  contextOutputMessageIds: z.array(z.string()), contextTruncated: z.boolean(),
  state: z.enum(['pending', 'starting', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  childSessionId: z.string().optional(), outputMessageId: z.string().optional(), outputSeq: z.number().int().optional(), stopReason: z.string().optional(), reasonCode: z.string().optional(),
});
export const groupCreateSchema = z.strictObject({ operationId: p34Id, name, members: z.array(botKeySchema).min(2).max(16), mode: groupModeSchema, cwd: z.string().min(1).optional(), historyConfirmed: z.literal(true) });
export const groupEditSchema = z.strictObject({ expectedRevision: rev, expectedMembershipRevision: rev, name, mode: groupModeSchema, members: z.array(botKeySchema).min(2).max(16), historyConfirmed: z.literal(true) });
export const groupSendSchema = z.strictObject({
  operationId: p34Id, expectedMembershipRevision: rev,
  text: z.string().trim().min(1).refine(s => new TextEncoder().encode(s).length <= GROUP_TEXT_MAX_BYTES),
  memberIds: z.array(p34Id).max(16).default([]), round: z.boolean().default(false),
});
export const speakerSchema = z.strictObject({ bot: botKeySchema, name, avatar: botRecordFields.shape.avatar, avatarColor: botRecordFields.shape.avatarColor, avatarVariant: botRecordFields.shape.avatarVariant });
export const groupMessageSchema = z.strictObject({ id: z.string(), seq: z.number().int(), at: z.number(), text: z.string(), hasNonText: z.boolean().optional(), turnId: z.string(), speaker: speakerSchema.optional(), childSessionId: z.string().optional(), stopReason: z.string().optional() });
export const groupReadSchema = z.strictObject({ id: p34Id, group: groupKeySchema, throughSeq: z.number().int(), revision: rev, createdAt: z.number(), updatedAt: z.number(), schemaVersion: z.literal(1) });
export const groupSummarySchema = z.strictObject({ latest: z.strictObject({ seq: z.number().int(), at: z.number(), speaker: speakerSchema.optional() }).optional(), unread: z.boolean().default(false), readRevision: z.number().int().nonnegative().default(0), group: groupRecordSchema, members: z.array(groupMemberSchema), unavailableMemberIds: z.array(z.string()), running: z.boolean(), reason: z.enum(['root-owned-elsewhere', 'root-unavailable', 'recovery-needed']).optional() });
export const groupViewSchema = groupSummarySchema.extend({ turns: z.array(groupTurnSchema), deliveries: z.array(groupDeliverySchema), messages: z.array(groupMessageSchema), hasEarlier: z.boolean() });
export const groupPageSchema = z.strictObject({ beforeSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(GROUP_TIMELINE_LIMIT).default(100) });
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
