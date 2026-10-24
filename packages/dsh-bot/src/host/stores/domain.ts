import { defineDomain, DomainError, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { DshBotError, type DshBotErrorCode } from '../errors.js';
import { activityRecordSchema } from '../../shared/activity.js';
import { avatarSchema, botRecordFields, botRegistryStateSchema, botSchema, memorySchema } from '../../shared/schema.js';
import type { BotRecord } from '../../shared/schema.js';

// Only the legacy avatar field is permissive at the storage read boundary.
// Preserve its bytes on disk; public records and all new writes remain strict.
export const storedBotSchema = botRecordFields
  .extend({ avatar: z.unknown().optional() })
  .refine((record) => record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt');
export type StoredBot = z.output<typeof storedBotSchema>;
export function publicBot(record: StoredBot): BotRecord {
  const { avatar, ...fields } = record;
  return botSchema.parse({ ...fields, ...(avatarSchema.safeParse(avatar).success ? { avatar } : {}) });
}
export const invalidAvatar = (record: StoredBot) =>
  record.avatar !== undefined && !avatarSchema.safeParse(record.avatar).success;

export const storedActivitySchema = activityRecordSchema.extend({
  lastEventSeq: z.number().int().nonnegative().optional(),
});
export type StoredActivity = z.output<typeof storedActivitySchema>;
export const botDomain = defineDomain({
  name: 'dsh_bot',
  version: 1,
  tables: {
    bots: domainTable(storedBotSchema),
    memories: domainTable(memorySchema),
    registry_state: domainTable(botRegistryStateSchema),
    activities: domainTable(storedActivitySchema),
  },
});
export type BotDomain = Domain<typeof botDomain>;

// The domain API has no insert-if-absent. All writers sharing a handle also
// share this queue, including independently constructed Store wrappers.
export const writers = new WeakMap<BotDomain, { tail: Promise<unknown>; closing: boolean; assertOwner?: () => void }>();
export function writer(domain: BotDomain) {
  let state = writers.get(domain);
  if (!state) {
    state = { tail: Promise.resolve(), closing: false };
    writers.set(domain, state);
  }
  return state;
}

export function failure(error: unknown, missing: DshBotErrorCode = 'bot/not-found'): DshBotError {
  if (error instanceof DshBotError) return error;
  const code = error instanceof DomainError && error.code === 'missing-key' ? missing : 'store/unavailable';
  return new DshBotError(code, error instanceof Error ? error.message : String(error), { cause: error });
}
export function read<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw failure(error);
  }
}
export async function write<T>(domain: BotDomain, operation: () => Promise<T>, missing?: DshBotErrorCode): Promise<T> {
  const state = writer(domain);
  if (state.closing) throw failure(new DomainError('closed', 'Bot stores are closing'));
  const pending = state.tail.then(() => {
    state.assertOwner?.();
    return operation();
  });
  state.tail = pending.catch(() => {});
  try {
    return await pending;
  } catch (error) {
    throw failure(error, missing);
  }
}
export const nextTimestamp = (previous: number) => Math.max(Date.now(), previous + 1);
export const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const missingBot = (id: string) => new DshBotError('bot/not-found', `Bot '${id}' was not found`);
export const missingMemory = () => new DshBotError('memory/not-found', 'Memory was not found for this bot');

// Must run inside an existing writer slot; enqueuing removeByBot here would deadlock.
export async function deleteBotMemories(domain: BotDomain, botId: string): Promise<number> {
  const table = domain.table('memories');
  let removed = 0;
  for (const [id, record] of table.entries()) {
    if (record.botId === botId && (await table.delete(id))) removed++;
  }
  return removed;
}

export async function deleteBotActivities(domain: BotDomain, botId: string): Promise<void> {
  const table = domain.table('activities');
  for (const [id, record] of table.entries()) {
    if (record.botId === botId) await table.delete(id);
  }
}
