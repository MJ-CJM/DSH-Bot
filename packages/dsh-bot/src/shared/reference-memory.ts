import { z } from 'zod';
import { botKeySchema, p34Id } from './p34.js';
import { memorySchema } from './schema.js';
export const REFERENCE_VERSION = '2026.7.4';
export const REFERENCE_SOURCE = '6dd0a683e198783e30feabf7abaf42f925bd18b1';
export const GRAPH_NAMESPACE = 'bot_memory_graph';
export const GRAPH_PREFIX = `mcp__${GRAPH_NAMESPACE}__`;
export const graphEntitySchema = z.strictObject({
  name: z.string().min(1).max(240),
  entityType: z.string().min(1).max(120),
  observations: z.array(z.string().max(32768)).max(1000),
});
export const graphSchema = z.strictObject({
  entities: z.array(graphEntitySchema).max(10000),
  relations: z
    .array(
      z.strictObject({
        from: z.string(),
        to: z.string(),
        relationType: z.string(),
      }),
    )
    .max(10000),
});
export const graphToolSchema = z.discriminatedUnion('tool', [
  z.strictObject({
    tool: z.literal('read_graph'),
    arguments: z.strictObject({}),
  }),
  z.strictObject({
    tool: z.literal('search_nodes'),
    arguments: z.strictObject({ query: z.string().max(1024) }),
  }),
  z.strictObject({
    tool: z.literal('create_entities'),
    arguments: z.strictObject({
      entities: z.array(graphEntitySchema).min(1).max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('delete_entities'),
    arguments: z.strictObject({
      entityNames: z.array(z.string().max(240)).min(1).max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('open_nodes'),
    arguments: z.strictObject({
      names: z.array(z.string().max(240)).min(1).max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('create_relations'),
    arguments: z.strictObject({
      relations: graphSchema.shape.relations.min(1).max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('delete_relations'),
    arguments: z.strictObject({
      relations: graphSchema.shape.relations.min(1).max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('add_observations'),
    arguments: z.strictObject({
      observations: z
        .array(
          z.strictObject({
            entityName: z.string().max(240),
            observations: z.array(z.string().max(32768)).min(1).max(100),
          }),
        )
        .min(1)
        .max(100),
    }),
  }),
  z.strictObject({
    tool: z.literal('delete_observations'),
    arguments: z.strictObject({
      deletions: z
        .array(
          z.strictObject({
            entityName: z.string().max(240),
            observations: z.array(z.string().max(32768)).min(1).max(100),
          }),
        )
        .min(1)
        .max(100),
    }),
  }),
]);
export const memoryEnvelopeSchema = z.strictObject({
  format: z.literal('dsh-bot-memory-record'),
  version: z.literal(1),
  bot: botKeySchema,
  record: memorySchema,
  recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const graphBindingSchema = z.strictObject({
  bot: botKeySchema,
  mode: z.enum(['internal', 'internal+reference-graph']),
  provider: z.literal('mcp-reference'),
  packageVersion: z.literal(REFERENCE_VERSION),
  sourceCommit: z.literal(REFERENCE_SOURCE),
  fileIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.literal('main-only'),
  revision: z.number().int().positive(),
  importId: p34Id.optional(),
});
export type GraphBinding = z.output<typeof graphBindingSchema>;
export const copyReceiptSchema = z.strictObject({
  id: p34Id,
  bot: botKeySchema,
  sourceDigest: z.string(),
  targetFileIdentity: z.string(),
  previousFileIdentity: z.string(),
  bindingRevision: z.number().int(),
  phase: z.enum(['preview', 'staging', 'verified', 'committed', 'failed', 'rolled-back']),
  records: z.array(
    z.strictObject({
      memoryId: z.string(),
      digest: z.string(),
      targetEntityName: z.string(),
      status: z.enum(['pending', 'written', 'verified']),
    }),
  ),
  startedAt: z.number(),
  verifiedAt: z.number().optional(),
  committedAt: z.number().optional(),
});
export type CopyReceipt = z.output<typeof copyReceiptSchema>;
export const graphStatusSchema = z.strictObject({
  bot: botKeySchema,
  binding: graphBindingSchema.optional(),
  state: z.enum(['internal', 'pending', 'ready', 'unavailable']),
  reason: z
    .enum([
      'main-only',
      'busy',
      'unsupported',
      'writer-conflict',
      'invalid-file',
      'initialization-failed',
      'stopping',
      'copy-in-progress',
    ])
    .optional(),
  toolCount: z.number().int().nonnegative(),
  writer: z.boolean(),
  copies: z.array(copyReceiptSchema),
});
export type GraphStatus = z.output<typeof graphStatusSchema>;
export const graphRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), bot: botKeySchema }),
  z.strictObject({
    action: z.literal('configure'),
    bot: botKeySchema,
    mode: graphBindingSchema.shape.mode,
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.strictObject({ action: z.literal('apply'), bot: botKeySchema }),
  z.strictObject({
    action: z.literal('tool'),
    bot: botKeySchema,
    call: graphToolSchema,
  }),
  z.strictObject({ action: z.literal('preview'), bot: botKeySchema }),
  z.strictObject({
    action: z.literal('stage'),
    bot: botKeySchema,
    copyId: p34Id,
  }),
  z.strictObject({
    action: z.literal('commit'),
    bot: botKeySchema,
    copyId: p34Id,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    action: z.literal('rollback'),
    bot: botKeySchema,
    copyId: p34Id,
    confirmed: z.literal(true),
  }),
  z.strictObject({
    action: z.literal('cancel'),
    bot: botKeySchema,
    copyId: p34Id,
    confirmed: z.literal(true),
  }),
]);
export const graphResultSchema = z.strictObject({
  status: graphStatusSchema,
  graph: graphSchema.optional(),
  copy: copyReceiptSchema.optional(),
});
