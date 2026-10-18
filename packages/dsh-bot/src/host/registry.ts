import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import Schema from '@deepseek-ai/schemastery';
import { botIdSchema } from '../shared/ids.js';
import type { BotStatus, DshBotMethods } from '../shared/remote-contract.js';
import {
  type BotCreateInput, type BotPatch, type BotRecord, type BotRemoveOptions, MEMORY_LIST_MAX_LIMIT,
  botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema, normalizeBotPatch,
} from '../shared/schema.js';
import { DshBotError, parseInput } from './errors.js';
import { composeBotPreset, ensureBotSkillsDirectory } from './composer.js';
export { composeBotPreset } from './composer.js';
import { openBotStores } from './store.js';
import { BotMemoryService } from './memory/service.js';

export interface Config {
  seedExamples: boolean;
  presetIdPrefix: string;
  presetOrder: number;
  /** Files such as skills; storageDomain retains its separately configured backend root. */
  dataDir: string;
  maxInjectChars: number;
  memorySectionOrder: number;
  memoryListLimit: number;
  enableBotManageInStandard: boolean;
  botManagePersonaPreviewChars: number;
}
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  seedExamples: Schema.boolean().default(true),
  enableBotManageInStandard: Schema.boolean().default(false),
  botManagePersonaPreviewChars: Schema.transform(Schema.number(), (value) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('botManagePersonaPreviewChars must be a positive safe integer');
    return value;
  }).default(200),
  presetIdPrefix: Schema.string().pattern(/^[a-z][a-z0-9-]*$/).default('bot-'),
  presetOrder: Schema.transform(Schema.number(), (value) => {
    if (!Number.isFinite(value)) throw new TypeError('presetOrder must be finite');
    return value;
  }).default(50),
  dataDir: Schema.string().pattern(/\S/).default('$DSH_HOME/dsh-bot'),
  maxInjectChars: Schema.transform(Schema.number(), (value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('maxInjectChars must be a nonnegative safe integer');
    return value;
  }).default(4000),
  memorySectionOrder: Schema.transform(Schema.number(), (value) => {
    // rc.2: persona prefix = 0, the first tool policy (PTC_ONLY) = 800.
    if (!Number.isFinite(value) || value <= 0 || value >= 800) throw new TypeError('memorySectionOrder must be between 0 and 800');
    return value;
  }).default(100),
  memoryListLimit: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < 1 || value > MEMORY_LIST_MAX_LIMIT) {
      throw new TypeError(`memoryListLimit must be an integer from 1 to ${MEMORY_LIST_MAX_LIMIT}`);
    }
    return value;
  }).default(20),
});

export interface BotChanged {
  id: string;
  action: 'create' | 'update' | 'duplicate' | 'remove';
}
declare module '@deepseek-ai/cordis' {
  interface Context { dshBots: DshBotRegistry }
  interface Events { 'dsh-bot/changed'(change: BotChanged): void }
}

const examples: readonly BotCreateInput[] = [
  { id: 'assistant', name: '通用助手', description: '协助处理日常问题与任务。',
    persona: { prefix: '你是一位认真、友善的通用助手。请用清晰的中文回答问题，说明不确定之处，并提供可执行的建议。' } },
  { id: 'researcher', name: '研究员', description: '查证信息、分析资料并整理研究结论。',
    persona: { prefix: '你是一位严谨的研究员。请区分事实、推断与假设，核实来源，以中文整理证据、分析方法和局限。' } },
];

