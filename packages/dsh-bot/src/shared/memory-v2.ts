import { z } from 'zod';
import { botKeySchema, sameBot } from './identity.js';
import { memoryFields, timestampSchema, avatarSchema, avatarColorSchema, avatarVariantSchema } from './schema.js';
import { memoryIdSchema, botIdSchema } from './ids.js';

export const safeCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const randomId = z.uuid();
export const userScopeSchema = z.strictObject({ id: randomId, createdAt: safeCounter });
export const validitySchema = z.strictObject({
  from: safeCounter.nullable(), to: safeCounter.nullable(),
  basis: z.enum(['explicit', 'message-default', 'unknown']),
}).refine(v => v.from === null || v.to === null || v.from < v.to, 'Empty validity interval');
export const sourceRefSchema = z.strictObject({
  sessionId: z.string().optional(), eventSeq: safeCounter.optional(), callId: z.string().optional(),
  parentVersionId: randomId.optional(), entryReceiptId: randomId.optional(), managementOpId: randomId.optional(),
});
export { dataLabelSchema as labelSchema } from './data-flow.js';
import { dataLabelSchema as labelSchema } from './data-flow.js';
export const payloadSchema = z.strictObject({
  content: memoryFields.shape.content,
  subject: z.string().optional(), factKey: z.string().optional(), qualifiers: z.record(z.string(), z.string()).optional(),
  valid: validitySchema,
  sourceExcerpt: z.string().optional(), confirmation: z.string().optional(),
  localException: z.boolean().optional(),
  botSnapshot: z.strictObject({ name: z.string(), avatar: avatarSchema.optional(),
    avatarColor: avatarColorSchema.optional(), avatarVariant: avatarVariantSchema.optional() }).optional(),
  legacy: memoryFields.omit({ content: true }).extend({ id: memoryIdSchema, botId: botIdSchema,
    createdAt: timestampSchema, updatedAt: timestampSchema }).optional(),
});
const versionFields = {
  schemaVersion: z.literal(2), memoryId: randomId, versionId: randomId,
  userScope: randomId, contentRef: randomId, revision: safeCounter.positive(), commitSeq: safeCounter.positive(),
  kind: z.enum(['user_fact', 'user_event', 'bot_role', 'how_to_work']),
  legacyKind: memoryFields.shape.kind.optional(), recordedAt: safeCounter,
  sourceRefs: z.array(sourceRefSchema),
  provenance: z.strictObject({ channel: z.enum(['legacy', 'management', 'model']), bot: botKeySchema }),
  trust: z.enum(['candidate', 'user_stated', 'user_confirmed']),
  status: z.enum(['proposed', 'active', 'disputed', 'superseded', 'expired', 'rejected', 'forgotten']),
  labels: labelSchema,
};
export const memoryVersionSchema = z.union([
  z.strictObject({ ...versionFields, scope: z.literal('private'), ownerBotKey: botKeySchema, shard: botKeySchema })
    .refine(v => sameBot(v.ownerBotKey, v.shard) && v.labels.readers !== 'shared' &&
      v.labels.readers.every(reader => sameBot(reader, v.ownerBotKey)), 'Private ownership/readers mismatch'),
  z.strictObject({ ...versionFields, scope: z.literal('shared'), shard: z.union([z.literal('user'), botKeySchema]) })
    .refine(v => (v.kind === 'user_fact' || v.kind === 'user_event') && v.labels.readers === 'shared',
      'Shared facts/events require shared readers'),
]);
/** Model/UI input never includes Host identity, trust, epoch or operation sequence. */
export const privateMemoryInputSchema = z.strictObject({ content: memoryFields.shape.content,
  kind: memoryFields.shape.kind.optional(), tags: memoryFields.shape.tags.optional(), pinned: z.boolean().optional() });
export type MemoryVersion = z.output<typeof memoryVersionSchema>;
export type MemoryPayload = z.output<typeof payloadSchema>;
export type UserScope = z.output<typeof userScopeSchema>;
