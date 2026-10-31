import { randomUUID } from 'node:crypto';
import { parseInput } from '../errors.js';
import { botIdSchema, memoryIdSchema } from '../../shared/ids.js';
import {
  memoryAddSchema,
  memoryListOptionsSchema,
  memoryPatchSchema,
  memorySchema,
  normalizeMemoryContent,
} from '../../shared/schema.js';
import type {
  MemoryAddInput,
  MemoryCursor,
  MemoryListOptions,
  MemoryPatch,
  MemoryRecord,
  MemorySaveResult,
} from '../../shared/schema.js';

import {
  type BotDomain,
  read,
  write,
  nextTimestamp,
  compareId,
  missingBot,
  missingMemory,
  deleteBotMemories,
} from './domain.js';
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
  return Object.freeze({
    ...record,
    tags: Object.freeze([...record.tags]),
    source: record.source === undefined ? undefined : Object.freeze({ ...record.source }),
  });
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase();
export function tokenizeMemoryQuery(query: string): string[] {
  const words =
    normalize(query)
      .replace(/(\p{Script=Han}+)/gu, ' $1 ')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) => {
        const chars = [...word];
        return /^\p{Script=Han}+$/u.test(word) && chars.length > 1
          ? chars.slice(0, -1).map((char, index) => char + chars[index + 1])
          : [word];
      }),
    ),
  ];
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
  constructor(
    private readonly domain: BotDomain,
    private readonly search: MemorySearch = lexicalMemorySearch,
  ) {}

  async add(input: MemoryAddInput): Promise<MemoryRecord> {
    return (await this.persist(input, false)).record;
  }

  /** Match and merge inside the domain writer, including across Store instances. */
  async saveUnique(input: MemoryAddInput, signal?: AbortSignal): Promise<MemorySaveResult> {
    const { record, deduplicated } = await this.persist(input, true, signal);
    return { id: record.id, deduplicated };
  }

  private async persist(
    input: MemoryAddInput,
    deduplicate: boolean,
    signal?: AbortSignal,
  ): Promise<{
    record: MemoryRecord;
    deduplicated: boolean;
  }> {
    const fields = parseInput(memoryAddSchema, input);
    return write(this.domain, async () => {
      signal?.throwIfAborted();
      if (!this.domain.table('bots').get(fields.botId)) throw missingBot(fields.botId);
      const table = this.domain.table('memories');
      if (deduplicate) {
        const normalized = normalizeMemoryContent(fields.content);
        const existing = [...table.entries()]
          .map(([, record]) => record)
          .filter((record) => record.botId === fields.botId && normalizeMemoryContent(record.content) === normalized)
          .sort((a, b) => a.createdAt - b.createdAt || compareId(a.id, b.id))[0];
        if (existing) {
          const record = parseInput(memorySchema, {
            ...existing,
            tags: [...new Set([...existing.tags, ...fields.tags])],
            pinned: existing.pinned || fields.pinned,
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
    return write(
      this.domain,
      async () =>
        structuredClone(
          await this.domain.table('memories').update(key, (current) => {
            if (current.botId !== owner) throw missingMemory();
            return parseInput(memorySchema, { ...current, ...fields, updatedAt: nextTimestamp(current.updatedAt) });
          }),
        ),
      'memory/not-found',
    );
  }

  async remove(botId: string, id: string): Promise<void> {
    const owner = parseInput(botIdSchema, botId);
    const key = parseInput(memoryIdSchema, id);
    return write(
      this.domain,
      async () => {
        const table = this.domain.table('memories');
        if (table.get(key)?.botId !== owner || !(await table.delete(key))) throw missingMemory();
      },
      'memory/not-found',
    );
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
    return read(() =>
      [...this.domain.table('memories').entries()]
        .filter(([, record]) => record.botId === owner)
        .map(([, record]) => record)
        .filter(
          (record) =>
            (filter.tag === undefined || record.tags.includes(filter.tag)) &&
            (filter.pinned === undefined || record.pinned === filter.pinned) &&
            (filter.before === undefined || compareMemory(record, filter.before) > 0) &&
            (filter.query === undefined ||
              this.search.matches(this.search === lexicalMemorySearch ? record : searchView(record), filter.query)),
        )
        .sort(compareMemory)
        .slice(0, filter.limit)
        .map((record) => structuredClone(record)),
    );
  }

  /** Serialized with adds/removes through either Store; not a cross-table transaction. */
  async removeByBot(botId: string): Promise<number> {
    const owner = parseInput(botIdSchema, botId);
    return write(this.domain, () => deleteBotMemories(this.domain, owner));
  }
}
