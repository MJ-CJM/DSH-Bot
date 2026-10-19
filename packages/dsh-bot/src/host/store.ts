import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, DomainError, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { DshBotError, type DshBotErrorCode, parseInput } from './errors.js';
import { validateDefaultCwd } from './home.js';
import { botIdSchema, memoryIdSchema } from '../shared/ids.js';
import {
  activityListOptionsSchema, activityRecordSchema, activitySessionIdSchema, isActivityUnread,
} from '../shared/activity.js';
import type { ActivityListOptions, ActivityListResult, ActivityRecord, ActivitySession } from '../shared/activity.js';
import { createActivityPreview } from './activity/preview.js';
import {
  avatarSchema, botRecordFields, botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema, memoryAddSchema,
  memoryListOptionsSchema, memoryPatchSchema, memorySchema, normalizeBotPatch, normalizeMemoryContent, timestampSchema,
} from '../shared/schema.js';
import type {
  BotCreateInput, BotPatch, BotRecord, BotRemoveOptions, MemoryAddInput, MemoryCursor,
  MemoryListOptions, MemoryPatch, MemoryRecord, MemorySaveResult,
} from '../shared/schema.js';

// Only the legacy avatar field is permissive at the storage read boundary.
// Preserve its bytes on disk; public records and all new writes remain strict.
const storedBotSchema = botRecordFields.extend({ avatar: z.unknown().optional() })
  .refine((record) => record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt');
type StoredBot = z.output<typeof storedBotSchema>;
function publicBot(record: StoredBot): BotRecord {
  const { avatar, ...fields } = record;
  return botSchema.parse({ ...fields, ...(avatarSchema.safeParse(avatar).success ? { avatar } : {}) });
}
const invalidAvatar = (record: StoredBot) => record.avatar !== undefined && !avatarSchema.safeParse(record.avatar).success;

const seedStateSchema = z.strictObject({ status: z.enum(['pending', 'complete']) });
const storedActivitySchema = activityRecordSchema.extend({ lastEventSeq: z.number().int().nonnegative().optional() });
type StoredActivity = z.output<typeof storedActivitySchema>;
export const botDomain = defineDomain({
  name: 'dsh_bot', version: 1,
  tables: { bots: domainTable(storedBotSchema), memories: domainTable(memorySchema),
    registry_state: domainTable(seedStateSchema), activities: domainTable(storedActivitySchema) },
});
type BotDomain = Domain<typeof botDomain>;

// The domain API has no insert-if-absent. All writers sharing a handle also
// share this queue, including independently constructed Store wrappers.
const writers = new WeakMap<BotDomain, { tail: Promise<unknown>; closing: boolean }>();
function writer(domain: BotDomain) {
  let state = writers.get(domain);
  if (!state) {
    state = { tail: Promise.resolve(), closing: false };
    writers.set(domain, state);
  }
  return state;
}

function failure(error: unknown, missing: DshBotErrorCode = 'bot/not-found'): DshBotError {
  if (error instanceof DshBotError) return error;
  const code = error instanceof DomainError && error.code === 'missing-key' ? missing : 'store/unavailable';
  return new DshBotError(code, error instanceof Error ? error.message : String(error), { cause: error });
}
function read<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw failure(error); }
}
async function write<T>(domain: BotDomain, operation: () => Promise<T>, missing?: DshBotErrorCode): Promise<T> {
  const state = writer(domain);
  if (state.closing) throw failure(new DomainError('closed', 'Bot stores are closing'));
  const pending = state.tail.then(operation);
  state.tail = pending.catch(() => {});
  try { return await pending; } catch (error) { throw failure(error, missing); }
}
const nextTimestamp = (previous: number) => Math.max(Date.now(), previous + 1);
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const missingBot = (id: string) => new DshBotError('bot/not-found', `Bot '${id}' was not found`);
const missingMemory = () => new DshBotError('memory/not-found', 'Memory was not found for this bot');

