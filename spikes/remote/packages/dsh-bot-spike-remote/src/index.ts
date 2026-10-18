import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

import type { ListResult } from './contract.js';
export type { BotRow } from './contract.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBots: DshBots;
  }
}

export class DshBots extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'dshBots', { namespace: 'dshBot' });
  }

  @Remote
  async list(): Promise<ListResult> {
    return [{ id: 'host-spike', name: 'Host service marker' }];
  }
}
