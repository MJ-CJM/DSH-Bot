import { z } from 'zod';
import { groupKeySchema } from './groups.js';

const id = z.string().min(1);
export const relayDetailsRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('group'), group: groupKeySchema, turnId: id }),
  z.strictObject({ kind: z.literal('receipt'), messageId: id, nativeId: id, sessionId: id }),
]);
export type RelayDetailsRequest = z.output<typeof relayDetailsRequestSchema>;
const part = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('readable'), text: z.string().min(1) }),
  z.strictObject({ state: z.enum(['pending', 'restricted', 'unavailable']) }),
]);
export const relayDetailsSchema = z.strictObject({
  sender: id, guest: id, question: part.optional(), answer: part.optional(), report: part.optional(),
});
export type RelayDetails = z.output<typeof relayDetailsSchema>;
export type RelayPart = z.output<typeof part>;