// Must run inside an existing writer slot; enqueuing removeByBot here would deadlock.
async function deleteBotMemories(domain: BotDomain, botId: string): Promise<number> {
  const table = domain.table('memories');
  let removed = 0;
  for (const [id, record] of table.entries()) {
    if (record.botId === botId && await table.delete(id)) removed++;
  }
  return removed;
}

async function deleteBotActivities(domain: BotDomain, botId: string): Promise<void> {
  const table = domain.table('activities');
  for (const [id, record] of table.entries()) {
    if (record.botId === botId) await table.delete(id);
  }
}

export class BotStore {
  constructor(private readonly domain: BotDomain) {}

  /** A durable marker prevents reseeding after users deliberately remove every Bot.
   * A pending batch resumes missing examples after an interrupted initial write.
   */
  async seedExamples(inputs: readonly BotCreateInput[]): Promise<void> {
    const examples = inputs.map((input) => parseInput(botCreateSchema, input));
    await Promise.all(examples.map((example) => validateDefaultCwd(example.defaultCwd)));
    await write(this.domain, async () => {
      const state = this.domain.table('registry_state');
      const bots = this.domain.table('bots');
      const previous = state.get('examples');
      if (previous?.status === 'complete') return;
      if (previous === undefined && bots.size > 0) {
        await state.put('examples', seedStateSchema.parse({ status: 'complete' }));
        return;
      }
      await state.put('examples', seedStateSchema.parse({ status: 'pending' }));
      for (const example of examples) {
        if (bots.get(example.id)) continue;
        const now = Date.now();
        const record = parseInput(botSchema, { ...example, createdAt: now, updatedAt: now, schemaVersion: 1 });
        await bots.put(record.id, record);
      }
      await state.put('examples', seedStateSchema.parse({ status: 'complete' }));
    });
  }

  list(): BotRecord[] {
    return read(() => [...this.domain.table('bots').entries()].map(([, value]) => publicBot(value))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareId(a.id, b.id)));
  }

  get(id: string): BotRecord {
    const key = parseInput(botIdSchema, id);
    return read(() => {
      const record = this.domain.table('bots').get(key);
      if (!record) throw missingBot(key);
      return publicBot(record);
    });
  }

  avatarWarnings(): string[] {
    return read(() => [...this.domain.table('bots').entries()].filter(([, row]) => invalidAvatar(row)).map(([, row]) => row.id));
  }

  async create(input: BotCreateInput, createdAt = Date.now()): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    await validateDefaultCwd(fields.defaultCwd);
    const now = parseInput(timestampSchema, createdAt);
    return write(this.domain, async () => {
      const table = this.domain.table('bots');
      if (table.get(fields.id)) throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
      const record = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await table.put(record.id, record);
      return structuredClone(record);
    });
  }

  async update(id: string, patch: BotPatch, expectedUpdatedAt?: number): Promise<BotRecord> {
    const key = parseInput(botIdSchema, id);
    const fields = normalizeBotPatch(parseInput(botPatchSchema, patch));
    await validateDefaultCwd(fields.defaultCwd);
    const expected = parseInput(timestampSchema.optional(), expectedUpdatedAt);
    return write(this.domain, async () => publicBot(await this.domain.table('bots').update(key, (current) => {
      // Check at the domain's write slot, never against a pre-queue snapshot.
      if (expected !== undefined && current.updatedAt !== expected) {
        throw new DshBotError('bot/conflict', `Bot '${key}' has changed; reload before updating`);
      }
      if (invalidAvatar(current) && !('avatar' in fields)) {
        throw new DshBotError('bot/invalid', 'Stored avatar is unsupported; explicitly replace or clear the avatar before updating.');
      }
      return parseInput(botSchema, { ...current, ...fields, updatedAt: nextTimestamp(current.updatedAt) });
    })));
  }

  /** Delete dependent data first so failed cleanup leaves the Bot available for retry. */
  async remove(id: string, options: BotRemoveOptions = {}): Promise<void> {
    const key = parseInput(botIdSchema, id);
    const { deleteMemories } = parseInput(botRemoveOptionsSchema, options);
    return write(this.domain, async () => {
      if (!this.domain.table('bots').get(key)) throw missingBot(key);
      if (deleteMemories) await deleteBotMemories(this.domain, key);
      // Activity is never retained, including when the user keeps memories.
      await deleteBotActivities(this.domain, key);
      if (!await this.domain.table('bots').delete(key)) throw missingBot(key);
    });
  }
}

