import { hasOperationCode } from '../../shared/operation-errors.js';
import { access, constants } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import * as mcp from '@deepseek-ai/dsh-mcp-client';
import {
  assignmentInputSchema,
  assignmentSchema,
  connectorInputSchema,
  connectorSchema,
  legacyImportSchema,
  sameBot,
} from '../../shared/integrations.js';
import type { Assignment, BotKey, Connector, ConnectorRuntime } from '../../shared/integrations.js';
import type { DshBotRegistry } from '../registry.js';
import type { IntegrationStores } from '../common/integration-stores.js';
import { digest, need, OperationError, parse, Serial } from '../common/operations.js';

type Child = { dispose(): Promise<void>; await(): Promise<void> };
interface Live {
  agent: Agent;
  bot: BotKey;
  entries: Map<
    string,
    { status: ConnectorRuntime; definition?: Connector; child?: Child; requested: boolean; epoch: number }
  >;
  stopped: boolean;
  tail: Promise<unknown>;
  close?: () => Promise<void>;
}
export class Connectors {
  readonly queue = new Serial();
  private live = new Set<Live>();
  private stopping = false;
  constructor(
    private ctx: Context,
    private stores: IntegrationStores,
    private registry: DshBotRegistry,
    private timeoutMs: number,
    private changed: () => void,
  ) {}
  definitions() {
    return [...this.stores.connectors.table('definitions').entries()].map(([, r]) => structuredClone(r));
  }
  assignments() {
    return [...this.stores.connectors.table('assignments').entries()].map(([, r]) => ({
      ...structuredClone(r),
      desiredRevision: this.generation(r),
    }));
  }
  runtime() {
    return [...this.live].flatMap((l) =>
      [...l.entries.values()].map((e) => ({
        ...structuredClone(e.status),
        toolCount:
          e.child && e.definition
            ? l.agent.ctx.tools.schemas(l.agent).filter((t) => t.name.startsWith(`mcp__${e.definition?.serverName}__`))
                .length
            : 0,
      })),
    );
  }
  async assertBot(bot: BotKey) {
    const row = await this.registry.get(bot.botId);
    if (row.createdAt !== bot.botCreatedAt) throw new OperationError('conflict');
  }
  async saveDefinition(input: unknown, expected: number) {
    const value = parse(connectorInputSchema, input);
    if (value.command) {
      try {
        await access(value.command, constants.X_OK);
      } catch {
        throw new OperationError('invalid');
      }
    }
    return this.queue.run(async () => {
      const table = this.stores.connectors.table('definitions'),
        old = table.get(value.id);
      if ((old?.revision ?? 0) !== expected) throw new OperationError('conflict');
      for (const a of this.assignments().filter((a) => a.connectorId === value.id)) {
        this.assertNamespace(a, value);
        parse(connectorInputSchema, { ...value, ...a.overrides });
      }
      const now = Date.now();
      const row = parse(connectorSchema, {
        ...value,
        revision: expected + 1,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await table.put(row.id, row);
      // A definition revision invalidates every assignment generation, including
      // crash recovery after a partial earlier assignment update.
      this.markPending(row.id, !row.enabled);
      this.changed();
      return row;
    });
  }
  private generation(a: Assignment) {
    const d = this.stores.connectors.table('definitions').get(a.connectorId);
    return a.revision + (d?.revision ?? 0);
  }
  private assertNamespace(
    a: Pick<Assignment, 'id' | 'bot' | 'connectorId'>,
    definition?: Connector | ReturnType<typeof connectorInputSchema.parse>,
  ) {
    const d = definition ?? this.stores.connectors.table('definitions').get(a.connectorId);
    if (!d) throw new OperationError('not-found');
    if (
      this.assignments().some(
        (other) =>
          other.id !== a.id &&
          sameBot(other.bot, a.bot) &&
          this.stores.connectors.table('definitions').get(other.connectorId)?.serverName === d.serverName,
      )
    )
      throw new OperationError('conflict');
  }
  async saveAssignment(input: unknown, expected: number) {
    const value = parse(assignmentInputSchema, input);
    await this.assertBot(value.bot);
    return this.queue.run(async () => {
      const table = this.stores.connectors.table('assignments'),
        old = table.get(value.id);
      if (
        (old?.revision ?? 0) !== expected ||
        (old && (!sameBot(old.bot, value.bot) || old.connectorId !== value.connectorId))
      )
        throw new OperationError('conflict');
      this.assertNamespace(value);
      const now = Date.now();
      const d = this.stores.connectors.table('definitions').get(value.connectorId);
      if (!d) throw new OperationError('not-found');
      parse(connectorSchema, { ...d, ...value.overrides });
      const row = parse(assignmentSchema, {
        ...value,
        revision: expected + 1,
        desiredRevision: expected + 1 + d.revision,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
        schemaVersion: 1,
      });
      await table.put(row.id, row);
      this.markPending(row.connectorId, !row.enabled, row.id);
      this.changed();
      return row;
    });
  }
  private markPending(connectorId?: string, request = false, assignmentId?: string, bot?: BotKey) {
    for (const l of this.live) {
      if (bot && !sameBot(l.bot, bot)) continue;
      for (const a of this.assignments().filter(
        (a) =>
          sameBot(a.bot, l.bot) &&
          (!connectorId || a.connectorId === connectorId) &&
          (!assignmentId || a.id === assignmentId),
      )) {
        let e = l.entries.get(a.id);
        if (!e) {
          e = {
            requested: request,
            epoch: 0,
            status: {
              assignmentId: a.id,
              sessionId: l.agent.session.id,
              desiredRevision: this.generation(a),
              state: 'pending',
              reasonCode: 'saved',
              toolCount: 0,
            },
          };
          l.entries.set(a.id, e);
        }
        e.epoch++;
        e.status.desiredRevision = this.generation(a);
        e.status.state = 'pending';
        e.status.reasonCode = 'saved';
        e.requested ||= request;
      }
      if (request) void this.schedule(l);
    }
  }
  botChanged(id: string) {
    for (const l of this.live)
      if (l.bot.botId === id) {
        let current = false;
        try {
          current = this.registry.presetBot(id).createdAt === l.bot.botCreatedAt;
        } catch {
          /* removed */
        }
        if (current) continue;
        for (const e of l.entries.values()) {
          e.requested = true;
          e.epoch++;
          e.status.state = 'pending';
          e.status.reasonCode = 'revoked';
        }
        void this.schedule(l);
      }
    this.changed();
  }
  credentialChanged(ref: string) {
    for (const d of this.definitions())
      if (d.credentialBindings.some((b) => b.credentialRef === ref)) this.markPending(d.id);
    this.changed();
  }
  async applyIdle(bot: BotKey) {
    await this.assertBot(bot);
    this.markPending(undefined, false, undefined, bot);
    for (const l of this.live)
      if (sameBot(l.bot, bot)) {
        for (const e of l.entries.values()) e.requested = true;
        await this.schedule(l);
      }
    return this.runtime().filter((s) =>
      [...this.live].some((l) => sameBot(l.bot, bot) && l.agent.session.id === s.sessionId),
    );
  }
  async attach(agent: Agent, bot: BotKey): Promise<() => Promise<void>> {
    if (this.stopping) throw new OperationError('unavailable');
    const l: Live = { agent, bot, entries: new Map(), stopped: false, tail: Promise.resolve() };
    this.live.add(l);
    const guard = agent.ctx.tools.guard((exec) => {
      for (const [id, e] of l.entries) {
        if (!e.child || !e.definition || !exec.name.startsWith(`mcp__${e.definition.serverName}__`)) continue;
        if (this.stopping || l.stopped) return 'Connector revoked';
        const a = this.stores.connectors.table('assignments').get(id),
          d = a && this.stores.connectors.table('definitions').get(a.connectorId);
        let current = false;
        try {
          current = this.registry.presetBot(bot.botId).createdAt === bot.botCreatedAt;
        } catch {
          /* removed */
        }
        if (this.stopping || l.stopped || !current || !a?.enabled || !d?.enabled) return 'Connector revoked';
      }
    });
    const off = agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') void this.schedule(l);
    });
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        if (l.stopped) {
          await l.tail;
          return;
        }
        l.stopped = true;
        await l.tail;
        for (const e of l.entries.values()) {
          await e.child?.dispose();
          e.status.state = 'unavailable';
          e.status.reasonCode = 'agent-closed';
        }
        off();
        guard();
        this.live.delete(l);
        this.changed();
      })());
    l.close = close;
    const owned = agent.ctx.effect(() => close, 'dsh-bot: connector agent');
    for (const a of this.assignments().filter((a) => sameBot(a.bot, bot)))
      l.entries.set(a.id, {
        requested: true,
        epoch: 0,
        status: {
          assignmentId: a.id,
          sessionId: agent.session.id,
          desiredRevision: this.generation(a),
          state: 'pending',
          reasonCode: 'saved',
          toolCount: 0,
        },
      });
    // Agent publication awaits this setup, so there is no concurrent turn yet.
    l.tail = this.applyLive(l, new AbortController().signal).catch(() => {});
    await l.tail;
    return async () => {
      await owned();
      await close();
    };
  }
  private async schedule(l: Live) {
    if (this.stopping || l.stopped || ![...l.entries.values()].some((e) => e.requested)) return;
    const task = l.tail.then(async () => {
      if (this.stopping || l.stopped) return;
      if (l.agent.status !== 'idle') {
        for (const e of l.entries.values()) if (e.requested) e.status.reasonCode = 'busy';
        return;
      }
      try {
        await l.agent.runMaintenance((signal) => this.applyLive(l, signal));
      } catch {
        for (const e of l.entries.values()) if (e.requested) e.status.reasonCode = 'busy';
      }
    });
    l.tail = task.catch(() => {});
    await task;
  }
  private async applyLive(l: Live, signal: AbortSignal) {
    for (const [id, e] of l.entries) {
      if (!e.requested || l.stopped || this.stopping) continue;
      e.requested = false;
      const a = this.stores.connectors.table('assignments').get(id),
        definition = a && this.stores.connectors.table('definitions').get(a.connectorId);
      const d = definition && a ? parse(connectorSchema, { ...definition, ...a.overrides }) : undefined;
      // Guard remains until all old calls have drained at this idle boundary.
      await e.child?.dispose();
      e.child = undefined;
      e.status.toolCount = 0;
      delete e.status.appliedRevision;
      let current = false;
      try {
        current = this.registry.presetBot(l.bot.botId).createdAt === l.bot.botCreatedAt;
      } catch {
        /* removed */
      }
      if (!current || !a?.enabled || !d?.enabled) {
        e.status.state = 'disabled';
        e.status.reasonCode = 'revoked';
        continue;
      }
      const attemptEpoch = e.epoch;
      const generation = this.generation(a);
      e.status.desiredRevision = generation;
      e.definition = d;
      if (l.agent.ctx.tools.schemas(l.agent).some((t) => t.name.startsWith(`mcp__${d.serverName}__`))) {
        e.status.state = 'unavailable';
        e.status.reasonCode = 'namespace-conflict';
        continue;
      }
      e.status.state = 'connecting';
      this.changed();
      let child: ReturnType<Context['plugin']> | undefined;
      try {
        signal.throwIfAborted();
        await this.assertBot(l.bot);
        const env: Record<string, string> = { ...d.literalEnv },
          headers: Record<string, string> = { ...d.literalHeaders };
        for (const b of d.credentialBindings) {
          const secret = await this.ctx.get('credentials')?.resolve(credentialRef(b.credentialRef));
          if (!secret) throw new OperationError('not-found');
          const value =
            b.format === 'bearer'
              ? `Bearer ${secret.value}`
              : b.format === 'basic-token'
                ? `Basic ${Buffer.from(secret.value).toString('base64')}`
                : secret.value;
          (b.destination === 'env' ? env : headers)[b.key] = value;
        }
        if (this.stopping || l.stopped) throw new OperationError('unavailable');
        signal.throwIfAborted();
        // Do not pass config to plugin: resolved secrets exist only in this closure.
        const thisTimeout = this.timeoutMs;
        child = l.agent.ctx.plugin({
          name: 'dsh-bot-private-mcp',
          inject: ['tools'],
          async apply(owner: Context) {
            await mcp.apply(
              owner,
              mcp.Config(
                d.transport === 'stdio'
                  ? {
                      transport: 'stdio',
                      serverName: d.serverName,
                      command: need(d.command),
                      args: d.args,
                      env,
                      cwd: l.agent.session.header.cwd,
                      failOnStartupError: true,
                      toolCallTimeoutMs: thisTimeout,
                    }
                  : {
                      transport: 'streamable-http',
                      serverName: d.serverName,
                      url: need(d.url),
                      headers,
                      failOnStartupError: true,
                      toolCallTimeoutMs: thisTimeout,
                    },
              ),
            );
          },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            child.await(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new OperationError('unavailable')), this.timeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        signal.throwIfAborted();
        if (this.stopping || l.stopped) throw new OperationError('unavailable');
        e.child = child as unknown as Child;
        e.status.appliedRevision = generation;
        e.status.state = 'ready';
        delete e.status.reasonCode;
        e.status.toolCount = l.agent.ctx.tools
          .schemas(l.agent)
          .filter((t) => t.name.startsWith(`mcp__${d.serverName}__`)).length;
        // A save racing connection leaves the applied generation accurately marked.
        if (
          e.epoch !== attemptEpoch ||
          this.generation(need(this.stores.connectors.table('assignments').get(id))) !== generation
        ) {
          e.status.state = 'pending';
          e.status.reasonCode = 'saved';
        }
      } catch (error) {
        await child?.dispose();
        e.status.state = 'unavailable';
        e.status.reasonCode =
          error instanceof OperationError && hasOperationCode(error, 'not-found')
            ? 'missing-credential'
            : this.stopping
              ? 'stopping'
              : 'initialization-failed';
      }
      this.changed();
    }
  }
  async importLegacy(bot: BotKey) {
    await this.assertBot(bot);
    const row = await this.registry.get(bot.botId);
    const hash = digest(row.mcpServers);
    const id = `legacy:${digest([bot, hash]).slice(0, 48)}`;
    return this.queue.run(async () => {
      const previous = this.stores.connectors.table('legacy_imports').get(id);
      if (previous) return previous;
      // Validate the entire batch before touching storage; old dormant values remain unchanged.
      const values = row.mcpServers.map((old, i) =>
        parse(connectorInputSchema, {
          id: `${id}:${i}`,
          label: old.serverName,
          serverName: old.serverName,
          transport: old.transport,
          command: old.command,
          args: old.args ?? [],
          url: old.url,
          enabled: false,
          credentialBindings: Object.entries(old.envRefs ?? {}).map(([key, credentialRef]) => ({
            destination: 'env',
            key,
            credentialRef,
            format: 'raw',
          })),
        }),
      );
      const names = new Set(
        this.assignments()
          .filter((a) => sameBot(a.bot, bot) && !a.id.startsWith(`${id}:`))
          .map((a) => this.stores.connectors.table('definitions').get(a.connectorId)?.serverName),
      );
      for (const v of values) {
        if (names.has(v.serverName)) throw new OperationError('conflict');
        names.add(v.serverName);
      }
      const now = Date.now(),
        meta = { revision: 1, createdAt: now, updatedAt: now, schemaVersion: 1 };
      for (const v of values) {
        await this.stores.connectors.table('definitions').put(v.id, parse(connectorSchema, { ...v, ...meta }));
        await this.stores.connectors
          .table('assignments')
          .put(
            v.id,
            parse(assignmentSchema, { id: v.id, bot, connectorId: v.id, enabled: false, desiredRevision: 2, ...meta }),
          );
      }
      const receipt = parse(legacyImportSchema, {
        id,
        bot,
        digest: hash,
        assignmentIds: values.map((v) => v.id),
        ...meta,
      });
      await this.stores.connectors.table('legacy_imports').put(id, receipt);
      this.changed();
      return receipt;
    });
  }
  async copyDisabled(source: BotKey, target: BotKey) {
    await this.queue.run(async () => {
      const now = Date.now();
      for (const a of this.assignments().filter((a) => sameBot(a.bot, source))) {
        const id = `copy:${digest([target, a.id])}`;
        if (this.stores.connectors.table('assignments').get(id)) continue;
        await this.stores.connectors.table('assignments').put(
          id,
          parse(assignmentSchema, {
            ...a,
            id,
            bot: target,
            enabled: false,
            revision: 1,
            desiredRevision: 1 + need(this.stores.connectors.table('definitions').get(a.connectorId)).revision,
            createdAt: now,
            updatedAt: now,
          }),
        );
      }
      this.changed();
    });
  }
  async close() {
    this.stopping = true;
    await this.queue.close();
    for (const l of [...this.live]) await l.close?.();
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotConnectors: Connectors;
  }
}
