import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, DomainError, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { botIdSchema, memoryIdSchema } from '../shared/ids.js';
import {
  botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema, DshBotError, memoryAddSchema,
  memoryListOptionsSchema, memoryPatchSchema, memorySchema, parseInput, timestampSchema,
} from '../shared/schema.js';
import type {
  BotCreateInput, BotPatch, BotRecord, BotRemoveOptions, DshBotErrorCode, MemoryAddInput, MemoryCursor,
  MemoryListOptions, MemoryPatch, MemoryRecord,
} from '../shared/schema.js';

export const botDomain = defineDomain({
  name: 'dsh_bot', version: 1,
  tables: { bots: domainTable(botSchema), memories: domainTable(memorySchema) },
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

export class BotStore {
  constructor(private readonly domain: BotDomain) {}

  list(): BotRecord[] {
    return read(() => [...this.domain.table('bots').entries()].map(([, value]) => structuredClone(value))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareId(a.id, b.id)));
  }

  get(id: string): BotRecord {
    const key = parseInput(botIdSchema, id);
    return read(() => {
      const record = this.domain.table('bots').get(key);
      if (!record) throw missingBot(key);
      return structuredClone(record);
    });
  }

  async create(input: BotCreateInput): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    return write(this.domain, async () => {
      const table = this.domain.table('bots');
      if (table.get(fields.id)) throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
      const now = Date.now();
      const record = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await table.put(record.id, record);
      return structuredClone(record);
    });
  }

  async update(id: string, patch: BotPatch, expectedUpdatedAt?: number): Promise<BotRecord> {
    const key = parseInput(botIdSchema, id);
    const fields = parseInput(botPatchSchema, patch);
    const expected = parseInput(timestampSchema.optional(), expectedUpdatedAt);
    return write(this.domain, async () => structuredClone(await this.domain.table('bots').update(key, (current) => {
      // Check at the domain's write slot, never against a pre-queue snapshot.
      if (expected !== undefined && current.updatedAt !== expected) {
        throw new DshBotError('bot/conflict', `Bot '${key}' has changed; reload before updating`);
      }
      return parseInput(botSchema, { ...current, ...fields, updatedAt: nextTimestamp(current.updatedAt) });
    })));
  }

  /** Delete memories first so failed cleanup leaves the Bot available for retry. */
  async remove(id: string, options: BotRemoveOptions = {}): Promise<void> {
    const key = parseInput(botIdSchema, id);
    const { deleteMemories } = parseInput(botRemoveOptionsSchema, options);
    return write(this.domain, async () => {
      if (!this.domain.table('bots').get(key)) throw missingBot(key);
      if (deleteMemories) await deleteBotMemories(this.domain, key);
      if (!await this.domain.table('bots').delete(key)) throw missingBot(key);
    });
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
    const fields = parseInput(memoryAddSchema, input);
    return write(this.domain, async () => {
      if (!this.domain.table('bots').get(fields.botId)) throw missingBot(fields.botId);
      const table = this.domain.table('memories');
      let id = randomUUID();
      while (table.get(id)) id = randomUUID();
      const now = Date.now();
      const record = parseInput(memorySchema, { ...fields, id, createdAt: now, updatedAt: now });
      await table.put(id, record);
      return structuredClone(record);
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
export async function openBotStores(ctx: Context): Promise<{
  bots: BotStore; memories: MemoryStore; close: () => Promise<void>;
}> {
  let stores!: { bots: BotStore; memories: MemoryStore };
  let closing: Promise<void> | undefined;
  try {
    const release = ctx.effect(async () => {
      const domain = await ctx.storageDomain.open(botDomain);
      stores = { bots: new BotStore(domain), memories: new MemoryStore(domain) };
      const closeDomain = async () => {
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
