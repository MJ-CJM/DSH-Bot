import { resolve } from 'node:path';
import { type Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { BotsWorkspace } from '../../shared/remote-contract.js';
import type { BotRecord, BotCreateInput } from '../../shared/schema.js';
import { DshBotError } from '../errors.js';
import { BotHomes } from '../home.js';
import { composeBotPreset, ensureBotSkillsDirectory } from '../composer.js';
import { openBotStores } from '../store.js';
import type { MainSessions } from '../main-session.js';
import { Config } from '../registry-config.js';
import type { Lease } from './types.js';
import { messageOf } from './identity.js';
import { MemoryAdmission } from '../memory/admission.js';
import type { MemoryForgetting } from '../memory/forget-service.js';

const examples: readonly BotCreateInput[] = [
  {
    id: 'assistant',
    name: '通用助手',
    description: '协助处理日常问题与任务。',
    persona: { prefix: '你是一位认真、友善的通用助手。请用清晰的中文回答问题，说明不确定之处，并提供可执行的建议。' },
  },
  {
    id: 'researcher',
    name: '研究员',
    description: '查证信息、分析资料并整理研究结论。',
    persona: { prefix: '你是一位严谨的研究员。请区分事实、推断与假设，核实来源，以中文整理证据、分析方法和局限。' },
  },
];

export abstract class RegistryLifecycle extends TypertRemoteService {
  static inject = ['storageDomain', 'agentPresets'];
  static Config = Config;
  readonly config: Config;
  readonly memoryAdmission: MemoryAdmission;
  memoryForget?: MemoryForgetting;
  get memoryKernel() { return this.stores?.memoryKernel; }
  mainSessions?: MainSessions;
  protected stores!: Awaited<ReturnType<typeof openBotStores>>;
  protected readonly leases = new Map<string, Lease>();
  protected readonly activating = new Map<string, BotRecord>();
  protected readonly ready: Promise<void>;
  protected tail: Promise<unknown> = Promise.resolve();
  protected stopping = false;
  protected failed = false;
  protected initialized = false;
  protected started = false;
  protected startupError?: string;
  // A live old Agent must not match a same-id replacement even if the system
  // clock stalls or moves backwards. A scalar suffices for this Host lifetime.
  protected creationTime = 0;
  protected readonly diagnostics = new Map<string, string>();
  protected changeRevision = 0;
  protected readonly changeListeners = new Set<() => void>();
  protected readonly watchOwner: Context;
  protected readonly homes: BotHomes;
  protected readonly memoryOwnerDir: string;
  protected releaseResources?: () => Promise<void>;
  protected closeTask?: Promise<void>;

  constructor(
    ctx: Context,
    config: Config,
    start: () => Promise<void> = async () => {},
    protected readonly assertOwner: () => void = () => {},
  ) {
    super(ctx, 'dshBots', { namespace: 'dshBot' });
    this.watchOwner = ctx;
    const parsed = Config(config);
    this.memoryAdmission = new MemoryAdmission(ctx, parsed.presetIdPrefix);
    const home = resolveDshHome();
    // Skill dataDir changes must not create a second writer for the same native storage.
    this.memoryOwnerDir = resolve(home, 'dsh-bot');
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
    ctx.effect(
      () => () => {
        this.stopping = true;
        if (this.started) return this.ready;
      },
      'dsh-bot: startup guard',
    );
  }

  async [Service.init](): Promise<void> {
    await this.ready;
  }

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

  protected assertReady(): void {
    if (!this.initialized || this.stopping) {
      throw new DshBotError(
        'bot/unavailable',
        this.startupError
          ? `Bot registry startup failed: ${this.startupError}`
          : 'Bot registry is not ready or is stopping',
      );
    }
  }

  protected async initialize(): Promise<void> {
    // A single owning effect drains API operations before releasing its collected
    // preset leases and domain. Updating a lease never moves it to an agent scope.
    await this.ctx.effect(async () => {
      let shutdownTask: Promise<void> | undefined;
      const shutdown = () =>
        (shutdownTask ??= (async () => {
          this.stopping = true;
          await this.memoryAdmission.close();
          await this.tail;
          const errors: unknown[] = [];
          for (const lease of [...this.leases.values()].reverse()) {
            try {
              await this.release(lease);
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await this.stores?.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length) throw new AggregateError(errors, 'DSH Bot registry cleanup failed');
        })());
      this.releaseResources = shutdown;
      try {
        this.stores = await openBotStores(this.ctx, {
          memoryV2: { dataDir: this.memoryOwnerDir, timeZone: this.config.quotaTimeZone },
          assertOwner: this.assertOwner,
          activityMaxSessionsPerBot: this.config.activityMaxSessionsPerBot,
          activityMaxSessionsTotal: this.config.activityMaxSessionsTotal,
          beforeClose: async () => {
            this.stopping = true;
            await this.tail;
          },
        });
        if (!this.stores.memoryKernel) throw new Error('Memory kernel did not initialize');
        this.memoryAdmission.start(this.stores.memoryKernel);
        // Workspace storage may be temporarily unavailable. Bot management and
        // preset registration still work, while the launch Remote can retry.
        try {
          await this.ensureWorkspace();
        } catch (error) {
          this.ctx.logger.warn(`[dsh-bot] Bots workspace startup failed: ${messageOf(error)}`);
        }
        for (const id of this.stores.bots.avatarWarnings())
          this.ctx.logger.warn(
            `[dsh-bot] avatar/invalid bot=${id}: unsupported saved avatar hidden; replace or clear explicitly`,
          );
        if (this.config.seedExamples) await this.stores.bots.seedExamples(examples);
        for (const bot of this.stores.bots.list()) {
          this.creationTime = Math.max(this.creationTime, bot.createdAt);
          try {
            await ensureBotSkillsDirectory(bot.id, this.config);
            await this.acquire(await composeBotPreset(bot, this.ctx, this.config), bot);
          } catch (error) {
            this.diagnostics.set(bot.id, messageOf(error));
            this.ctx.logger.error(`[dsh-bot] preset startup failed bot=${bot.id}: ${messageOf(error)}`);
          }
        }
        this.ctx.logger.info(`[dsh-bot] registered ${this.leases.size} presets: ${[...this.leases.keys()].join(', ')}`);
      } catch (error) {
        this.failed = true;
        try {
          await shutdown();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'DSH Bot registry startup and cleanup failed');
        }
        throw error;
      }
      return shutdown;
    }, 'dsh-bot: registry presets and stores');
  }

  protected async enqueue<T>(operation: () => Promise<T> | T, write = false): Promise<T> {
    this.assertReady();
    const pending = this.tail.then(async () => {
      if (write && this.failed) await this.reconcile();
      return operation();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }

  protected abstract reconcile(): Promise<void>;
  protected abstract ensureWorkspace(): Promise<BotsWorkspace>;
  protected abstract acquire(definition: PresetDefinition, bot: BotRecord): Promise<void>;
  protected abstract release(lease: Lease): Promise<void>;
}