export interface ActivityStoreOptions {
  activityMaxSessionsPerBot?: number;
  activityMaxSessionsTotal?: number;
}
export interface ActivityRecordInput {
  sessionId: string; botId: string; role: 'user' | 'assistant'; text: string; at: number; title?: string;
  /** First actual human message (or screened summary) from a public projection,
   * never a later message inferred from a row that lacks this metadata. */
  firstUserText?: string;
  seq?: number;
  /** Guards queued events from an Agent belonging to a deleted Bot incarnation. */
  expectedBotCreatedAt?: number;
}
const activityOrder = (a: ActivityRecord, b: ActivityRecord) =>
  b.updatedAt - a.updatedAt || compareId(a.sessionId, b.sessionId);
function activityRecord(record: StoredActivity): ActivityRecord {
  // Deliberate allowlist: neither lastEventSeq nor future storage-only fields
  // can escape through list, record or either markRead return branch.
  return {
    sessionId: record.sessionId, botId: record.botId, updatedAt: record.updatedAt,
    lastMessage: { role: record.lastMessage.role, preview: record.lastMessage.preview, at: record.lastMessage.at },
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.firstUserPreview === undefined ? {} : { firstUserPreview: record.firstUserPreview }),
    ...(record.lastReadAt === undefined ? {} : { lastReadAt: record.lastReadAt }),
  };
}
const publicActivity = (record: StoredActivity): ActivitySession =>
  ({ ...activityRecord(record), unread: isActivityUnread(record) });

/** Stores only completed-message summaries. The event adapter owns completion
 * coalescing; all writes share the Bot/Memory domain queue and delete boundary.
 */
export class ActivityStore {
  private readonly perBot: number;
  private readonly total: number;

  constructor(private readonly domain: BotDomain, options: ActivityStoreOptions = {}) {
    const cap = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
    this.perBot = parseInput(cap, options.activityMaxSessionsPerBot ?? 50);
    this.total = parseInput(cap, options.activityMaxSessionsTotal ?? 1000);
  }

  list(options: ActivityListOptions = {}): ActivityListResult {
    const filter = parseInput(activityListOptionsSchema, options);
    try {
      const bots = [...this.domain.table('bots').entries()].map(([, bot]) => bot)
        .filter((bot) => filter.botId === undefined || bot.id === filter.botId)
        .sort((a, b) => compareId(a.id, b.id));
      const owners = new Set(bots.map((bot) => bot.id));
      const sessions = [...this.domain.table('activities').entries()].map(([, record]) => record)
        .filter((record) => owners.has(record.botId)).sort(activityOrder).map(publicActivity);
      return { sessions, bots: bots.map((bot) => {
        const owned = sessions.filter((record) => record.botId === bot.id);
        const latest = owned[0];
        return { botId: bot.id, lastActivityAt: latest?.updatedAt ?? 0,
          unreadCount: owned.filter((record) => record.unread).length,
          ...(latest ? { latest: { sessionId: latest.sessionId, ...latest.lastMessage } } : {}) };
      }) };
    } catch (error) {
      const wrapped = failure(error);
      if (wrapped.code === 'store/unavailable') return { sessions: [], bots: [] };
      throw wrapped;
    }
  }

