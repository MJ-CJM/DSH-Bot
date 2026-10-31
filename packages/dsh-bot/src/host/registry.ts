import { createHash } from 'node:crypto';
import { createForChatSchema, type CreateForChatInput, type StartOnboardingInput } from '../shared/onboarding.js';
import type { Onboarding } from './onboarding/coordinator.js';
import { AutoShareQuota } from './memory/quota.js';
import { autoShareToggleSchema } from '../shared/data-flow.js';
import { migrateMemoryDeny } from '../shared/memory-tool-names.js';
import { MemoryManagement } from './memory/facade.js';
import { retireShard } from './memory/shards.js';
import { isDeepStrictEqual } from 'node:util';
import type {} from '@deepseek-ai/dsh-workspace';
import { Remote } from '@deepseek-ai/dsh-typert-protocol';
import { botIdSchema } from '../shared/ids.js';
import {
  botChangeSchema, botsWorkspaceSchema,
  type CatalogInfo, type BotStatus, type BotChange, type BotHome, type BotsWorkspace, type DshBotMethods,
} from '../shared/remote-contract.js';
import {
  type BotCreateInput, type BotPatch, type BotRecord, type BotRemoveOptions,
  botPatchSchema, botRemoveOptionsSchema, botSchema, normalizeBotPatch,
} from '../shared/schema.js';
import { DshBotError, parseInput } from './errors.js';
import { validateDefaultCwd } from './home.js';
import { BotMemoryService } from './memory/service.js';
import type { ActivityListResult, ActivitySession } from '../shared/activity.js';
import { activitySessionIdSchema } from '../shared/activity.js';
import type { ActivityStore } from './store.js';
import { RegistryMutations } from './registry/mutations.js';
import { messageOf } from './registry/identity.js';
import type { BotChanged } from './registry/types.js';
export type { BotChanged } from './registry/types.js';
export { Config } from './registry-config.js';
export { composeBotPreset } from './composer.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBots: DshBotRegistry;
  }
  interface Events {
    'dsh-bot/changed'(change: BotChanged): void;
  }
}

