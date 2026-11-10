import { z } from 'zod';
import { botKeySchema } from './identity.js';
import { groupRecallReferenceSchema } from './group-recall.js';

/** Provenance only. Conversation text remains in the native session. */
export const groupRecallReadsSchema = z.strictObject({
  sessionId: z.string().min(1),
  bot: botKeySchema,
  epoch: z.number().int().nonnegative(),
  references: z.array(groupRecallReferenceSchema).max(256),
});