  async record(input: ActivityRecordInput): Promise<ActivityRecord | undefined> {
    // Do not pass raw text/title to validation errors or the persistence layer.
    if (typeof input.text !== 'string' || (input.title !== undefined && typeof input.title !== 'string')
      || (input.firstUserText !== undefined && typeof input.firstUserText !== 'string')) {
      throw new DshBotError('bot/invalid', 'Activity text and title must be strings');
    }
    const fields = parseInput(activityRecordSchema, {
      sessionId: input.sessionId, botId: input.botId, updatedAt: input.at,
      lastMessage: { role: input.role, preview: createActivityPreview(input.text), at: input.at },
      ...(input.title === undefined ? {} : { title: createActivityPreview(input.title) }),
    });
    const expected = parseInput(timestampSchema.optional(), input.expectedBotCreatedAt);
    const seq = parseInput(timestampSchema.optional(), input.seq);
    const firstUserPreview = input.firstUserText === undefined ? undefined : createActivityPreview(input.firstUserText);
    return write(this.domain, async () => {
      const bot = this.domain.table('bots').get(fields.botId);
      // A deleted Bot cannot be resurrected by a still-live Agent or late event.
      if (!bot || (expected !== undefined && bot.createdAt !== expected)) return;
      const table = this.domain.table('activities');
      const previous = table.get(fields.sessionId);
      if (previous && previous.botId !== fields.botId) return;
      if (previous) {
        const stale = seq !== undefined && previous.lastEventSeq !== undefined ? seq <= previous.lastEventSeq
          : previous.updatedAt > fields.updatedAt
            || (previous.updatedAt === fields.updatedAt && previous.lastMessage.role === fields.lastMessage.role
              && previous.lastMessage.preview === fields.lastMessage.preview);
        if (stale) return activityRecord(previous);
      }
      // Public event times have millisecond resolution. Logical advancement
      // preserves completion order and read->reply unread status within one ms.
      const at = Math.max(fields.lastMessage.at, previous ? previous.lastMessage.at + 1 : 0,
        previous?.lastReadAt === undefined ? 0 : previous.lastReadAt + 1);
      const record = parseInput(storedActivitySchema, { ...previous, ...fields,
        updatedAt: at, lastMessage: { ...fields.lastMessage, at },
        ...(previous?.firstUserPreview !== undefined ? { firstUserPreview: previous.firstUserPreview }
          : firstUserPreview !== undefined ? { firstUserPreview } : {}),
        ...(seq === undefined ? {} : { lastEventSeq: seq }) });
      // Evict before adding so even partial backend failures cannot exceed caps.
      const retained = await this.pruneRows(record);
      if (!retained) return;
      await table.put(record.sessionId, record);
      return activityRecord(record);
    });
  }

  async markRead(sessionId: string): Promise<ActivitySession> {
    const key = parseInput(activitySessionIdSchema, sessionId);
    return write(this.domain, async () => {
      const table = this.domain.table('activities');
      const previous = table.get(key);
      if (!previous || !this.domain.table('bots').get(previous.botId)) {
        throw new DshBotError('activity/not-found', 'Bot session activity was not found');
      }
      // Marking read does not change recency or eviction order. Clock rollback
      // never makes a read timestamp go backwards; same-clock retries do no I/O.
      const now = Math.max(Date.now(), previous.lastMessage.at, previous.lastReadAt ?? 0);
      if (previous.lastReadAt === now) return publicActivity(previous);
      const record = parseInput(storedActivitySchema, { ...previous, lastReadAt: now });
      await table.put(key, record);
      return publicActivity(record);
    }, 'activity/not-found');
  }

  /** Apply changed caps after reopening, without rewriting retained summaries. */
  async prune(): Promise<void> {
    await write(this.domain, async () => { await this.pruneRows(); });
  }

