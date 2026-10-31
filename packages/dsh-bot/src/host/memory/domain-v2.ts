import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { flowRecordSchema, flowSessionSchema } from '../../shared/managed-flow.js';
import { barrierSchema, metaSchema, migrationSchema, opSchema, migrationItemSchema } from '../../shared/memory-ops.js';
import { payloadSchema } from '../../shared/memory-v2.js';
import { forgetJobSchema } from '../../shared/memory-forget.js';

export const memoryDomain = defineDomain({ name: 'dsh_bot_memory', version: 2, layout: 'per-record', tables: {
  layout: domainTable(z.strictObject({ phase: z.enum(['copied', 'ready']) })),
  meta: domainTable(metaSchema), ops: domainTable(opSchema), payloads: domainTable(payloadSchema),
  // Disposable cache rows cannot prevent recovery of a valid authoritative log.
  projections: domainTable(z.unknown()), barriers: domainTable(barrierSchema),
  receipts: domainTable(z.strictObject({ id: z.uuid(), epoch: z.number().int().nonnegative(),
    sessionId: z.string(), versionIds: z.array(z.uuid()), state: z.enum(['read', 'blocked', 'verified']) })),
  migration: domainTable(migrationSchema), migration_items: domainTable(migrationItemSchema),
  forget_jobs: domainTable(forgetJobSchema),
  flows: domainTable(flowRecordSchema), flow_sessions: domainTable(flowSessionSchema),
} });
export type MemoryDomain = Domain<Omit<typeof memoryDomain, 'layout'>>;
