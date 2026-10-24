import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-workspace';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import Schema from '@deepseek-ai/schemastery';
import { botIdSchema } from '../shared/ids.js';
import { botChangeSchema, botsWorkspaceSchema, type CatalogInfo, type BotStatus, type BotChange, type BotHome, type BotsWorkspace, type DshBotMethods } from '../shared/remote-contract.js';
import {
  type BotCreateInput, type BotPatch, type BotRecord, type BotRemoveOptions, MEMORY_LIST_MAX_LIMIT,
  botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema, normalizeBotPatch,
} from '../shared/schema.js';
import { DshBotError, parseInput } from './errors.js';
import { BotHomes, validateDefaultCwd } from './home.js';
import { composeBotPreset, ensureBotSkillsDirectory } from './composer.js';
export { composeBotPreset } from './composer.js';
import { openBotStores } from './store.js';
import { BotMemoryService } from './memory/service.js';
import type { ActivityListResult, ActivitySession } from '../shared/activity.js';
import { activitySessionIdSchema } from '../shared/activity.js';
import type { ActivityStore } from './store.js';
import type { MainSessions } from './main-session.js';

export interface Config {
  referenceMemoryTimeoutMs: number;
  referenceMemoryMaxFileBytes: number;
  groupMaxMembers: number;
  groupMaxTurns: number;
  groupMaxDepth: number;
  groupContextMaxBytes: number;
  groupRoundTimeoutMs: number;
  connectorApplyTimeoutMs: number;
  notificationDailyLimit: number;
  notificationCooldownSec: number;
  notificationRetentionDays: number;
  notificationMaxRecords: number;
  notificationSendTimeoutMs: number;
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
  activityMaxSessionsPerBot: number;
  activityMaxSessionsTotal: number;
}
const activityLimit = (name: string, fallback: number) => Schema.transform(Schema.number(), (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}).default(fallback);
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  referenceMemoryTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  referenceMemoryMaxFileBytes: Schema.number().min(1024).max(67108864).step(1).default(8388608),
  groupMaxMembers: Schema.number().min(2).max(16).step(1).default(8),
  groupMaxTurns: Schema.number().min(1).max(32).step(1).default(8),
  groupMaxDepth: Schema.number().min(1).max(8).step(1).default(1),
  groupContextMaxBytes: Schema.number().min(1024).max(262144).step(1).default(32768),
  groupRoundTimeoutMs: Schema.number().min(1000).max(3600000).step(1).default(300000),
  connectorApplyTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  notificationDailyLimit: Schema.number().min(0).max(1000).step(1).default(20),
  notificationCooldownSec: Schema.number().min(0).max(86400).step(1).default(60),
  notificationRetentionDays: Schema.number().min(1).max(365).step(1).default(30),
  notificationSendTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  notificationMaxRecords: Schema.number().min(1).max(10000).step(1).default(1000),
  activityMaxSessionsPerBot: activityLimit('activityMaxSessionsPerBot', 50),
  activityMaxSessionsTotal: activityLimit('activityMaxSessionsTotal', 1000),
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
  mainSessions?: MainSessions;
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
  // A live old Agent must not match a same-id replacement even if the system
  // clock stalls or moves backwards. A scalar suffices for this Host lifetime.
  private creationTime = 0;
  private readonly diagnostics = new Map<string, string>();
  private changeRevision = 0;
  private readonly changeListeners = new Set<() => void>();
  private readonly watchOwner: Context;
  private readonly homes: BotHomes;
  private releaseResources?: () => Promise<void>;
  private closeTask?: Promise<void>;

  constructor(ctx: Context, config: Config, start: () => Promise<void> = async () => {},
    private readonly assertOwner: () => void = () => {}) {
    super(ctx, 'dshBots', { namespace: 'dshBot' });
    this.watchOwner = ctx;
    const parsed = Config(config);
    const home = resolveDshHome();
    this.homes = new BotHomes(home);
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

  /** Host coordinator joins this before releasing shared-storage ownership. */
  close(): Promise<void> {
    this.closeTask ??= (async () => {
      this.stopping = true;
      if (this.started) await this.ready;
      await this.releaseResources?.();
    })();
    return this.closeTask;
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
      let shutdownTask: Promise<void> | undefined;
      const shutdown = () => shutdownTask ??= (async () => {
        this.stopping = true;
        await this.tail;
        const errors: unknown[] = [];
        for (const lease of [...this.leases.values()].reverse()) {
          try { await this.release(lease); } catch (error) { errors.push(error); }
        }
        try { await this.stores?.close(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'DSH Bot registry cleanup failed');
      })();
      this.releaseResources = shutdown;
      try {
        this.stores = await openBotStores(this.ctx, {
          assertOwner: this.assertOwner,
          activityMaxSessionsPerBot: this.config.activityMaxSessionsPerBot,
          activityMaxSessionsTotal: this.config.activityMaxSessionsTotal,
          beforeClose: async () => {
            this.stopping = true;
            await this.tail;
          },
        });
        // Workspace storage may be temporarily unavailable. Bot management and
        // preset registration still work, while the launch Remote can retry.
        try { await this.ensureWorkspace(); }
        catch (error) { this.ctx.logger.warn(`[dsh-bot] Bots workspace startup failed: ${messageOf(error)}`); }
        for (const id of this.stores.bots.avatarWarnings()) this.ctx.logger.warn(`[dsh-bot] avatar/invalid bot=${id}: unsupported saved avatar hidden; replace or clear explicitly`);
        if (this.config.seedExamples) await this.stores.bots.seedExamples(examples);
        for (const bot of this.stores.bots.list()) {
          this.creationTime = Math.max(this.creationTime, bot.createdAt);
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
    const avatarWarnings = new Set(this.stores.bots.avatarWarnings());
    return bots.map((bot): BotStatus => {
      const presetId = `${this.config.presetIdPrefix}${bot.id}`;
      const identity = { id: bot.id, presetId, ...(avatarWarnings.has(bot.id) ? { warnings: ['avatar/invalid' as const] } : {}) };
      const row = roster.get(presetId);
      const templateError = templateErrors.get(bot.template);
      if (templateError) return { ...identity, preset: { state: 'broken', reason: templateError } };
      if (!row) return { ...identity, preset: {
        state: 'missing', reason: this.diagnostics.get(bot.id) ?? `Preset '${presetId}' is not registered`,
      } };
      const lease = this.leases.get(presetId);
      const reason = row.broken ?? (!lease ? 'Preset id is owned by another registration'
        : !sameBotConfig(lease.bot, bot) ? 'Preset differs from the stored Bot' : undefined);
      return { ...identity, preset: reason === undefined ? { state: 'ok' } : { state: 'broken', reason } };
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

  /** Host-only completion sink. The same queue drains before domain shutdown
   * and serializes accepted messages with Bot deletion and Remote reads. */
  async recordActivity(input: Parameters<ActivityStore['record']>[0]): Promise<void> {
    await this.enqueue(async () => {
      const previous = this.stores.activities.list();
      await this.stores.activities.record(input);
      if (!isDeepStrictEqual(previous, this.stores.activities.list())) this.invalidate();
    });
  }

  async listActivity(): Promise<ActivityListResult> {
    try {
      const data = await this.enqueue(() => this.stores.activities.list());
      const mainSessions = this.mainSessions;
      if (!mainSessions) return data;
      const bots = await this.list();
      const mains = await Promise.all(bots.map(async bot => ({ bot, main: await mainSessions.find(bot.id) })));
      const sessions = data.sessions.filter(row => mains.some(({ bot, main }) => bot.id === row.botId && main?.sessionId === row.sessionId));
      return { sessions, bots: bots.map(bot => {
        const latest = sessions.find(row => row.botId === bot.id);
        return { botId: bot.id, lastActivityAt: latest?.updatedAt ?? 0, unreadCount: latest?.unread ? 1 : 0,
          ...(latest ? { latest: { ...latest.lastMessage, sessionId: latest.sessionId } } : {}) };
      }) };
    }
    catch (error) {
      if (error instanceof DshBotError && (error.code === 'store/unavailable' || error.code === 'bot/unavailable')) {
        return { sessions: [], bots: [] };
      }
      throw error;
    }
  }

  async markActivityRead(sessionId: string): Promise<ActivitySession> {
    const key = parseInput(activitySessionIdSchema, sessionId);
    try { return await this.enqueue(async () => {
      const previous = this.stores.activities.list();
      const result = await this.stores.activities.markRead(key);
      if (!isDeepStrictEqual(previous, this.stores.activities.list())) this.invalidate();
      return result;
    }); }
    catch (error) {
      if (error instanceof DshBotError && error.code === 'bot/unavailable') {
        throw new DshBotError('store/unavailable', 'Activity store is unavailable', { cause: error });
      }
      throw error;
    }
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
    this.invalidate();
    // Host-only event. Do not await listeners inside the writer queue: listeners
    // may themselves read the registry. Their failures cannot undo a commit.
    void this.ctx.parallel('dsh-bot/changed', { id, action }).catch((error: unknown) => {
      this.ctx.logger.warn(`[dsh-bot] changed listener failed: ${messageOf(error)}`);
    });
  }

  invalidate(): void {
    this.changeRevision++;
    for (const changed of this.changeListeners) changed();
  }

  /** A fresh opening invalidation closes the subscribe/read race; each Client
   * keeps one coalesced pending revision, then refetches its ordinary catalogs.
   * Remote cancellation and Host effect disposal both wake a suspended pull.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<BotChange> {
    await this.waitUntilReady();
    if (signal.aborted) return;
    let stopped = false;
    let pending = true;
    let wake: (() => void) | undefined;
    const changed = () => { pending = true; wake?.(); };
    const release = this.watchOwner.effect(() => {
      this.changeListeners.add(changed);
      return () => { this.changeListeners.delete(changed); stopped = true; wake?.(); };
    }, 'dsh-bot: change stream');
    const abort = () => { release(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!stopped && !signal.aborted) {
        if (pending) { pending = false; yield botChangeSchema.parse({ revision: this.changeRevision }); continue; }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      release();
    }
  }

  @Remote
  async list(): Promise<BotRecord[]> { return this.enqueue(() => this.stores.bots.list()); }

  @Remote
  async catalogInfo(): Promise<CatalogInfo> {
    return this.enqueue(() => ({ presetIdPrefix: this.config.presetIdPrefix }));
  }

  @Remote
  async status(): Promise<BotStatus[]> {
    const rows = await this.enqueue(() => this.statusRows());
    const mainSessions = this.mainSessions;
    if (!mainSessions) return rows;
    return Promise.all(rows.map(async row => {
      const main = await mainSessions.find(row.id);
      return { ...row, ...(main ? { mainSessionId: main.sessionId } : {}) };
    }));
  }

  @Remote
  async openConversation(botId: string) {
    await this.waitUntilReady();
    if (!this.mainSessions) throw new DshBotError('bot/unavailable', 'Main sessions are starting');
    const result = await this.mainSessions.open(parseInput(botIdSchema, botId));
    const graph = this.ctx.get('dshBotReferenceMemory');
    if (graph) {
      const bot = await this.get(botId);
      try { await graph.apply({ botId: bot.id, botCreatedAt: bot.createdAt }); }
      catch { this.ctx.logger.warn('[dsh-bot] reference graph unavailable; internal memory remains active'); }
    }
    this.invalidate();
    return result;
  }

  @Remote
  async get(id: string): Promise<BotRecord> { return this.enqueue(() => this.stores.bots.get(id)); }

  @Remote
  async ensureHome(botId: string): Promise<BotHome> {
    return this.enqueue(async () => {
      const bot = this.stores.bots.get(botId);
      return this.homes.ensure(bot.id);
    });
  }

  /** Runs only during initialization or in a registry queue slot. Do not call
   * the queued Remote from initialization: readiness and the writer would wait
   * on each other. The native registry independently serializes path creation.
   */
  private async ensureWorkspace(): Promise<BotsWorkspace> {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) throw new DshBotError('bot/unavailable', 'Workspace registry is unavailable');
      const { path } = await this.homes.ensureRoot();
      // Resolve the authoritative path on every request: a saved id can have
      // been deleted, and an existing user-named workspace must retain its name.
      const workspace = await registry.resolveByPath(path) ?? await registry.create(path, 'Bots');
      if (this.stores.bots.botsWorkspaceId() !== workspace.id) await this.stores.bots.saveBotsWorkspaceId(workspace.id);
      // Never attach historical activity here. Native deletion deliberately
      // removed its membership; archive state and old private-home cwd survive.
      return botsWorkspaceSchema.parse({ workspaceId: workspace.id, path: workspace.path });
    } catch (error) {
      if (error instanceof DshBotError) throw error;
      throw new DshBotError('bot/unavailable', `Cannot ensure the shared Bots workspace: ${messageOf(error)}`, { cause: error });
    }
  }

  @Remote
  async ensureBotsWorkspace(): Promise<BotsWorkspace> { return this.enqueue(() => this.ensureWorkspace()); }

  private async createRecord(input: BotCreateInput, action: 'create' | 'duplicate'): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    await validateDefaultCwd(fields.defaultCwd);
    if (this.stores.bots.list().some((bot) => bot.id === fields.id)) {
      throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
    }
    const now = Math.max(Date.now(), this.creationTime + 1);
    this.creationTime = now;
    const candidate = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
    // The generation snapshot and stored identity must share their creation
    // time even when preset activation crosses a millisecond boundary.
    const record = await this.transition(fields.id, candidate, () => this.stores.bots.create(fields, candidate.createdAt));
    this.changed(record.id, action);
    return record;
  }

  @Remote
  async create(input: BotCreateInput): Promise<BotRecord> {
    return this.enqueue(() => this.createRecord(input, 'create'), true);
  }

  @Remote
  async update(id: string, patch: BotPatch): Promise<BotRecord> {
    const updated = await this.enqueue(async () => {
      const fields = normalizeBotPatch(parseInput(botPatchSchema, patch));
      const previous = this.stores.bots.get(id);
      const candidate = parseInput(botSchema, { ...previous, ...fields });
      await validateDefaultCwd(candidate.defaultCwd);
      const record = await this.transition(id, candidate, () => this.stores.bots.update(id, fields, previous.updatedAt));
      this.changed(id, 'update');
      return record;
    }, true);
    await this.mainSessions?.find(id);
    return updated;
  }

  @Remote
  async duplicate(id: string, newId: string): Promise<BotRecord> {
    return this.enqueue(async () => {
      const original = this.stores.bots.get(id);
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, schemaVersion: _schemaVersion, ...fields } = original;
      const duplicate = await this.createRecord({ ...fields, id: newId }, 'duplicate');
      await this.ctx.get('dshBotConnectors')?.copyDisabled({ botId: original.id, botCreatedAt: original.createdAt }, { botId: duplicate.id, botCreatedAt: duplicate.createdAt });
      return duplicate;
    }, true);
  }

  @Remote('delete')
  async remove(id: string, options?: BotRemoveOptions): Promise<void> {
    return this.enqueue(async () => {
      const key = parseInput(botIdSchema, id);
      const fields = parseInput(botRemoveOptionsSchema, options ?? {});
      this.stores.bots.get(key);
      const removeHome = fields.deleteHome ? await this.homes.prepareRemoval(key) : undefined;
      await this.transition(key, undefined, () => this.stores.bots.remove(key, fields));
      this.changed(key, 'remove');
      try { await removeHome?.(); }
      catch (error) {
        throw new DshBotError('bot/home-cleanup-failed',
          'Bot was deleted, but its private home cleanup failed; its remaining private files may need manual cleanup', { cause: error });
      }
    }, true);
  }
}
