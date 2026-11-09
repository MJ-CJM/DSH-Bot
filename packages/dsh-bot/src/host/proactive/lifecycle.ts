import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Capabilities } from '../capabilities/service.js';
import { need, Serial } from '../common/operations.js';
import { subjectKey, type Subject } from '../../shared/proactive/follow-up.js';
import type { SuggestionActionReply } from '../../shared/proactive/remote-contract.js';
import {
  followUpPolicyRequest, type FollowUpPolicyRequest, type FollowUpStatusReply, type ProactiveSetupRequest,
} from '../../shared/proactive/setup.js';
import { proactiveConfigFields, type ProactiveConfig } from './config.js';
import { mountProactive } from './index.js';
import { PROACTIVE_HOST, ProactiveRemote } from './remote.js';
import type { ProactiveService } from './service.js';
import { persistScopedBootstrap, setupProactive, withProactiveBinding } from './setup.js';

export function onlyProactiveChanged(previous: ProactiveConfig, next: ProactiveConfig): boolean {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].every(key =>
    Object.hasOwn(proactiveConfigFields, key) ||
    isDeepStrictEqual(Reflect.get(previous, key), Reflect.get(next, key)));
}

export class ProactiveLifecycle {
  readonly #queue = new Serial();
  readonly #policy = new Serial();
  #capabilities?: Pick<Capabilities, 'request'>;
  #fiber?: Fiber;
  #service?: ProactiveService;
  #ready: Promise<void> = Promise.resolve();
  #generation = 0;
  #closed = false;

  constructor(
    private readonly ctx: Context,
    private readonly config: () => ProactiveConfig,
  ) {}

