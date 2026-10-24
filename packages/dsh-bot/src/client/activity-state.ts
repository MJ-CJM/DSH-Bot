import type { Context } from '@deepseek-ai/cordis';
import type { ActivitySession, BotActivity } from '../shared/activity.js';
import type { DshBotActivityRemoteMethods } from '../shared/remote-contract.js';
import { type BotCatalogOptions, type PollingCatalog, createPollingCatalog } from './state.js';

interface ActivityPayload {
  readonly sessions: readonly ActivitySession[];
  readonly bots: readonly BotActivity[];
}
export type ActivitySnapshot = ReturnType<ActivityCatalog['getSnapshot']>;
export interface ActivityCatalog extends PollingCatalog<ActivityPayload> {
  /** Missing summaries (old, blank or evicted sessions) have nothing to read. */
  markRead(sessionId: string): Promise<void>;
}

export function createActivityCatalog(ctx: Context, options: BotCatalogOptions = {}): ActivityCatalog {
  let active = true;
  const pendingReads = new Map<string, Promise<void>>();
  const remote = (): DshBotActivityRemoteMethods => {
    // Child namespaces are independent Cordis services. Getting the parent
    // does not authorize its traced .activity accessor in a plugin scope.
    const service = ctx.get('remote.dshBot.activity') as DshBotActivityRemoteMethods | undefined;
    if (!service) throw { code: 'bot/unavailable', message: '' };
    return service;
  };
  const catalog = createPollingCatalog<ActivityPayload>(
    ctx,
    { sessions: [], bots: [] },
    async () => {
      // rc.2 checks the exact argument count: this is deliberately zero arguments.
      const result = await remote().list();
      if (!result.ok) throw result.error;
      return result.value;
    },
    options,
  );
  ctx.effect(
    () => () => {
      active = false;
      pendingReads.clear();
    },
    'dsh-bot: activity actions',
  );
  return {
    ...catalog,
    dispose() {
      active = false;
      pendingReads.clear();
      catalog.dispose();
    },
    markRead(sessionId) {
      if (!active) return Promise.resolve();
      const pending = pendingReads.get(sessionId);
      if (pending) return pending;
      const operation = (async () => {
        const result = await remote().markRead(sessionId);
        if (!result.ok && result.error.code !== 'activity/not-found') throw result.error;
        // Supersede a poll started before the write; never locally erase an
        // unread reply that may have completed after markRead on the Host.
        if (active) await catalog.refresh();
      })();
      pendingReads.set(sessionId, operation);
      void operation
        .finally(() => {
          if (pendingReads.get(sessionId) === operation) pendingReads.delete(sessionId);
        })
        .catch(() => {});
      return operation;
    },
  };
}
