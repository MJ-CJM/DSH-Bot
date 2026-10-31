import { z } from 'zod';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usageSchema = z.strictObject({ calls: count, input: count, output: count, money: count });
export type Usage = z.output<typeof usageSchema>;
export const priceSchema = z.strictObject({
  version: z.string().min(1), model: z.string().min(1), source: z.literal('synthetic'),
  call: count, input: count, output: count,
});
export type Price = z.output<typeof priceSchema>;
export const reservationInputSchema = z.strictObject({
  id: z.string().min(1), runId: z.string().min(1), caseId: z.string().min(1), attempt: count.min(1),
  model: z.string().min(1), priceVersion: z.string().min(1),
  calls: count.min(1), inputCeiling: count, outputCeiling: count, moneyCeiling: count,
});
export type ReservationInput = z.output<typeof reservationInputSchema>;
export const reservationSchema = reservationInputSchema.extend({
  state: z.enum(['reserved', 'settled', 'unknown']), actual: usageSchema.optional(),
}).superRefine((row, ctx) => {
  if ((row.state === 'settled') !== (row.actual !== undefined)) ctx.addIssue({ code: 'custom', message: 'Invalid settlement' });
});
export const ledgerSchema = z.strictObject({
  version: z.literal(1), limits: usageSchema, price: priceSchema, reservations: z.array(reservationSchema), blocked: z.boolean().optional(),
});
export type LedgerState = z.output<typeof ledgerSchema>;
export const zeroUsage = (): Usage => ({ calls: 0, input: 0, output: 0, money: 0 });
export function addUsage(a: Usage, b: Usage): Usage {
  return usageSchema.parse({ calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, money: a.money + b.money });
}
export const within = (a: Usage, b: Usage) => (Object.keys(a) as (keyof Usage)[]).every(key => a[key] <= b[key]);
export function charge(price: Price, calls: number, input: number, output: number): Usage {
  return usageSchema.parse({ calls, input, output, money: calls * price.call + input * price.input + output * price.output });
}
export const ceiling = (row: ReservationInput): Usage => ({
  calls: row.calls, input: row.inputCeiling, output: row.outputCeiling, money: row.moneyCeiling,
});