  get service() { return need(this.#service); }

  install() {
    this.ctx.effect(() => this.ctx.on('agent/pre-step', async ({ messages }, next) => {
      // A child owns input validation while mounted. Its replacement interval
      // cannot become a window for an unowned proactive prompt.
      if (this.#service?.acceptsNativeInput ||
          !messages.some(message => ['dsh-bot-proactive-ci', 'dsh-bot-group-proactive'].includes(message.source.kind)))
        return next();
      return { kind: 'reject' };
    }, { prepend: true }), 'dsh-bot: proactive replacement guard');
    this.ctx.effect(() => () => this.close(), 'dsh-bot: proactive lifecycle');
  }

  async start(capabilities: Pick<Capabilities, 'request'>) {
    this.#capabilities = capabilities;
    await this.replace();
    if (this.#closed) return;
    new ProactiveRemote(this.ctx, this);
    await this.ctx.effect(() => this.ctx.typert.register(PROACTIVE_HOST), 'dsh-bot: proactive status contract');
  }

  stopAdmission() { this.#service?.stopAdmission(); }

  replace(): Promise<void> {
    this.stopAdmission();
    const capabilities = this.#capabilities;
    if (!capabilities || this.#closed) return Promise.resolve();
    const config = this.config();
    const generation = ++this.#generation;
    this.#ready = this.#queue.run(async () => {
      if (this.#closed || generation !== this.#generation) return;
      const old = this.#fiber;
      this.#fiber = undefined;
      this.#service = undefined;
      await old?.dispose();
      if (this.#closed || generation !== this.#generation) return;
      const fiber = this.ctx.plugin({
        name: 'dsh-bot-proactive-runtime',
        inject: ['dshBots', 'storageDomain', 'sessionController', 'sessions', 'agents', 'tools'],
        apply: (owner: Context) => mountProactive(owner, config, capabilities, service => {
          if (generation !== this.#generation || this.#closed) service.stopAdmission();
          this.#service = service;
        }),
      });
      this.#fiber = fiber;
      try {
        await fiber.await();
      } catch (error) {
        await fiber.dispose();
        this.#fiber = undefined;
        this.#service = undefined;
        throw error;
      }
    });
    return this.#ready;
  }

  setup(input: ProactiveSetupRequest) {
    if (this.#service?.scopeOnly && input.action === 'connect-github') return 'conflict';
    const config = this.config();
    return setupProactive(this.ctx, config, input, () => !this.#closed && this.config() === config);
  }

  async followUpSummary(subject: Subject): Promise<FollowUpStatusReply> {
    const config = this.config();
    const configEpoch = config.proactiveFollowUpBootstrap?.operation.configEpoch ?? null;
    if (!config.proactiveEnabled) return { state: 'disabled', configEpoch };
    const service = this.#service;
    if (!service) return { state: 'unavailable', configEpoch };
    const summary = await service.followUpSummary(subject).catch(() => undefined);
    if (!summary || this.config() !== config || !service.acceptsNativeInput)
      return { state: 'unavailable', configEpoch: this.config().proactiveFollowUpBootstrap?.operation.configEpoch ?? null };
    return { state: 'ready', configEpoch, scopeOnly: service.scopeOnly, summary };
  }

  followUpPolicy(raw: FollowUpPolicyRequest): Promise<SuggestionActionReply> {
    const input = followUpPolicyRequest.parse(raw);
    return this.#policy.run(async () => {
      if (this.#closed) return { kind: 'unknown', commandId: input.commandId };
      const config = this.config();
      const previous = config.proactiveFollowUpBootstrap;
      if (previous?.operation.operationId === input.commandId) {
        const same = input.action === 'enable-local' &&
          previous.previousConfigEpoch === input.expectedConfigEpoch &&
          previous.operation.expectedRevision === input.expectedRevision &&
          subjectKey(previous.operation.subject) === subjectKey(input.subject);
        if (!same || !config.proactiveEnabled) return { kind: 'rejected', code: 'stale' };
        return this.bootstrapReceipt(input.commandId, previous.operation.configEpoch);
      }
      if ((previous?.operation.configEpoch ?? null) !== input.expectedConfigEpoch)
        return { kind: 'rejected', code: 'stale' };
      if (config.proactiveEnabled) {
        if (input.expectedRevision === null) return { kind: 'rejected', code: 'stale' };
        const service = this.#service;
        if (!service?.acceptsNativeInput) return { kind: 'unknown', commandId: input.commandId };
        const result = await service.followUpPolicy(input.commandId, {
          subject: input.subject, action: input.action, expectedRevision: input.expectedRevision,
        });
        return this.config() === config && service.acceptsNativeInput ? result : { kind: 'unknown', commandId: input.commandId };
      }
      if (input.action !== 'enable-local') return { kind: 'rejected', code: 'forbidden' };
      if (input.expectedRevision !== null) return { kind: 'rejected', code: 'stale' };
      await this.#ready.catch(() => {});
      if (!await this.#service?.ownsFollowUpSubject(input.subject))
        return { kind: 'rejected', code: 'stale' };
      const stillCurrent = () => !this.#closed && this.config() === config;
      if (!stillCurrent()) return { kind: 'rejected', code: 'stale' };
      const configEpoch = randomUUID();
      const binding = await withProactiveBinding(this.ctx, async current => current);
      const persisted = await persistScopedBootstrap(this.ctx, {
        operation: {
          kind: 'enable-local', operationId: input.commandId, configEpoch,
          subject: input.subject, expectedRevision: input.expectedRevision,
        },
        previousConfigEpoch: input.expectedConfigEpoch,
        ...binding,
      }, stillCurrent).catch(() => undefined);
      if (persisted === 'conflict') return { kind: 'rejected', code: 'stale' };
      return this.bootstrapReceipt(input.commandId, configEpoch);
    });
  }

  private async bootstrapReceipt(commandId: string, configEpoch: string): Promise<SuggestionActionReply> {
    const unknown = { kind: 'unknown' as const, commandId };
    await this.#ready.catch(() => {});
    const config = this.config();
    if (this.#closed || !config.proactiveEnabled ||
        config.proactiveFollowUpBootstrap?.operation.configEpoch !== configEpoch) return unknown;
    const service = this.#service;
    if (!service?.scopeOnly) return unknown;
    const result = await service.receipt(commandId).catch(() => undefined);
    if (this.config() !== config || !service.acceptsNativeInput) return unknown;
    return result?.kind === 'receipt' && result.receipt ? { kind: 'receipt', receipt: result.receipt } : unknown;
  }

  private async close() {
    this.#closed = true;
    this.stopAdmission();
    // A native profile edit can hold its lock while awaiting this Fiber's
    // teardown. Queued edits see #closed and cannot commit through its owner.
    void this.#policy.close();
    await this.#queue.close();
    await this.#fiber?.dispose();
  }
}
