import { z } from 'zod';
import { randomId, safeCounter } from './memory-v2.js';

export const forgetSelectionSchema = z.strictObject({ memoryId: randomId, mode: z.enum(['version', 'related']) });
export const forgetPreviewSchema = z.strictObject({
  previewRevision: randomId, memoryId: randomId, mode: forgetSelectionSchema.shape.mode,
  revision: safeCounter, targets: z.array(randomId), sessionIds: z.array(z.string()),
  affectedBots: safeCounter.optional(), derivatives: safeCounter.optional(),
  versions: safeCounter, historyNodes: safeCounter, summaries: safeCounter,
  copies: safeCounter, pendingMessages: safeCounter, conservative: z.boolean(), rootInstructions: z.boolean(),
});
export const forgetChoiceSchema = z.strictObject({
  previewRevision: randomId, choice: z.enum(['stop', 'clean']),
});
export const cleanupReasonSchema = z.enum(['history', 'system-head', 'inbox', 'copies', 'root-instructions',
  'raw-read-policy', 'inventory', 'flush', 'unavailable']);
export const forgetJobSchema = z.strictObject({
  id: randomId, targets: z.array(randomId), sessionIds: z.array(z.string()), epoch: safeCounter,
  revision: safeCounter, choice: z.enum(['stop', 'clean']),
  phase: z.enum(['intent', 'stopped', 'cleaning', 'blocked', 'verified']),
  reasons: z.array(cleanupReasonSchema), historyVerified: z.array(z.string()), copiesVerified: z.boolean(),
  verificationReceipt: randomId.optional(),
  blockedHeads: z.array(z.string()).optional(), pendingInbox: z.boolean().optional(),
});
export const cleanupStatusSchema = z.strictObject({
  id: randomId, stopped: z.boolean(), strong: z.boolean(), phase: forgetJobSchema.shape.phase,
  reasons: z.array(cleanupReasonSchema), sessions: safeCounter,
}).refine(s => !s.strong || (s.stopped && s.phase === 'verified'), 'Strong forgetting needs verified stopped state');
export const rootInstructionsSchema = z.strictObject({
  root: z.string(), files: z.array(z.strictObject({ path: z.string(), state: z.enum(['present', 'absent', 'unknown']) })),
});
export type ForgetPreview = z.output<typeof forgetPreviewSchema>;
export type ForgetChoice = z.output<typeof forgetChoiceSchema>;
export type ForgetSelection = z.output<typeof forgetSelectionSchema>;
export type ForgetJob = z.output<typeof forgetJobSchema>;
export type CleanupStatus = z.output<typeof cleanupStatusSchema>;
export type CleanupReason = z.output<typeof cleanupReasonSchema>;
export type RootInstructions = z.output<typeof rootInstructionsSchema>;
