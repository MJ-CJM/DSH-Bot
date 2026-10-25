import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { randomUUID } from 'node:crypto';
import {
  type MessageInput,
  messageSourceSchema,
} from '../../shared/messaging.js';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import { getBotBinding } from '../bot-context.js';
import { OperationError, Serial } from '../common/operations.js';
import type { MessageStore, } from './store.js';
export interface MessagingAuthorization {
  /** Called after exact origin/target resolution and before any native delivery. B04 must implement concrete native approval. */
  approve(agent: Agent, input: Exclude<MessageInput, { action: 'list' }>, target: BotKey, invocation?: string): Promise<string>;
  targets?(id: string): BotKey[] | undefined;
}
export interface MessagingCapabilities {
  coldWake: boolean;
  interrupt: boolean;
  processing?: boolean;
}
const unavailableAuthorization: MessagingAuthorization = {
  async approve() {
    throw new OperationError('approval-denied');
  },
};
const ambient = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']);
export abstract class MessagingCore {
  protected admission = new Serial();
  protected targets = new Map<string, Promise<void>>();
  protected tasks = new Set<Promise<unknown>>();
  protected timers = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number }>();
  protected wakes = new Map<string, { sessionId: string; generation: string }>();
  protected generation = randomUUID();
  protected releases: Array<() => void> = [];
  protected stopped = false;
  protected closing?: Promise<void>;
  constructor(
    protected ctx: Context,
    protected registry: DshBotRegistry,
    readonly store: MessageStore,
    protected authorization: MessagingAuthorization = unavailableAuthorization,
    readonly capabilities: MessagingCapabilities = {
      coldWake: false,
      interrupt: false,
    },
    protected now = Date.now,
  ) {}

  protected abstract kick(id: string, recovery?: boolean): void;

  protected track<T>(p: Promise<T>) {
    this.tasks.add(p);
    void p.finally(() => this.tasks.delete(p)).catch(() => {});
    return p;
  }
  protected async bot(key: BotKey) {
    const bot = await this.registry.get(key.botId);
    if (bot.createdAt !== key.botCreatedAt) throw new OperationError('conflict');
    return bot;
  }
  async exact(agent: Agent) {
    const binding = getBotBinding(agent),
      h = agent.session.header;
    if (
      !binding ||
      h.parentSession ||
      h.origin === 'subagent' ||
      (h.delegationDepth ?? 0) > 0 ||
      this.ctx.agents.get(agent.session.id) !== agent
    )
      throw new OperationError('invalid');
    await this.bot(binding);
    const main = await this.registry.mainSessions?.find(binding.botId);
    if (main?.sessionId !== agent.session.id) throw new OperationError('conflict');
    return binding;
  }
  provenance(agent: Agent) {
    const events = agent.session.snapshotEvents();
    const turn = events.findLast((e) => e.type === 'turn/start');
    const current = events.filter(
      (e) => e.type === 'user/message' && !ambient.has(e.data.source.kind) && (!turn || e.seq > turn.seq),
    );
    const incoming = current.filter(
      (e) => e.type === 'user/message' && e.data.source.kind === 'dsh-bot-message',
    );
    if (incoming.length > 1) throw new OperationError('conflict');
    if (incoming.length) {
      const event = incoming[0];
      if (event?.type !== 'user/message') throw new OperationError('invalid');
      const source = messageSourceSchema.parse(event.data.source),
        record = this.store.get(source.messageId);
      if (
        !record ||
        record.nativeInput?.id !== event.data.id ||
        record.envelope.toSessionId !== agent.session.id
      )
        throw new OperationError('invalid');
      return { parent: record };
    }
    const meaningful = current.filter(
      (e) => e.type === 'user/message' && e.data.source.kind !== 'dsh-bot-message-sent',
    );
    if (
      !meaningful.length ||
      meaningful.some((e) => e.type === 'user/message' && e.data.source.kind !== 'user')
    )
      throw new OperationError('approval-denied');
    const user = meaningful.findLast((e) => e.type === 'user/message');
    if (user?.type !== 'user/message') throw new OperationError('invalid');
    return { userMessageId: user.data.id };
  }
  protected async resolve(sessionId: string) {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId);
    if ('error' in result) throw result.error;
    return result.agent;
  }
  protected async logs(agent: Agent) {
    if (!(await this.ctx.sessions.flush(agent.session))) throw new OperationError('recovery-needed');
    const handle = await this.ctx.sessionPersistence.open(agent.session.id, 'read');
    try {
      return (await handle.read()).events;
    } finally {
      await handle.close();
    }
  }

}
