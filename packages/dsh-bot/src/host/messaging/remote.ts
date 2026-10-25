import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { messageRequestSchema, MESSAGING_REMOTE, type MessageRequest } from '../../shared/messaging-contract.js';
import { OperationError } from '../common/operations.js';
import type { Messaging } from './service.js';
export const MESSAGING_HOST = { package: 'dsh-bot/messaging', face: 'host' as const, schemas: [],
  get invocations() { return MESSAGING_REMOTE.descriptors; }, model: { services: [], events: [], objects: [] } };
export class MessagingRemote extends TypertRemoteService {
  static inject = ['dshBots', 'sessionController', 'sessions'];
  constructor(ctx: Context, private messaging?: Messaging) { super(ctx, 'dshBotMessagingRemote', { namespace: 'dshBot.messaging' }); }
  @Remote async request(value: MessageRequest) {
    const input = messageRequestSchema.parse(value), service = this.messaging;
    if (!service) return { enabled: false, nestedMessaging: false as const, pending: 0, items: [] };
    let botId: string;
    if (input.action === 'list') botId = input.botId;
    else {
      return service.exclusive(input.id, () => this.change(input));
    }
    return this.overview(botId);
  }
  private async change(input: Exclude<MessageRequest, { action: 'list' }>) {
      const service = this.messaging;
      if (!service) throw new OperationError('unavailable');
      const row = service.store.get(input.id);
      if (!row || row.revision !== input.revision) throw new OperationError('conflict');
      const botId = row.envelope.from.botId;
      if (input.action === 'cancel') {
        if (row.delivery === 'queued') await service.store.update(input.id, { delivery: 'canceled', processing: 'interrupted' }, input.revision);
        else {
          const result = await this.ctx.sessionController.resolveAgent(row.envelope.toSessionId as Parameters<Context['sessionController']['resolveAgent']>[0]);
          if ('error' in result || !row.nativeInput) throw new OperationError('recovery-needed');
          // Never remove a claimed message or cancel an unrelated human turn.
          if (!result.agent.inbox.remove(MessageId(row.nativeInput.id))) throw new OperationError('conflict');
          if (!(await this.ctx.sessions.flush(result.agent.session))) throw new OperationError('recovery-needed');
          await service.store.update(input.id, { delivery: 'canceled', processing: 'interrupted' }, input.revision);
        }
      } else {
        if (row.delivery !== 'failed' || row.nativeRef || !['resolve-unavailable', 'session/writer-held'].includes(row.lastErrorCode ?? ''))
          throw new OperationError('recovery-needed');
        await service.store.update(input.id, { delivery: 'queued', retryCount: 0, nextAttemptAt: Date.now() }, input.revision);
        service.retry(input.id);
      }
      return this.overview(botId);
  }
  private async overview(botId: string) {
    const service = this.messaging;
    if (!service) throw new OperationError('unavailable');
    const bot = await this.ctx.dshBots.get(botId);
    const rows = service.store.rows().filter((r) =>
      (r.envelope.from.botId === botId && r.envelope.from.botCreatedAt === bot.createdAt) ||
      (r.envelope.to.botId === botId && r.envelope.to.botCreatedAt === bot.createdAt));
    return { enabled: service.lifecycle().phase === 'running', nestedMessaging: false as const,
      pending: rows.filter((r) => r.envelope.from.botId === botId && r.response === 'waiting').length,
      items: rows.sort((a, b) => b.envelope.ts - a.envelope.ts).slice(0, 20).map((r) => ({
        envelope: { ...r.envelope, content: undefined }, revision: r.revision, delivery: r.delivery,
        processing: r.processing, response: r.response, ...(r.lastErrorCode ? { lastErrorCode: r.lastErrorCode } : {}),
      })) };
  }
}
declare module '@deepseek-ai/cordis' { interface Context { dshBotMessagingRemote: MessagingRemote } }