  private async pruneRows(incoming?: StoredActivity): Promise<boolean> {
    const table = this.domain.table('activities');
    const rows = [...table.entries()].map(([, record]) => record)
      .filter((record) => record.sessionId !== incoming?.sessionId);
    if (incoming) rows.push(incoming);
    rows.sort(activityOrder);
    const counts = new Map<string, number>();
    const keep = new Set<string>();
    for (const row of rows) {
      const count = counts.get(row.botId) ?? 0;
      if (keep.size >= this.total || count >= this.perBot) continue;
      keep.add(row.sessionId);
      counts.set(row.botId, count + 1);
    }
    for (const [id] of table.entries()) {
      if (!keep.has(id)) await table.delete(id);
    }
    return incoming === undefined || keep.has(incoming.sessionId);
  }
}

/** Replaceable retrieval predicate; the store always applies Bot isolation first. */
export type MemorySearchRecord = Readonly<Omit<MemoryRecord, 'tags' | 'source'>> & {
  readonly tags: readonly string[];
  readonly source?: Readonly<NonNullable<MemoryRecord['source']>>;
};
export interface MemorySearch {
  matches(record: MemorySearchRecord, query: string): boolean;
}
// Custom predicates get a shallow frozen view, never mutable storage references.
function searchView(record: MemoryRecord): MemorySearchRecord {
  return Object.freeze({ ...record, tags: Object.freeze([...record.tags]),
    source: record.source === undefined ? undefined : Object.freeze({ ...record.source }) });
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
export function tokenizeMemoryQuery(query: string): string[] {
  const words = normalize(query).replace(/(\p{Script=Han}+)/gu, ' $1 ').match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.flatMap((word) => {
    const chars = [...word];
    return /^\p{Script=Han}+$/u.test(word) && chars.length > 1
      ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : [word];
  }))];
}
export const lexicalMemorySearch: MemorySearch = {
  matches: (record, query) => {
    const content = normalize(record.content);
    return tokenizeMemoryQuery(query).every((token) => content.includes(token));
  },
};
function compareMemory(a: MemoryCursor, b: MemoryCursor): number {
  return Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || compareId(a.id, b.id);
}

export class MemoryStore {
  constructor(private readonly domain: BotDomain, private readonly search: MemorySearch = lexicalMemorySearch) {}

  async add(input: MemoryAddInput): Promise<MemoryRecord> {
    return (await this.persist(input, false)).record;
  }

  /** Match and merge inside the domain writer, including across Store instances. */
  async saveUnique(input: MemoryAddInput, signal?: AbortSignal): Promise<MemorySaveResult> {
    const { record, deduplicated } = await this.persist(input, true, signal);
    return { id: record.id, deduplicated };
  }

  private async persist(input: MemoryAddInput, deduplicate: boolean, signal?: AbortSignal): Promise<{
    record: MemoryRecord; deduplicated: boolean;
  }> {
    const fields = parseInput(memoryAddSchema, input);
    return write(this.domain, async () => {
      signal?.throwIfAborted();
      if (!this.domain.table('bots').get(fields.botId)) throw missingBot(fields.botId);
      const table = this.domain.table('memories');
      if (deduplicate) {
        const normalized = normalizeMemoryContent(fields.content);
        const existing = [...table.entries()].map(([, record]) => record)
          .filter((record) => record.botId === fields.botId && normalizeMemoryContent(record.content) === normalized)
          .sort((a, b) => a.createdAt - b.createdAt || compareId(a.id, b.id))[0];
        if (existing) {
          const record = parseInput(memorySchema, { ...existing,
            tags: [...new Set([...existing.tags, ...fields.tags])], pinned: existing.pinned || fields.pinned,
            updatedAt: nextTimestamp(existing.updatedAt),
          });
          await table.put(record.id, record);
          return { record: structuredClone(record), deduplicated: true };
        }
      }
      let id = randomUUID();
      while (table.get(id)) id = randomUUID();
      const now = Date.now();
      const record = parseInput(memorySchema, { ...fields, id, createdAt: now, updatedAt: now });
      await table.put(id, record);
      return { record: structuredClone(record), deduplicated: false };
    });
  }

