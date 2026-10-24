import type { Context } from '@deepseek-ai/cordis';

import { botDomain, writer, failure } from './stores/domain.js';
import { BotStore } from './stores/bots.js';
import { ActivityStore, type ActivityStoreOptions } from './stores/activity.js';
import { MemoryStore } from './stores/memory.js';
export { botDomain } from './stores/domain.js';
export { BotStore } from './stores/bots.js';
export { ActivityStore, type ActivityStoreOptions, type ActivityRecordInput } from './stores/activity.js';
export {
  MemoryStore,
  lexicalMemorySearch,
  tokenizeMemoryQuery,
  type MemorySearch,
  type MemorySearchRecord,
} from './stores/memory.js';

/** Call once in the owning Host context (inject storageDomain); share the stores. */
export async function openBotStores(
  ctx: Context,
  options: ActivityStoreOptions & { beforeClose?: () => Promise<void>; assertOwner?: () => void } = {},
): Promise<{
  bots: BotStore;
  memories: MemoryStore;
  activities: ActivityStore;
  close: () => Promise<void>;
}> {
  let stores!: { bots: BotStore; memories: MemoryStore; activities: ActivityStore };
  let closing: Promise<void> | undefined;
  try {
    const release = ctx.effect(async () => {
      options.assertOwner?.();
      const domain = await ctx.storageDomain.open(botDomain);
      writer(domain).assertOwner = options.assertOwner;
      try {
        const activities = new ActivityStore(domain, options);
        await activities.prune();
        stores = { bots: new BotStore(domain), memories: new MemoryStore(domain), activities };
      } catch (error) {
        await domain.close();
        throw error;
      }
      const closeDomain = async () => {
        // Cordis may dispose sibling effects concurrently. The registry owns a
        // wider queue than these stores, and must drain it before we reject writes.
        if (options.beforeClose) await options.beforeClose();
        const state = writer(domain);
        state.closing = true;
        await state.tail;
        try {
          await domain.close();
        } catch (error) {
          throw failure(error);
        }
      };
      return () => (closing ??= closeDomain());
    });
    await release;
    // Cordis skips repeat disposer calls; still await the original teardown.
    return {
      ...stores,
      close: async () => {
        await release();
        await closing;
      },
    };
  } catch (error) {
    throw failure(error);
  }
}
