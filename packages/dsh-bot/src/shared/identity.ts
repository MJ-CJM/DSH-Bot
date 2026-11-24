import { z } from 'zod';
import { botIdSchema } from './ids.js';
export const resourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const botKeySchema = z.strictObject({ botId: botIdSchema, botCreatedAt: z.number().int().nonnegative() });
export type BotKey = z.output<typeof botKeySchema>;
export const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;
export function sameGroupReaders(left: readonly BotKey[], right: readonly BotKey[]) {
  const key = (bot: BotKey) => JSON.stringify([bot.botId, bot.botCreatedAt]);
  const readers = new Set(right.map(key));
  return readers.size === right.length && new Set(left.map(key)).size === left.length &&
    left.length === right.length && left.every(bot => readers.has(key(bot)));
}
export const metadata = {
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
};
