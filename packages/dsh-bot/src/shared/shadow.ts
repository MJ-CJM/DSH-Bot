import { z } from 'zod';
export const shadowStatusSchema = z.strictObject({
  mode: z.literal('offline-only'), shadowEnabled: z.boolean(), offlineOrganizeEnabled: z.boolean(),
  opportunities: z.number().int().nonnegative(), candidates: z.number().int().nonnegative(),
  modelRequests: z.literal(0), notifications: z.literal(0), memoryWrites: z.literal(0),
});
export type ShadowStatus = z.output<typeof shadowStatusSchema>;
