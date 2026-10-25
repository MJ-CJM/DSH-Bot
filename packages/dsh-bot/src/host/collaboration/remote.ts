import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { COLLABORATION_REMOTE } from '../../shared/collaboration-contract.js';
import type { BotKey } from '../../shared/integrations.js';
import { imStatus } from '../im/service.js';
import type { Collaboration } from './service.js';
export const COLLABORATION_HOST = {
  package: 'dsh-bot/collaboration',
  face: 'host',
  schemas: [],
  get invocations() {
    return COLLABORATION_REMOTE.descriptors;
  },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
export class CollaborationRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private collaboration: Collaboration,
  ) {
    super(ctx, 'dshBotCollaborationRemote', { namespace: 'dshBot.collaboration' });
  }
  @Remote async board(bot: BotKey) {
    return this.collaboration.board(bot);
  }
  @Remote async ensure(bot: BotKey, expectedRevision: number) {
    return this.collaboration.ensure(bot, expectedRevision);
  }
  @Remote async createTask(bot: BotKey, input: unknown) {
    return this.collaboration.createTask(bot, input);
  }
  @Remote async updateTask(bot: BotKey, input: unknown) {
    return this.collaboration.updateTask(bot, input);
  }
}
export class ImRemote extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'dshBotImRemote', { namespace: 'dshBot.im' });
  }
  @Remote async status() {
    return imStatus(this.ctx);
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotCollaborationRemote: CollaborationRemote;
    dshBotImRemote: ImRemote;
  }
}
