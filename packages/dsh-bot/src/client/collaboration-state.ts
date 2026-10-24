import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { CollaborationMethods } from '../shared/collaboration-contract.js';
import { teamBoardSchema, imStatusSchema, IM_PIN, type TeamBoard, type ImStatus } from '../shared/collaboration.js';
import type { BotKey } from '../shared/integrations.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
export const EMPTY_BOARD: TeamBoard = { supported: false, reason: 'native-service-missing', members: [], tasks: [] };
const unwrap = <T>(r: RemoteResult<T>) => {
  if (!r.ok) throw r.error;
  return r.value;
};
export interface CollaborationActions {
  remote(): CollaborationMethods;
  createBoard(bot: BotKey): PollingCatalog<TeamBoard>;
  im: PollingCatalog<ImStatus>;
}
export function createCollaborationActions(ctx: Context, options: BotCatalogOptions): CollaborationActions {
  const remote = () => {
    const r = ctx.get('remote.dshBot.collaboration');
    if (!r) throw new Error('Collaboration unavailable');
    return r;
  };
  const im = createPollingCatalog(
    ctx,
    imStatusSchema.parse({
      pin: IM_PIN,
      installed: false,
      contractDetected: false,
      inboundSupported: false,
      outboundSupported: false,
      reason: 'plugin-missing',
    }),
    async () => {
      const r = ctx.get('remote.dshBot.im');
      if (!r) throw new Error('IM unavailable');
      return imStatusSchema.parse(unwrap(await r.status()));
    },
    options,
  );
  return {
    remote,
    im,
    createBoard: (bot) =>
      createPollingCatalog(
        ctx,
        EMPTY_BOARD,
        async () => teamBoardSchema.parse(unwrap(await remote().board(bot))),
        options,
      ),
  };
}
