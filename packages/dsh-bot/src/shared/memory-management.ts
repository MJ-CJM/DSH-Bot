import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { payloadSchema, memoryVersionSchema, safeCounter, randomId } from './memory-v2.js';

const fields = payloadSchema.omit({ legacy: true, sourceExcerpt: true, confirmation: true, botSnapshot: true });
export const memoryQuerySchema = z.strictObject({
  botId: botIdSchema, scope: z.enum(['private', 'shared', 'quarantine']),
  view: z.enum(['facts', 'journal', 'candidates', 'conflicts', 'all']),
  query: z.string().max(2048).optional(), cursor: randomId.optional(), revision: safeCounter.optional(),
  at: safeCounter.optional(), recordedBefore: safeCounter.optional(), commitBefore: safeCounter.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const memoryCreateSchema = fields.extend({
  botId: botIdSchema, scope: z.enum(['private', 'shared']),
  kind: z.enum(['user_fact', 'user_event', 'bot_role', 'how_to_work']), expectedRevision: safeCounter,
});
export const memoryReviseSchema = z.strictObject({ id: randomId, expectedRevision: safeCounter, patch: fields.partial() });
export const memoryConfirmSchema = z.strictObject({ id: randomId, expectedRevision: safeCounter,
  scope: z.enum(['private', 'shared']), botId: botIdSchema });
export const memoryResolveSchema = z.strictObject({
  ids: z.array(randomId).min(1).max(50).refine(ids => new Set(ids).size === ids.length), expectedRevision: safeCounter,
  choice: z.enum(['select', 'coexist', 'reject']), selected: randomId.optional(),
  qualifiers: z.array(z.strictObject({ id: randomId,
    values: z.record(z.string().trim().min(1).max(64), z.string().trim().min(1).max(200)) })).optional(),
}).superRefine((v, ctx) => {
  if (v.choice === 'select' && (!v.selected || !v.ids.includes(v.selected))) ctx.addIssue({ code: 'custom', message: 'Select a target' });
  if (v.choice === 'coexist' && (!v.qualifiers || v.qualifiers.length !== v.ids.length ||
    new Set(v.qualifiers.map(q => q.id)).size !== v.ids.length || v.qualifiers.some(q => !v.ids.includes(q.id) || !Object.keys(q.values).length)))
    ctx.addIssue({ code: 'custom', message: 'Every target needs explicit qualifiers' });
});
export const memoryRowSchema = z.strictObject({ version: memoryVersionSchema, payload: payloadSchema,
  state: z.enum([
    'proposed', 'active', 'disputed', 'superseded', 'expired', 'rejected', 'forgotten']),
  supersededBy: randomId.optional(), deletedBot: z.boolean(),
});
export const memoryPageSchema = z.strictObject({ revision: safeCounter, rows: z.array(memoryRowSchema),
  next: randomId.optional(), total: safeCounter });
export type MemoryQuery = z.input<typeof memoryQuerySchema>;
export type MemoryCreate = z.input<typeof memoryCreateSchema>;
export type MemoryRevise = z.input<typeof memoryReviseSchema>;
export type MemoryConfirm = z.input<typeof memoryConfirmSchema>;
export type MemoryResolve = z.input<typeof memoryResolveSchema>;
export type ManagedMemoryRow = z.output<typeof memoryRowSchema>;
export type ManagedMemoryPage = z.output<typeof memoryPageSchema>;
