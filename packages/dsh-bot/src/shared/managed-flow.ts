import { z } from 'zod';
import { dataLabelSchema, flowBindingSchema } from './data-flow.js';

export const outletSchema = z.enum(['message', 'group-input', 'group-result', 'delegate-input', 'delegate-result',
  'notify-record', 'notify-send', 'mcp-copy', 'connector', 'auto-share']);
export type Outlet = z.output<typeof outletSchema>;
export const flowEnvelopeSchema = z.strictObject({
  binding: flowBindingSchema, label: dataLabelSchema, content: z.string(), outlet: outletSchema,
});
export type FlowEnvelope = z.output<typeof flowEnvelopeSchema>;
export const flowRecordSchema = z.strictObject({
  id: z.uuid(), state: z.enum(['admitted', 'dispatching', 'delivered', 'unknown', 'cancelled']),
  envelope: flowEnvelopeSchema.optional(), grantUse: z.uuid().optional(),
});
export type FlowRecord = z.output<typeof flowRecordSchema>;
export const flowSessionSchema = z.strictObject({ sessionId: z.string().min(1), label: dataLabelSchema });