  async update(botId: string, id: string, patch: MemoryPatch): Promise<MemoryRecord> {
    const owner = parseInput(botIdSchema, botId);
    const key = parseInput(memoryIdSchema, id);
    const fields = parseInput(memoryPatchSchema, patch);
    return write(this.domain, async () => structuredClone(await this.domain.table('memories').update(key, (current) => {
      if (current.botId !== owner) throw missingMemory();
      return parseInput(memorySchema, { ...current, ...fields, updatedAt: nextTimestamp(current.updatedAt) });
    })), 'memory/not-found');
  }

  async remove(botId: string, id: string): Promise<void> {
    const owner = parseInput(botIdSchema, botId);
    const key = parseInput(memoryIdSchema, id);
    return write(this.domain, async () => {
      const table = this.domain.table('memories');
      if (table.get(key)?.botId !== owner || !await table.delete(key)) throw missingMemory();
    }, 'memory/not-found');
  }

  /** Count all rows owned by a Bot without allocating/cloning a result page. */
  countByBot(botId: string): number {
    const owner = parseInput(botIdSchema, botId);
    return read(() => {
      let count = 0;
      for (const [, record] of this.domain.table('memories').entries()) {
        if (record.botId === owner) count++;
      }
      return count;
    });
  }

  /** Cursor denotes an exclusive position, not a timestamp cutoff or snapshot. */
  listByBot(botId: string, options: MemoryListOptions): MemoryRecord[] {
    const owner = parseInput(botIdSchema, botId);
    const filter = parseInput(memoryListOptionsSchema, options);
    return read(() => [...this.domain.table('memories').entries()]
      .filter(([, record]) => record.botId === owner)
      .map(([, record]) => record)
      .filter((record) => (filter.tag === undefined || record.tags.includes(filter.tag))
        && (filter.pinned === undefined || record.pinned === filter.pinned)
        && (filter.before === undefined || compareMemory(record, filter.before) > 0)
        && (filter.query === undefined || this.search.matches(
          this.search === lexicalMemorySearch ? record : searchView(record), filter.query)))
      .sort(compareMemory).slice(0, filter.limit).map((record) => structuredClone(record)));
  }

  /** Serialized with adds/removes through either Store; not a cross-table transaction. */
  async removeByBot(botId: string): Promise<number> {
    const owner = parseInput(botIdSchema, botId);
    return write(this.domain, () => deleteBotMemories(this.domain, owner));
  }
}

/** Call once in the owning Host context (inject storageDomain); share the stores. */
export async function openBotStores(ctx: Context, options: ActivityStoreOptions & { beforeClose?: () => Promise<void> } = {}): Promise<{
  bots: BotStore; memories: MemoryStore; activities: ActivityStore; close: () => Promise<void>;
}> {
  let stores!: { bots: BotStore; memories: MemoryStore; activities: ActivityStore };
  let closing: Promise<void> | undefined;
  try {
    const release = ctx.effect(async () => {
      const domain = await ctx.storageDomain.open(botDomain);
      try {
        const activities = new ActivityStore(domain, options);
        await activities.prune();
        stores = { bots: new BotStore(domain), memories: new MemoryStore(domain), activities };
      } catch (error) { await domain.close(); throw error; }
      const closeDomain = async () => {
        // Cordis may dispose sibling effects concurrently. The registry owns a
        // wider queue than these stores, and must drain it before we reject writes.
        if (options.beforeClose) await options.beforeClose();
        const state = writer(domain);
        state.closing = true;
        await state.tail;
        try { await domain.close(); } catch (error) { throw failure(error); }
      };
      return () => closing ??= closeDomain();
    });
    await release;
    // Cordis skips repeat disposer calls; still await the original teardown.
    return { ...stores, close: async () => { await release(); await closing; } };
  } catch (error) { throw failure(error); }
}
