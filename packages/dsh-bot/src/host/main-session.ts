import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { z } from 'zod';
import type { BotRecord } from '../shared/schema.js';
import type { DshBotRegistry } from './registry.js';
import { DshBotError } from './errors.js';
import { getBotBinding } from './bot-context.js';

const bindingSchema = z.strictObject({ botId: z.string(), botCreatedAt: z.number(), sessionId: z.string() });
export const mainSessionDomain = defineDomain({
  name: 'dsh_bot_main_session',
  version: 1,
  tables: { bindings: domainTable(bindingSchema) },
});
export interface MainSession {
  sessionId: string;
}
const keyOf = (bot: BotRecord) => JSON.stringify([bot.id, bot.createdAt]);

/** Only metadata/projections choose a main session. No history inspection, deletion or replay. */
export class MainSessions {
  private domain!: Domain<typeof mainSessionDomain>;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private closing?: Promise<void>;
  private readonly pinned = new Map<string, { botId: string; name: string; title: string }>();
  private readonly naming = new Set<string>();
  private off?: () => void;
  private readonly repairs = new Set<string>();
  /** Host-only immutable IDs, including retired Bot generations. No resolve or title writes during forget CAS. */
  boundSessionIds(): string[] {
    return this.domain ? [...this.domain.table('bindings').entries()].map(([, row]) => row.sessionId) : [];
  }
  /** Exact persisted pointer for explicit recovery CAS, including an unavailable former main. */
  boundSessionId(botId: string, botCreatedAt: number): string | undefined {
    return this.domain?.table('bindings').get(JSON.stringify([botId, botCreatedAt]))?.sessionId;
  }
  constructor(
    private readonly ctx: Context,
    private readonly bots: DshBotRegistry,
  ) {}
  async start() {
    await this.ctx.effect(async () => {
      this.domain = await this.ctx.storageDomain.open(mainSessionDomain);
      return () => this.close();
    }, 'dsh-bot: main session store');
    this.off = this.ctx.effect(
      () =>
        this.ctx.on('session/event', (session, event) => {
          const pin = this.pinned.get(session.id);
          if (
            event.type !== 'session/title' ||
            this.naming.has(session.id) ||
            !pin ||
            event.data.title === pin.title ||
            this.repairs.has(session.id)
          )
            return;
          // Coalesce a burst; rename emits the desired title and cannot loop.
          this.repairs.add(session.id);
          queueMicrotask(() => {
            if (this.stopped) return;
            this.pinned.delete(session.id);
            void this.find(pin.botId)
              .catch(() => this.ctx.logger.warn('[dsh-bot] main title repair unavailable'))
              .finally(() => this.repairs.delete(session.id));
          });
        }),
      'dsh-bot: main title invariant',
    );
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new DshBotError('bot/unavailable', 'Main sessions are closing'));
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  private async header(id: string): Promise<SessionHeader | undefined> {
    const live = this.ctx.sessions.get(id as SessionId)?.header;
    if (live) return live;
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence) throw new DshBotError('bot/unavailable', 'Session metadata is unavailable');
    return (await persistence.stat(id as SessionId))?.header;
  }
  private async eligible(id: string, bot: BotRecord): Promise<boolean> {
    const meta = await this.header(id);
    if (
      !meta ||
      meta.createdAt < bot.createdAt ||
      meta.parentSession ||
      meta.origin === 'subagent' ||
      meta.isSeeded ||
      (meta.delegationDepth ?? 0) > 0
    )
      return false;
    const live = this.ctx.agents.get(id as SessionId);
    if (live) {
      const binding = getBotBinding(live);
      return binding?.botId === bot.id && binding.botCreatedAt === bot.createdAt;
    }
    return meta.agentPreset === `${this.bots.config.presetIdPrefix}${bot.id}`;
  }
  private async pin(bot: BotRecord, sessionId: string) {
    if (this.pinned.get(sessionId)?.name === bot.name) return;
    this.naming.add(sessionId);
    let result: Awaited<ReturnType<Context['sessionController']['rename']>>;
    try {
      result = await this.ctx.sessionController.rename({ sessionId: sessionId as SessionId, title: bot.name });
    } catch (error) {
      this.pinned.delete(sessionId);
      throw error;
    } finally {
      this.naming.delete(sessionId);
    }
    // Native normalization folds whitespace; use its accepted value for the event guard.
    this.pinned.set(sessionId, { botId: bot.id, name: bot.name, title: result.title });
    const session = this.ctx.sessions.get(sessionId as SessionId);
    if (!session || !(await this.ctx.sessions.flush(session))) {
      this.pinned.delete(sessionId);
      throw new DshBotError('bot/unavailable', 'Main title flush failed');
    }
  }
  private async resolve(botId: string, create: boolean): Promise<MainSession | undefined> {
    const bot = await this.bots.get(botId);
    const key = keyOf(bot);
    const table = this.domain.table('bindings');
    const saved = table.get(key);
    let binding = saved;
    if (binding && !(await this.eligible(binding.sessionId, bot))) {
      // Tombstone an invalid mapping without deleting any session.
      this.pinned.delete(binding.sessionId);
      binding = undefined;
    }
    if (!binding) {
      // Migration runs only for an unmapped incarnation. A deleted main must not resurrect hidden legacy history.
      const { items } = saved ? { items: [] } : await this.ctx.sessionController.list({}, new AbortController().signal);
      const candidates = [...items]
        .filter((row) => !row.parentSessionId && row.origin !== 'subagent')
        .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
      for (const candidate of candidates) {
        const projected = candidate.projections?.values.agentPreset;
        if (projected !== undefined && projected !== `${this.bots.config.presetIdPrefix}${bot.id}`) continue;
        if (
          [...table.entries()].some(
            ([, row]) =>
              row.botId === bot.id && row.botCreatedAt !== bot.createdAt && row.sessionId === candidate.sessionId,
          )
        )
          continue;
        if (!(await this.eligible(candidate.sessionId, bot))) continue;
        binding = { botId, botCreatedAt: bot.createdAt, sessionId: candidate.sessionId };
        break;
      }
      if (!binding && create) {
        const presetId = `${this.bots.config.presetIdPrefix}${bot.id}`;
        const preset = (await this.ctx.agentPresets.list()).find((row) => row.id === presetId);
        if (!preset || preset.broken) throw new DshBotError('bot/unavailable', 'Bot preset is unavailable');
        const workspace = await this.bots.ensureBotsWorkspace();
        const created = await this.ctx.sessionController.create({
          workspaceId: workspace.workspaceId as WorkspaceId,
          agentPreset: presetId,
        });
        binding = { botId, botCreatedAt: bot.createdAt, sessionId: created.sessionId };
        const session = this.ctx.sessions.get(created.sessionId);
        if (!session || !(await this.ctx.sessions.flush(session)))
          throw new DshBotError('bot/unavailable', 'Main header flush failed');
      }
      if (binding) await table.put(key, binding);
    }
    if (!binding) return undefined;
    // Recheck after async creation/migration. A same-id replacement never inherits it.
    const current = await this.bots.get(botId);
    if (current.createdAt !== bot.createdAt) throw new DshBotError('bot/conflict', 'Bot identity changed');
    await this.pin(current, binding.sessionId);
    return { sessionId: binding.sessionId };
  }
  find(botId: string) {
    return this.serialize(() => this.resolve(botId, false));
  }
  async open(botId: string): Promise<MainSession> {
    return this.serialize(async () => {
      const result = await this.resolve(botId, true);
      if (!result) throw new DshBotError('bot/unavailable', 'Main session unavailable');
      return result;
    });
  }
  /** Explicit user recovery: create a new native conversation without copying or erasing lineage. */
  fresh(botId: string, expectedBotCreatedAt: number, expectedSessionId: string | null): Promise<MainSession> {
    return this.serialize(async () => {
      const bot = await this.bots.get(botId);
      if (bot.createdAt !== expectedBotCreatedAt) throw new DshBotError('bot/conflict', 'Bot identity changed');
      const key = keyOf(bot), table = this.domain.table('bindings');
      const matches = () => (table.get(key)?.sessionId ?? null) === expectedSessionId;
      if (!matches()) throw new DshBotError('bot/conflict', 'Main conversation changed');
      const presetId = `${this.bots.config.presetIdPrefix}${bot.id}`;
      const preset = (await this.ctx.agentPresets.list()).find(row => row.id === presetId);
      if (!preset || preset.broken) throw new DshBotError('bot/unavailable', 'Bot preset is unavailable');
      const workspace = await this.bots.ensureBotsWorkspace();
      const newId = SessionId(randomUUID());
      const created = await this.ctx.sessionController.create({ sessionId: newId, workspaceId: workspace.workspaceId as WorkspaceId, agentPreset: presetId });
      if (created.sessionId !== newId) throw new DshBotError('bot/conflict', 'Native conversation identity changed');
      const session = this.ctx.sessions.get(created.sessionId);
      if (!session || !(await this.ctx.sessions.flush(session))) throw new DshBotError('bot/unavailable', 'Fresh main header flush failed');
      const current = await this.bots.get(botId);
      if (current.createdAt !== expectedBotCreatedAt) throw new DshBotError('bot/conflict', 'Bot identity changed');
      try {
        const latest = await this.bots.get(botId);
        if (latest.createdAt !== expectedBotCreatedAt || !matches()) throw new DshBotError('bot/conflict', 'Main conversation changed');
        // This serialized service is the sole binding writer. Recheck after every native await.
        await table.put(key, { botId, botCreatedAt: expectedBotCreatedAt, sessionId: created.sessionId });
      } catch (error) { this.pinned.delete(created.sessionId); throw error; }
      if (expectedSessionId) this.pinned.delete(expectedSessionId);
      this.bots.invalidate();
      return { sessionId: created.sessionId };
    });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      this.off?.();
      await this.tail;
      this.pinned.clear();
      this.naming.clear();
      this.repairs.clear();
      await this.domain?.close();
    })();
    return this.closing;
  }
}
