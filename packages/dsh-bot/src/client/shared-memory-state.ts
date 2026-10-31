import type { Context } from '@deepseek-ai/cordis';
import type { MemoryQuery, ManagedMemoryPage } from '../shared/memory-management.js';
import type { DshBotMemoryRemoteMethods } from '../shared/remote-contract.js';
import { createPollingCatalog, type BotCatalogOptions } from './state.js';

export function createSharedMemoryCatalog(ctx: Context, botId: string, options: BotCatalogOptions = {}) {
  let input: MemoryQuery = { botId, scope: 'shared', view: 'facts' };
  const empty = () => ({ revision: 0, rows: [], total: 0 }) satisfies ManagedMemoryPage;
  const catalog = createPollingCatalog<ManagedMemoryPage & { input: MemoryQuery }>(ctx, { ...empty(), input }, async () => {
    const requested = { ...input };
    const remote = ctx.get('remote.dshBot.memory') as DshBotMemoryRemoteMethods | undefined;
    if (!remote) throw new Error('Memory unavailable');
    const result = await remote.query(requested);
    if (!result.ok) throw result.error;
    return { ...result.value, input: requested };
  }, options);
  const snapshots = new Map<string, ReturnType<typeof catalog.getSnapshot>>();
  return { ...catalog,
    select(patch: Partial<MemoryQuery>) {
      snapshots.set(JSON.stringify(input), catalog.getSnapshot());
      input = { ...input, ...patch };
      const previous = snapshots.get(JSON.stringify(input));
      catalog.reset({ ...(previous ?? empty()), input }); void catalog.refresh();
    },
    nextPage() {
      const state = catalog.getSnapshot();
      if (!state.next) return;
      this.select({ cursor: state.next, revision: state.revision });
    },
  };
}
export type SharedMemoryCatalog = ReturnType<typeof createSharedMemoryCatalog>;
