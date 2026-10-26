import type { Context } from '@deepseek-ai/cordis';

import { botDomain, writer, failure } from './stores/domain.js';
import { BotStore } from './stores/bots.js';
import { ActivityStore, type ActivityStoreOptions } from './stores/activity.js';
import { MemoryStore } from './stores/memory.js';
import { migrationBotDomain, type MigrationBotDomain, type BotDomain } from './stores/domain.js';
import { openMemoryKernel } from './memory/open-v2.js';
import { migratePrivate } from './memory/migration.js';
import { V2MemoryStore } from './memory/store-v2.js';
import type { MemoryPort } from './memory/port.js';
import type { MemoryKernel } from './memory/op-log.js';
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
  options: ActivityStoreOptions & { beforeClose?: () => Promise<void>; assertOwner?: () => void;
    memoryV2?: { dataDir: string; timeZone?: string } } = {},
): Promise<{
  bots: BotStore;
  memories: MemoryPort;
  memoryKernel?: MemoryKernel;
  activities: ActivityStore;
  close: () => Promise<void>;
}> {
  let stores!: { bots: BotStore; memories: MemoryPort; activities: ActivityStore; memoryKernel?: MemoryKernel };
  let closing: Promise<void> | undefined;
  try {
    const release = ctx.effect(async () => {
      options.assertOwner?.();
      const memory = options.memoryV2 ? await openMemoryKernel(ctx, options.memoryV2.dataDir, options.memoryV2.timeZone) : undefined;
      const legacy = await ctx.storageDomain.open(options.memoryV2 ? migrationBotDomain : botDomain)
        .catch(async error => { await memory?.close(); throw error; });
      // The migration-only union is never exposed to legacy memory writers.
      const domain = legacy as unknown as BotDomain;
      writer(domain).assertOwner = options.assertOwner;
      try {
        if (memory) await migratePrivate(legacy as unknown as MigrationBotDomain, memory.kernel);
        const activities = new ActivityStore(domain, options);
        await activities.prune();
        const bots = new BotStore(domain);
        stores = { bots, memories: memory ? new V2MemoryStore(memory.kernel, bots) : new MemoryStore(domain),
          activities, ...(memory ? { memoryKernel: memory.kernel } : {}) };
      } catch (error) {
        await domain.close();
        await memory?.close();
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
          await memory?.close();
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
