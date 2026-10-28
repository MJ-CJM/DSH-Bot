import { z } from 'zod';
import { botIdSchema, memoryIdSchema } from '../../shared/ids.js';
import {
  MEMORY_LIST_MAX_LIMIT,
  memoryAddSchema,
  memoryListOptionsSchema,
  memoryPatchSchema,
} from '../../shared/schema.js';
import type {
  MemoryCursor,
  MemoryListOptions,
  MemoryPatch,
  MemoryRecord,
  MemorySaveResult,
} from '../../shared/schema.js';
import { parseInput } from '../errors.js';
import type { MemoryPort } from './port.js';
import { rejectModelSecrets } from './secrets.js';
import { failure } from '../stores/domain.js';

// These strict schemas are also the tool boundary: identity and provenance are
// supplied by the Host, never accepted from model arguments.
export const memorySaveInputSchema = memoryAddSchema.omit({ botId: true, source: true });
export const memorySearchInputSchema = memoryListOptionsSchema
  .pick({ query: true, limit: true })
  .extend({ query: z.string(), limit: memoryListOptionsSchema.shape.limit.optional() });
export const memoryListInputSchema = memoryListOptionsSchema
  .pick({ tag: true, pinned: true, limit: true })
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
    private store: MemoryPort,
    botId: string,
    private readonly execute: MemoryOperationExecutor = executeImmediately,
    defaultListLimit = 20,
  ) {
    this.botId = parseInput(botIdSchema, botId);
    this.store = store.forBot?.(botId) ?? store;
    this.defaultListLimit = parseInput(memoryListOptionsSchema.shape.limit, defaultListLimit);
  }

  async save(input: MemorySaveInput, source?: MemoryRecord['source'], signal?: AbortSignal): Promise<MemorySaveResult> {
    if (source?.by === 'model') rejectModelSecrets(input);
    const fields = parseInput(memorySaveInputSchema, input);
    const provenance = parseInput(memoryAddSchema.shape.source, source);
    return this.run(
      () =>
        this.store.saveUnique(
          {
            ...fields,
            botId: this.botId,
            ...(provenance === undefined ? {} : { source: provenance }),
          },
          signal,
        ),
      signal,
    );
  }

  async search(input: MemorySearchInput, signal?: AbortSignal): Promise<MemoryRecord[]> {
    const fields = parseInput(memorySearchInputSchema, input);
    return this.run(
      () =>
        (this.store.readableByBot?.bind(this.store) ?? this.store.listByBot.bind(this.store))(this.botId, {
          ...fields,
          limit: fields.limit ?? this.defaultListLimit,
        }),
      signal,
    );
  }

  async list(input: MemoryListInput = {}, signal?: AbortSignal): Promise<MemoryRecord[]> {
    const fields = parseInput(memoryListInputSchema, input);
    return this.run(
      () =>
        (this.store.readableByBot?.bind(this.store) ?? this.store.listByBot.bind(this.store))(this.botId, {
          ...fields,
          limit: fields.limit ?? this.defaultListLimit,
        }),
      signal,
    );
  }

  async forget(input: MemoryForgetInput, signal?: AbortSignal): Promise<void> {
    const { id } = parseInput(memoryForgetInputSchema, input);
    return this.run(() => this.store.remove(this.botId, id), signal);
  }

  /** Management batches use the same validation, deduplication and registry ownership queue. */
  async saveBatch(inputs: MemorySaveInput[], check: (rows: MemoryRecord[]) => void): Promise<MemorySaveResult[]> {
    const fields = inputs.map((input) => {
      rejectModelSecrets(input);
      return parseInput(memorySaveInputSchema, input);
    });
    return this.run(async () => {
      const rows: MemoryRecord[] = [];
      let before: MemoryCursor | undefined;
      while (true) {
        const page = this.store.listByBot(this.botId, { limit: MEMORY_LIST_MAX_LIMIT, before });
        rows.push(...page);
        const last = page.at(-1);
        if (page.length < MEMORY_LIST_MAX_LIMIT || !last) break;
        before = { id: last.id, pinned: last.pinned, updatedAt: last.updatedAt };
      }
      check(rows);
      const results: MemorySaveResult[] = [];
      for (const input of fields)
        results.push(
          await this.store.saveUnique({ ...input, botId: this.botId, source: { by: 'user', at: Date.now() } }),
        );
      return results;
    });
  }

  /** Cursor reads for management UI; model tools keep their narrower contracts. */
  async query(
    input: Omit<MemoryListOptions, 'limit'> & { limit?: number },
    signal?: AbortSignal,
  ): Promise<MemoryRecord[]> {
    const fields = parseInput(memoryListOptionsSchema, { ...input, limit: input.limit ?? this.defaultListLimit });
    return this.run(() => this.store.listByBot(this.botId, fields), signal);
  }

  async update(id: string, patch: MemoryPatch, signal?: AbortSignal): Promise<MemoryRecord> {
    const key = parseInput(memoryIdSchema, id);
    const fields = parseInput(memoryPatchSchema, patch);
    return this.run(() => this.store.update(this.botId, key, fields), signal);
  }

  /** Count every memory in one registry queue slot, without returning its content. */
  async count(signal?: AbortSignal): Promise<number> {
    return this.run(() => this.store.countByBot(this.botId), signal);
  }

  /** Read all pins plus the latest unpinned records in a single queue slot.
   * Synchronous cursor reads keep every page in the same point-in-time snapshot.
   */
  async snapshot(injectLimit: number): Promise<MemoryRecord[]> {
    return this.withSnapshot(injectLimit, async (rows) => rows);
  }

  /** Hold the existing registry write queue while verifying and committing a copy receipt. */
  async withSnapshot<T>(injectLimit: number, consume: (rows: MemoryRecord[]) => Promise<T>): Promise<T> {
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
      return consume([...collect(true, Number.POSITIVE_INFINITY), ...collect(false, limit)]);
    });
  }

  private run<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const epoch = this.store.captureEpoch?.();
    return this.execute(() => {
      // Check after waiting for the registry queue, before touching storage.
      signal?.throwIfAborted();
      if (epoch !== undefined) this.store.assertEpoch?.(epoch);
      return operation();
    }).catch(error => {
      if (signal?.aborted && error === signal.reason) throw error;
      throw failure(error);
    });
  }
}
