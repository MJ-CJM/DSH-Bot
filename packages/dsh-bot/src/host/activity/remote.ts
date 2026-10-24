import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { DshBotActivityMethods, ActivityListResult, ActivitySession } from '../../shared/remote-contract.js';
import type {} from '../registry.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotActivity: DshBotActivityRemote;
  }
}

/** Shares the registry's store and drain queue; no separate domain handle. */
export class DshBotActivityRemote extends TypertRemoteService implements DshBotActivityMethods {
  static inject = ['dshBots'];

  constructor(ctx: Context) {
    super(ctx, 'dshBotActivity', { namespace: 'dshBot.activity' });
  }

  @Remote
  async list(): Promise<ActivityListResult> {
    return this.ctx.dshBots.listActivity();
  }

  @Remote
  async markRead(sessionId: string): Promise<ActivitySession> {
    return this.ctx.dshBots.markActivityRead(sessionId);
  }
}
