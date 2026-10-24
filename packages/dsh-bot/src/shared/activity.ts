import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { timestampSchema } from './schema.js';

// Persisted summary contract, measured in Unicode code points including ellipsis.
export const ACTIVITY_PREVIEW_MAX_CHARS = 120;
/** Reserved wire/persistence sentinel. Clients localize this value, including
 * the legacy T08c Chinese marker, for both preview and sanitized titles. */
export const ACTIVITY_HIDDEN_PREVIEW = '[dsh-bot:hidden]';
export function isHiddenActivityPreview(value: string | undefined): boolean {
  return value === ACTIVITY_HIDDEN_PREVIEW || value === '[已隐藏]';
}
export const activitySessionIdSchema = z.string().min(1);
const summaryText = z
  .string()
  .refine((value) => [...value].length <= ACTIVITY_PREVIEW_MAX_CHARS, 'Activity summary exceeds its code point limit');
export const activityMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  preview: summaryText,
  at: timestampSchema,
});
export const activityRecordSchema = z.strictObject({
  sessionId: activitySessionIdSchema,
  botId: botIdSchema,
  title: summaryText.optional(),
  // Optional for older records. Empty means the first human message had no
  // visible text; a later user message must never replace that first input.
  firstUserPreview: summaryText.optional(),
  lastMessage: activityMessageSchema,
  updatedAt: timestampSchema,
  lastReadAt: timestampSchema.optional(),
});
export const activitySessionSchema = activityRecordSchema.extend({ unread: z.boolean() });
export const activityListOptionsSchema = z.strictObject({ botId: botIdSchema.optional() });
export const activityBotSchema = z.strictObject({
  botId: botIdSchema,
  lastActivityAt: timestampSchema,
  unreadCount: z.number().int().nonnegative(),
  latest: activityMessageSchema.extend({ sessionId: activitySessionIdSchema }).optional(),
});
export const activityListResultSchema = z.strictObject({
  sessions: z.array(activitySessionSchema),
  bots: z.array(activityBotSchema),
});
export type ActivityRecord = z.output<typeof activityRecordSchema>;
export type ActivitySession = z.output<typeof activitySessionSchema>;
export type BotActivity = z.output<typeof activityBotSchema>;
export type ActivityListOptions = z.input<typeof activityListOptionsSchema>;
export type ActivityListResult = z.output<typeof activityListResultSchema>;

export function isActivityUnread(record: Pick<ActivityRecord, 'lastMessage' | 'lastReadAt'>): boolean {
  return record.lastMessage.role === 'assistant' && record.lastMessage.at > (record.lastReadAt ?? 0);
}