type Lease = { definition: PresetDefinition; bot: BotRecord; dispose: () => Promise<void> };
function sameBotConfig(left: BotRecord, right: BotRecord): boolean {
  const { createdAt: _lc, updatedAt: _lu, ...l } = left;
  const { createdAt: _rc, updatedAt: _ru, ...r } = right;
  return isDeepStrictEqual(l, r);
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export class DshBotRegistry extends TypertRemoteService implements DshBotMethods {
  static inject = ['storageDomain', 'agentPresets'];
  static Config = Config;
  readonly config: Config;
  private stores!: Awaited<ReturnType<typeof openBotStores>>;
  private readonly leases = new Map<string, Lease>();
  private readonly activating = new Map<string, BotRecord>();
  private readonly ready: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private failed = false;
  private initialized = false;
  private started = false;
  private startupError?: string;
  private readonly diagnostics = new Map<string, string>();

  constructor(ctx: Context, config: Config, start: () => Promise<void> = async () => {}) {
    super(ctx, 'dshBots', { namespace: 'dshBot' });
    const parsed = Config(config);
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.config = { ...parsed, dataDir: resolve(parsed.dataDir.replace(/^\$DSH_HOME(?=\/|$)/, home)) };
    this.ready = (async () => {
      await start();
      if (this.stopping) return;
      this.started = true;
      await this.initialize();
      this.initialized = true;
    })().catch((error: unknown) => {
      this.startupError = messageOf(error);
      this.ctx.logger.error(`[dsh-bot] startup failed bot=*: ${this.startupError}`);
    });
    // Publish the service before Loader settlement. Never join the Loader from
    // its own teardown; once initialization starts, all resources are joined.
    ctx.effect(() => () => {
      this.stopping = true;
      if (this.started) return this.ready;
    }, 'dsh-bot: startup guard');
  }

  async [Service.init](): Promise<void> { await this.ready; }

  async waitUntilReady(): Promise<void> {
    await this.ready;
    this.assertReady();
  }

  private assertReady(): void {
    if (!this.initialized || this.stopping) {
      throw new DshBotError('bot/unavailable', this.startupError
        ? `Bot registry startup failed: ${this.startupError}` : 'Bot registry is not ready or is stopping');
    }
  }

  private async initialize(): Promise<void> {
    // A single owning effect drains API operations before releasing its collected
    // preset leases and domain. Updating a lease never moves it to an agent scope.
    await this.ctx.effect(async () => {
      const shutdown = async () => {
        this.stopping = true;
        await this.tail;
        const errors: unknown[] = [];
        for (const lease of [...this.leases.values()].reverse()) {
          try { await this.release(lease); } catch (error) { errors.push(error); }
        }
        try { await this.stores?.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'DSH Bot registry cleanup failed');
      };
      try {
        this.stores = await openBotStores(this.ctx, { beforeClose: async () => {
          this.stopping = true;
          await this.tail;
        } });
        if (this.config.seedExamples) await this.stores.bots.seedExamples(examples);
        for (const bot of this.stores.bots.list()) {
          try {
            await ensureBotSkillsDirectory(bot.id, this.config);
            await this.acquire(await composeBotPreset(bot, this.ctx, this.config), bot);
          }
          catch (error) {
            this.diagnostics.set(bot.id, messageOf(error));
            this.ctx.logger.error(`[dsh-bot] preset startup failed bot=${bot.id}: ${messageOf(error)}`);
          }
        }
        this.ctx.logger.info(`[dsh-bot] registered ${this.leases.size} presets: ${[...this.leases.keys()].join(', ')}`);
      } catch (error) {
        this.failed = true;
        try { await shutdown(); } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'DSH Bot registry startup and cleanup failed');
        }
        throw error;
      }
      return shutdown;
    }, 'dsh-bot: registry presets and stores');
  }

  private async enqueue<T>(operation: () => Promise<T> | T, write = false): Promise<T> {
    this.assertReady();
    const pending = this.tail.then(async () => {
      if (write && this.failed) await this.reconcile();
      return operation();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  /** Only retained disposer handles establish ownership; a prefix is not ownership. */
  private async reconcile(): Promise<void> {
    try {
      const expected = new Map<string, { bot: BotRecord; definition: PresetDefinition }>();
      for (const bot of this.stores.bots.list()) {
        await ensureBotSkillsDirectory(bot.id, this.config);
        const definition = await composeBotPreset(bot, this.ctx, this.config);
        expected.set(definition.id, { bot, definition });
      }
      const roster = new Map((await this.ctx.agentPresets.list()).map((row) => [row.id, row]));
      for (const [id, lease] of this.leases) {
        const wanted = expected.get(id);
        if (!wanted || !roster.has(id) || roster.get(id)?.broken !== undefined
          || !isDeepStrictEqual(lease.definition, wanted.definition) || !sameBotConfig(lease.bot, wanted.bot)) await this.release(lease);
      }
      for (const [id, { bot, definition }] of expected) {
        if (!this.leases.has(id)) {
          try { await this.acquire(definition, bot); }
          catch (error) {
            this.diagnostics.set(bot.id, messageOf(error));
            this.ctx.logger.error(`[dsh-bot] reconcile failed bot=${bot.id}: ${messageOf(error)}`);
            throw error;
          }
        }
      }
      const invalid = (await this.statusRows()).find((row) => row.preset.state !== 'ok');
      if (invalid) throw new Error(`Bot '${invalid.id}': ${invalid.preset.reason ?? invalid.preset.state}`);
      this.diagnostics.clear();
      this.failed = false;
    } catch (error) {
      throw new DshBotError('bot/unavailable', `Preset reconciliation failed: ${messageOf(error)}`, { cause: error });
    }
  }

  private async statusRows(): Promise<BotStatus[]> {
    const roster = new Map((await this.ctx.agentPresets.list()).map((row) => [row.id, row]));
    // Template reads are diagnostic only: never recompose/unload a retained
    // generation from status(). Retry each query so a recovered template clears.
    const bots = this.stores.bots.list();
    const templateErrors = new Map<string, string>();
    for (const template of new Set(bots.map((bot) => bot.template))) {
      try { await this.ctx.agentPresets.readDocument(template); }
      catch (error) { templateErrors.set(template, `Cannot read template '${template}': ${messageOf(error)}`); }
    }
    return bots.map((bot): BotStatus => {
      const presetId = `${this.config.presetIdPrefix}${bot.id}`;
      const row = roster.get(presetId);
      const templateError = templateErrors.get(bot.template);
      if (templateError) return { id: bot.id, presetId, preset: { state: 'broken', reason: templateError } };
      if (!row) return { id: bot.id, presetId, preset: {
        state: 'missing', reason: this.diagnostics.get(bot.id) ?? `Preset '${presetId}' is not registered`,
      } };
      const lease = this.leases.get(presetId);
      const reason = row.broken ?? (!lease ? 'Preset id is owned by another registration'
        : !sameBotConfig(lease.bot, bot) ? 'Preset differs from the stored Bot' : undefined);
      return { id: bot.id, presetId, preset: reason === undefined ? { state: 'ok' } : { state: 'broken', reason } };
    });
  }

  private async release(lease: Lease): Promise<void> {
    await lease.dispose();
    this.leases.delete(lease.definition.id);
  }

  /** Synchronous generation snapshot for preset plugins. It deliberately bypasses
   * the Remote queue: register() activates rows while that queue is held. */
  presetBot(botId: string): BotRecord {
    const key = parseInput(botIdSchema, botId);
    const bot = this.activating.get(key) ?? this.leases.get(`${this.config.presetIdPrefix}${key}`)?.bot;
    if (!bot) throw new DshBotError('bot/unavailable', `No activating Bot preset for '${key}'`);
    return structuredClone(bot);
  }

  /** Host-only, Bot-bound access to the existing domain; never open a second store.
   * Join the registry queue so unload drains accepted operations before closing it.
   */
  memoryFor(botId: string): BotMemoryService {
    this.assertReady();
    const key = parseInput(botIdSchema, botId);
    return new BotMemoryService(this.stores.memories, key, (operation) => this.enqueue(() => {
      this.stores.bots.get(key);
      return operation();
    }), this.config.memoryListLimit);
  }

  private async acquire(definition: PresetDefinition, bot: BotRecord): Promise<void> {
    this.activating.set(bot.id, structuredClone(bot));
    try {
      const dispose = await this.ctx.agentPresets.register(definition);
      this.leases.set(definition.id, { definition, bot: structuredClone(bot), dispose });
      const row = (await this.ctx.agentPresets.list()).find((row) => row.id === definition.id);
      if (!row || row.broken !== undefined) throw new Error(row?.broken ?? `Preset '${definition.id}' missing after registration`);
    } catch (error) {
      throw new DshBotError('bot/preset-failed', `Preset '${definition.id}' failed: ${messageOf(error)}`, { cause: error });
    } finally { this.activating.delete(bot.id); }
  }

  private async transition<T>(id: string, candidate: BotRecord | undefined, commit: () => Promise<T>): Promise<T> {
    const presetId = `${this.config.presetIdPrefix}${id}`;
    // Prepare before retiring the current generation: parse/I/O failures have no preset gap.
    const definition = candidate ? await composeBotPreset(candidate, this.ctx, this.config) : undefined;
    if (candidate) await ensureBotSkillsDirectory(candidate.id, this.config);
    const previous = this.leases.get(presetId);
    const previousBroken = previous && (await this.ctx.agentPresets.list()).find((row) => row.id === presetId)?.broken !== undefined;
    // An unregister rejection has unknown side effects; do not claim recovery.
    if (previous) {
      try { await this.release(previous); } catch (error) {
        this.failed = true;
        throw new DshBotError('bot/rollback-failed', `Cannot retire '${presetId}': ${messageOf(error)}`, { cause: error });
      }
    }
    try {
      if (candidate && definition) await this.acquire(definition, candidate);
      const result = await commit();
      this.diagnostics.delete(id);
      return result;
    } catch (error) {
      try {
        const failed = this.leases.get(presetId);
        if (failed) await this.release(failed);
        if (previous) {
          try { await this.acquire(previous.definition, previous.bot); }
          catch (restore) {
            // A previously broken startup definition remains editable/deletable.
            if (!previousBroken || !this.leases.has(presetId)) throw restore;
            this.diagnostics.set(id, messageOf(restore));
          }
        }
      } catch (rollback) {
        this.failed = true;
        throw new DshBotError('bot/rollback-failed',
          `${messageOf(error)}; rollback failed: ${messageOf(rollback)}`, { cause: new AggregateError([error, rollback]) });
      }
      throw error;
    }
  }

  private changed(id: string, action: BotChanged['action']): void {
    // Host-only event. Do not await listeners inside the writer queue: listeners
    // may themselves read the registry. Their failures cannot undo a commit.
    void this.ctx.parallel('dsh-bot/changed', { id, action }).catch((error: unknown) => {
      this.ctx.logger.warn(`[dsh-bot] changed listener failed: ${messageOf(error)}`);
    });
  }

  @Remote
  async list(): Promise<BotRecord[]> { return this.enqueue(() => this.stores.bots.list()); }

  @Remote
  async status(): Promise<BotStatus[]> { return this.enqueue(() => this.statusRows()); }

  @Remote
  async get(id: string): Promise<BotRecord> { return this.enqueue(() => this.stores.bots.get(id)); }

  private async createRecord(input: BotCreateInput, action: 'create' | 'duplicate'): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    if (this.stores.bots.list().some((bot) => bot.id === fields.id)) {
      throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
    }
    const now = Date.now();
    const candidate = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
    const record = await this.transition(fields.id, candidate, () => this.stores.bots.create(fields));
    this.changed(record.id, action);
    return record;
  }

  @Remote
  async create(input: BotCreateInput): Promise<BotRecord> {
    return this.enqueue(() => this.createRecord(input, 'create'), true);
  }

  @Remote
  async update(id: string, patch: BotPatch): Promise<BotRecord> {
    return this.enqueue(async () => {
      const fields = normalizeBotPatch(parseInput(botPatchSchema, patch));
      const previous = this.stores.bots.get(id);
      const candidate = parseInput(botSchema, { ...previous, ...fields });
      const record = await this.transition(id, candidate, () => this.stores.bots.update(id, fields, previous.updatedAt));
      this.changed(id, 'update');
      return record;
    }, true);
  }

  @Remote
  async duplicate(id: string, newId: string): Promise<BotRecord> {
    return this.enqueue(async () => {
      const original = this.stores.bots.get(id);
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, schemaVersion: _schemaVersion, ...fields } = original;
      return this.createRecord({ ...fields, id: newId }, 'duplicate');
    }, true);
  }

  @Remote('delete')
  async remove(id: string, options?: BotRemoveOptions): Promise<void> {
    return this.enqueue(async () => {
      const key = parseInput(botIdSchema, id);
      const fields = parseInput(botRemoveOptionsSchema, options ?? {});
      this.stores.bots.get(key);
      await this.transition(key, undefined, () => this.stores.bots.remove(key, fields));
      this.changed(key, 'remove');
    }, true);
  }
}
