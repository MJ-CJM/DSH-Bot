import { z } from 'zod';
import { memoryVersionSchema, randomId, safeCounter, userScopeSchema } from './memory-v2.js';
import { autoSharePolicySchema, quotaChargeSchema } from './data-flow.js';
import { botKeySchema } from './identity.js';

export const opSchema = z.strictObject({
  opId: randomId, seq: safeCounter.positive(),
  kind: z.enum(['propose', 'accept', 'revise', 'supersede', 'dispute', 'resolve', 'promote', 'forget',
    'retire_shard', 'migration', 'policy', 'cleanup']),
  subjectIds: z.array(randomId), payloadRefs: z.array(randomId), expectedRevision: safeCounter,
  forgetEpoch: safeCounter, versions: z.array(memoryVersionSchema), receiptRefs: z.array(randomId),
  owner: botKeySchema.optional(),
  autoPolicy: autoSharePolicySchema.optional(), quotaCharge: quotaChargeSchema.optional(), grantUse: randomId.optional(),
});
export const barrierSchema = z.strictObject({ id: randomId, epoch: safeCounter.positive(), targets: z.array(randomId),
  affectedSessionIds: z.array(z.string()), state: z.enum(['intent', 'stopped', 'cleaning', 'blocked', 'verified']),
  scope: z.enum(['private', 'shared']), previewRevision: safeCounter, receipts: z.array(randomId) });
export const metaSchema = z.strictObject({ scope: userScopeSchema, policyRevision: safeCounter.positive(),
  quotaTimeZone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }) });
export const migrationSchema = z.strictObject({
  id: randomId, sourceSchema: z.literal(1), targetSchema: z.literal(2), sourceDigest: z.string().optional(),
  phase: z.enum(['prepare', 'copy', 'verify', 'cutover', 'legacy-clean', 'done']),
  counts: z.strictObject({ source: safeCounter, copied: safeCounter, quarantined: safeCounter }),
  cutoverSeq: safeCounter, forgetEpoch: safeCounter,
});
export const migrationItemSchema = z.strictObject({ legacyId: z.string(), memoryId: randomId, versionId: randomId,
  opId: randomId, contentRef: randomId, quarantine: z.boolean() });
export const fenceSchema = z.strictObject({ schemaVersion: z.literal(2), kind: z.literal('migration-fence'), migrationId: randomId });
export type MemoryOp = z.output<typeof opSchema>;
export type MemoryBarrier = z.output<typeof barrierSchema>;
export type Migration = z.output<typeof migrationSchema>;
