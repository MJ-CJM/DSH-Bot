import { z } from 'zod';
import { botKeySchema, sameBot } from './identity.js';
import { memoryFields, timestampSchema } from './schema.js';
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
  parentVersionId: randomId.optional(), entryReceiptId: randomId.optional(),
});
export const labelSchema = z.strictObject({
  readers: z.union([z.literal('shared'), z.array(botKeySchema)]),
  originTrust: z.enum(['candidate', 'user_stated', 'user_confirmed']),
  sourceVersions: z.array(randomId), restrictions: z.array(z.enum(['secret', 'no-egress', 'pending-cleanup', 'revoked'])),
  grants: z.array(randomId),
});
export const payloadSchema = z.strictObject({
  content: memoryFields.shape.content,
  subject: z.string().optional(), factKey: z.string().optional(), qualifiers: z.record(z.string(), z.string()).optional(),
  valid: validitySchema,
  sourceExcerpt: z.string().optional(), confirmation: z.string().optional(),
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
  z.strictObject({ ...versionFields, scope: z.literal('shared'), shard: z.literal('user') })
    .refine(v => v.kind === 'user_fact' || v.kind === 'user_event', 'Role and work memories must be private'),
]);
/** Model/UI input never includes Host identity, trust, epoch or operation sequence. */
export const privateMemoryInputSchema = z.strictObject({ content: memoryFields.shape.content,
  kind: memoryFields.shape.kind.optional(), tags: memoryFields.shape.tags.optional(), pinned: z.boolean().optional() });
export type MemoryVersion = z.output<typeof memoryVersionSchema>;
export type MemoryPayload = z.output<typeof payloadSchema>;
export type UserScope = z.output<typeof userScopeSchema>;