export class DshBotRegistry extends RegistryMutations implements DshBotMethods {
  onboarding?: Onboarding;
  private readonly personaListeners = new Set<() => void>();
  /** Synchronous generation snapshot for preset plugins. It deliberately bypasses
   * the Remote queue: register() activates rows while that queue is held. */
  directorySnapshot() {
    if (!this.initialized || this.stopping) return [];
    return this.stores.bots.list().map(({ id, name, description }) => ({ id, name, description }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  presetBot(botId: string): BotRecord {
    const key = parseInput(botIdSchema, botId);
    const bot = this.activating.get(key) ?? this.leases.get(`${this.config.presetIdPrefix}${key}`)?.bot;
    if (!bot) throw new DshBotError('bot/unavailable', `No activating Bot preset for '${key}'`);
    return structuredClone(bot);
  }

  /** Host-only committed snapshot for a live Agent. Never observe an activating
   * candidate or adopt a deleted/recreated Bot with the same display ID. */
  personaSnapshot(botId: string, createdAt: number): BotRecord['persona'] | undefined {
    if (!this.initialized || this.stopping || this.failed) return undefined;
    const bot = this.stores.bots.list().find(row => row.id === botId && row.createdAt === createdAt);
    return bot ? { ...bot.persona } : undefined;
  }

  /** Synchronous final onboarding admission after its durable dispatch receipt. */
  onboardingSnapshot(botId: string, createdAt: number): BotRecord | undefined {
    if (!this.initialized || this.stopping || this.failed) return undefined;
    const bot = this.stores.bots.list().find(row => row.id === botId && row.createdAt === createdAt);
    return bot ? structuredClone(bot) : undefined;
  }

  /** Host-only synchronous commit notification; listeners cannot undo a commit. */
  subscribePersonaChanges(listener: () => void): () => void {
    this.personaListeners.add(listener);
    return () => { this.personaListeners.delete(listener); };
  }

  /** Host-only, Bot-bound access to the existing domain; never open a second store.
   * Join the registry queue so unload drains accepted operations before closing it.
   */
  memoryFor(botId: string): BotMemoryService {
    this.assertReady();
    const key = parseInput(botIdSchema, botId);
    return new BotMemoryService(
      this.stores.memories,
      key,
      (operation) =>
        this.enqueue(() => {
          this.stores.bots.get(key);
          return operation();
        }),
      this.config.memoryListLimit,
    );
  }

  async autoShareStatus() {
    return this.enqueue(() => {
      if (!this.memoryKernel) throw new Error('Memory kernel unavailable');
      return { ...new AutoShareQuota(this.memoryKernel).status(), shadow: this.shadow?.status() };
    });
  }
  shadow?: import('./shadow/planner.js').ShadowPlanner;
  async setAutoShare(input: import('zod').z.input<typeof autoShareToggleSchema>) {
    const f = autoShareToggleSchema.parse(input);
    return this.enqueue(async () => {
      if (!this.memoryKernel) throw new Error('Memory kernel unavailable');
      const quota = new AutoShareQuota(this.memoryKernel), { revision: _revision, ...policy } = quota.policy;
      await quota.configure({ ...policy, enabled: f.enabled }, f.expectedRevision); this.invalidate();
      return { ...quota.status(), shadow: this.shadow?.status() };
    });
  }

  async manageMemory<T>(operation: (memory: MemoryManagement) => T | Promise<T>): Promise<T> {
    return this.enqueue(() => {
      if (!this.memoryKernel) throw new Error('Memory kernel unavailable');
      return operation(new MemoryManagement(this.memoryKernel, this.stores.bots, this.config.journalDays));
    });
  }

  /** Management-only total includes orphaned legacy rows that have no current Bot panel. */
  async memoryQuarantineCount(): Promise<number> {
    return this.enqueue(() => {
      const kernel = this.memoryKernel;
      if (!kernel) throw new Error('Memory kernel is not ready');
      const state = kernel.snapshot;
      return [...kernel.domain.table('migration_items').entries()].filter(([, item]) =>
        item.quarantine && state.versions.get(item.memoryId)?.status === 'proposed').length;
    });
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
      const mains = await Promise.all(bots.map(async (bot) => ({ bot, main: await mainSessions.find(bot.id) })));
      const sessions = data.sessions.filter((row) =>
        mains.some(({ bot, main }) => bot.id === row.botId && main?.sessionId === row.sessionId),
      );
      return {
        sessions,
        bots: bots.map((bot) => {
          const latest = sessions.find((row) => row.botId === bot.id);
          return {
            botId: bot.id,
            lastActivityAt: latest?.updatedAt ?? 0,
            unreadCount: latest?.unread ? 1 : 0,
            ...(latest ? { latest: { ...latest.lastMessage, sessionId: latest.sessionId } } : {}),
          };
        }),
      };
    } catch (error) {
      if (error instanceof DshBotError && (error.code === 'store/unavailable' || error.code === 'bot/unavailable')) {
        return { sessions: [], bots: [] };
      }
      throw error;
    }
  }

  async markActivityRead(sessionId: string): Promise<ActivitySession> {
    const key = parseInput(activitySessionIdSchema, sessionId);
    try {
      return await this.enqueue(async () => {
        const previous = this.stores.activities.list();
        const result = await this.stores.activities.markRead(key);
        if (!isDeepStrictEqual(previous, this.stores.activities.list())) this.invalidate();
        return result;
      });
    } catch (error) {
      if (error instanceof DshBotError && error.code === 'bot/unavailable') {
        throw new DshBotError('store/unavailable', 'Activity store is unavailable', { cause: error });
      }
      throw error;
    }
  }

  protected changed(id: string, action: BotChanged['action']): void {
    for (const listener of this.personaListeners) {
      try { listener(); }
      catch (error) { this.ctx.logger.warn(`[dsh-bot] persona listener failed: ${messageOf(error)}`); }
    }
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
    const changed = () => {
      pending = true;
      wake?.();
    };
    const release = this.watchOwner.effect(() => {
      this.changeListeners.add(changed);
      return () => {
        this.changeListeners.delete(changed);
        stopped = true;
        wake?.();
      };
    }, 'dsh-bot: change stream');
    const abort = () => {
      release();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (!stopped && !signal.aborted) {
        if (pending) {
          pending = false;
          yield botChangeSchema.parse({ revision: this.changeRevision });
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      release();
    }
  }

  @Remote
  async list(): Promise<BotRecord[]> {
    return this.enqueue(() => this.stores.bots.list());
  }

  @Remote
  async catalogInfo(): Promise<CatalogInfo> {
    return this.enqueue(() => ({ presetIdPrefix: this.config.presetIdPrefix }));
  }

  @Remote
  async status(): Promise<BotStatus[]> {
    const rows = await this.enqueue(() => this.statusRows());
    const mainSessions = this.mainSessions;
    if (!mainSessions) return rows;
    return Promise.all(
      rows.map(async (row) => {
        const main = await mainSessions.find(row.id);
        return { ...row, ...(main ? { mainSessionId: main.sessionId } : {}) };
      }),
    );
  }

  @Remote
  async openConversation(botId: string) {
    await this.waitUntilReady();
    if (!this.mainSessions) throw new DshBotError('bot/unavailable', 'Main sessions are starting');
    const result = await this.mainSessions.open(parseInput(botIdSchema, botId));
    const graph = this.ctx.get('dshBotReferenceMemory');
    if (graph) {
      const bot = await this.get(botId);
      try {
        await graph.apply({ botId: bot.id, botCreatedAt: bot.createdAt });
      } catch {
        this.ctx.logger.warn('[dsh-bot] reference graph unavailable; internal memory remains active');
      }
    }
    this.invalidate();
    return result;
  }

  @Remote
  async get(id: string): Promise<BotRecord> {
    return this.enqueue(() => this.stores.bots.get(id));
  }

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
  protected async ensureWorkspace(): Promise<BotsWorkspace> {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) throw new DshBotError('bot/unavailable', 'Workspace registry is unavailable');
      const { path } = await this.homes.ensureRoot();
      // Resolve the authoritative path on every request: a saved id can have
      // been deleted, and an existing user-named workspace must retain its name.
      const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path, 'Bots'));
      if (this.stores.bots.botsWorkspaceId() !== workspace.id) await this.stores.bots.saveBotsWorkspaceId(workspace.id);
      // Never attach historical activity here. Native deletion deliberately
      // removed its membership; archive state and old private-home cwd survive.
      return botsWorkspaceSchema.parse({ workspaceId: workspace.id, path: workspace.path });
    } catch (error) {
      if (error instanceof DshBotError) throw error;
      throw new DshBotError('bot/unavailable', `Cannot ensure the shared Bots workspace: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  @Remote
  async ensureBotsWorkspace(): Promise<BotsWorkspace> {
    return this.enqueue(() => this.ensureWorkspace());
  }

  @Remote
  async create(input: BotCreateInput): Promise<BotRecord> {
    return this.enqueue(() => this.createRecord(input, 'create'), true);
  }

  @Remote
  async createForChat(input: CreateForChatInput): Promise<BotRecord> {
    const f = createForChatSchema.parse(input);
    const inputDigest = createHash('sha256').update(JSON.stringify(f)).digest('hex');
    return this.enqueue(async () => {
      const existing = this.stores.bots.list().find(bot => bot.onboarding?.operationId === f.operationId);
      if (existing) {
        if (existing.onboarding?.inputDigest !== inputDigest) throw new DshBotError('bot/conflict', 'Creation operation input changed');
        return existing;
      }
      if (this.stores.bots.retiredCreation(f.operationId)) throw new DshBotError('bot/conflict', 'Creation operation belongs to a removed Bot');
      return this.createRecord(f.bot, 'create', { operationId: f.operationId, language: f.language, policyVersion: 1, inputDigest });
    }, true);
  }

  @Remote
  async onboardingStatus(botId: string) {
    await this.waitUntilReady();
    if (!this.onboarding) return { botId: parseInput(botIdSchema, botId), state: 'unavailable' as const, retryable: false };
    return this.onboarding.status(botId);
  }

  @Remote
  async startOnboarding(input: StartOnboardingInput) {
    await this.waitUntilReady();
    if (!this.onboarding) throw new DshBotError('bot/unavailable', 'Onboarding is starting');
    return this.onboarding.dispatch(input);
  }

  @Remote
  async retryOnboarding(input: StartOnboardingInput) {
    await this.waitUntilReady();
    if (!this.onboarding) throw new DshBotError('bot/unavailable', 'Onboarding is starting');
    return this.onboarding.dispatch(input, true);
  }

  @Remote
  async update(id: string, patch: BotPatch): Promise<BotRecord> {
    const updated = await this.enqueue(async () => {
      const reviewed = parseInput(botPatchSchema, patch);
      const fields = normalizeBotPatch(reviewed);
      if (fields.tools) fields.tools = { ...fields.tools, deny: migrateMemoryDeny(fields.tools.deny) };
      const previous = this.stores.bots.get(id);
      if ((reviewed.expectedCreatedAt !== undefined && reviewed.expectedCreatedAt !== previous.createdAt)
        || (reviewed.expectedUpdatedAt !== undefined && reviewed.expectedUpdatedAt !== previous.updatedAt)) {
        throw new DshBotError('bot/conflict', 'Bot changed; get its current details and review the update again');
      }
      const candidate = parseInput(botSchema, { ...previous, ...fields });
      await validateDefaultCwd(candidate.defaultCwd);
      const record = await this.transition(id, candidate, () =>
        this.stores.bots.update(id, fields, previous.updatedAt),
      );
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
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        schemaVersion: _schemaVersion,
        onboarding: _onboarding,
        ...fields
      } = original;
      const duplicate = await this.createRecord({ ...fields, id: newId }, 'duplicate');
      await this.ctx
        .get('dshBotConnectors')
        ?.copyDisabled(
          { botId: original.id, botCreatedAt: original.createdAt },
          { botId: duplicate.id, botCreatedAt: duplicate.createdAt },
        );
      return duplicate;
    }, true);
  }

  @Remote('delete')
  async remove(id: string, options?: BotRemoveOptions): Promise<void> {
    return this.enqueue(async () => {
      const key = parseInput(botIdSchema, id);
      const fields = parseInput(botRemoveOptionsSchema, options ?? {});
      const removedBot = this.stores.bots.get(key);
      if ((fields.expectedCreatedAt !== undefined && fields.expectedCreatedAt !== removedBot.createdAt)
        || (fields.expectedUpdatedAt !== undefined && fields.expectedUpdatedAt !== removedBot.updatedAt)) {
        throw new DshBotError('bot/conflict', 'Bot changed; review its current details before deleting');
      }
      if (fields.deleteMemories) await this.stores.memories.removeByBot(key);
      if (this.memoryKernel) await retireShard(this.memoryKernel, { botId: key, botCreatedAt: removedBot.createdAt });
      const removeHome = fields.deleteHome ? await this.homes.prepareRemoval(key) : undefined;
      await this.transition(key, undefined, () => this.stores.bots.remove(key, fields));
      this.changed(key, 'remove');
      try {
        await removeHome?.();
      } catch (error) {
        throw new DshBotError(
          'bot/home-cleanup-failed',
          'Bot was deleted, but its private home cleanup failed; its remaining private files may need manual cleanup',
          { cause: error },
        );
      }
    }, true);
  }
}
