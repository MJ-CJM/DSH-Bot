import { z } from 'zod';
import { botIdSchema, memoryIdSchema } from '../../shared/ids.js';
import {
  MEMORY_LIST_MAX_LIMIT, memoryAddSchema, memoryListOptionsSchema,
} from '../../shared/schema.js';
import type { MemoryCursor, MemoryRecord, MemorySaveResult } from '../../shared/schema.js';
import { parseInput } from '../errors.js';
import type { MemoryStore } from '../store.js';
import { rejectModelSecrets } from './secrets.js';

// These strict schemas are also the tool boundary: identity and provenance are
// supplied by the Host, never accepted from model arguments.
export const memorySaveInputSchema = memoryAddSchema.omit({ botId: true, source: true });
export const memorySearchInputSchema = memoryListOptionsSchema.pick({ query: true, limit: true })
  .extend({ query: z.string(), limit: memoryListOptionsSchema.shape.limit.optional() });
export const memoryListInputSchema = memoryListOptionsSchema.pick({ tag: true, pinned: true, limit: true })
  .extend({ limit: memoryListOptionsSchema.shape.limit.optional() });
export const memoryForgetInputSchema = z.strictObject({ id: memoryIdSchema });
export type MemorySaveInput = z.input<typeof memorySaveInputSchema>;
export type MemorySearchInput = z.input<typeof memorySearchInputSchema>;
export type MemoryListInput = z.input<typeof memoryListInputSchema>;
export type MemoryForgetInput = z.input<typeof memoryForgetInputSchema>;
export type MemoryOperationExecutor = <T>(operation: () => T | Promise<T>) => Promise<T>;

const executeImmediately: MemoryOperationExecutor = async (operation) => operation();
const injectLimitSchema = z.number().int().nonnegative();

/** A capability for exactly one Bot. The registry supplies its lifecycle queue. */
export class BotMemoryService {
  private readonly botId: string;
  private readonly defaultListLimit: number;

  constructor(
    private readonly store: MemoryStore,
    botId: string,
    private readonly execute: MemoryOperationExecutor = executeImmediately,
    defaultListLimit = 20,
  ) {
    this.botId = parseInput(botIdSchema, botId);
    this.defaultListLimit = parseInput(memoryListOptionsSchema.shape.limit, defaultListLimit);
  }

  async save(input: MemorySaveInput, source?: MemoryRecord['source'], signal?: AbortSignal): Promise<MemorySaveResult> {
    if (source?.by === 'model') rejectModelSecrets(input);
    const fields = parseInput(memorySaveInputSchema, input);
    const provenance = parseInput(memoryAddSchema.shape.source, source);
    return this.run(() => this.store.saveUnique({
      ...fields, botId: this.botId, ...(provenance === undefined ? {} : { source: provenance }),
    }, signal), signal);
  }

  async search(input: MemorySearchInput, signal?: AbortSignal): Promise<MemoryRecord[]> {
    const fields = parseInput(memorySearchInputSchema, input);
    return this.run(() => this.store.listByBot(this.botId, {
      ...fields, limit: fields.limit ?? this.defaultListLimit,
    }), signal);
  }

  async list(input: MemoryListInput = {}, signal?: AbortSignal): Promise<MemoryRecord[]> {
    const fields = parseInput(memoryListInputSchema, input);
    return this.run(() => this.store.listByBot(this.botId, {
      ...fields, limit: fields.limit ?? this.defaultListLimit,
    }), signal);
  }

  async forget(input: MemoryForgetInput, signal?: AbortSignal): Promise<void> {
    const { id } = parseInput(memoryForgetInputSchema, input);
    return this.run(() => this.store.remove(this.botId, id), signal);
  }

  /** Read all pins plus the latest unpinned records in a single queue slot.
   * Synchronous cursor reads keep every page in the same point-in-time snapshot.
   */
  async snapshot(injectLimit: number): Promise<MemoryRecord[]> {
    const limit = parseInput(injectLimitSchema, injectLimit);
    return this.run(() => {
      const collect = (pinned: boolean, count: number): MemoryRecord[] => {
        const records: MemoryRecord[] = [];
        let before: MemoryCursor | undefined;
        while (records.length < count) {
          const pageSize = Math.min(MEMORY_LIST_MAX_LIMIT, count - records.length);
          const page = this.store.listByBot(this.botId, { pinned, limit: pageSize, before });
          records.push(...page);
          const last = page.at(-1);
          if (page.length < pageSize || !last) break;
          before = { id: last.id, pinned: last.pinned, updatedAt: last.updatedAt };
        }
        return records;
      };
      return [...collect(true, Number.POSITIVE_INFINITY), ...collect(false, limit)];
    });
  }

  private run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.execute(() => {
      // Check after waiting for the registry queue, before touching storage.
      signal?.throwIfAborted();
      return operation();
    });
  }
}
