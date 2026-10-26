import type { Context } from '@deepseek-ai/cordis';
import type { DshBotRemoteMethods } from '../shared/remote-contract.js';
import type { MemoryCursor, MemoryRecord } from '../shared/schema.js';
import { createPollingCatalog, type BotCatalogOptions, type PollingCatalog, type PollingSnapshot } from './state.js';

interface MemoryPage {
  records: readonly MemoryRecord[];
  query: string;
  before?: MemoryCursor;
  hasNext: boolean;
  total: number | undefined;
  quarantined?: number;
}
export type MemoryCatalogSnapshot = MemoryPage & PollingSnapshot;
export interface MemoryCatalog extends Omit<PollingCatalog<MemoryPage>, 'reset' | 'observe'> {
  setQuery(query: string): void;
  nextPage(): void;
  firstPage(): void;
}
export interface MemoryCatalogOptions extends BotCatalogOptions {
  pageSize?: number;
}

/** Same epoch, visibility/reset, polling and owner lifetime as the Bot catalog. */
export function createMemoryCatalog(ctx: Context, botId: string, options: MemoryCatalogOptions = {}): MemoryCatalog {
  const pageSize = options.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 199) throw new RangeError('pageSize must be 1–199');
  let query = '';
  let before: MemoryCursor | undefined;
  const empty = (): MemoryPage => ({ records: [], query, before, hasNext: false, total: undefined });
  const catalog = createPollingCatalog(
    ctx,
    empty(),
    async () => {
      // Capture the requested page before the first await; old responses cannot change it.
      const requestedQuery = query;
      const requestedBefore = before;
      const memory = ctx.get('remote.dshBot.memory') as DshBotRemoteMethods['memory'] | undefined;
      if (!memory) throw { code: 'bot/unavailable', message: '' };
      const input = { limit: pageSize + 1, before: requestedBefore };
      const [rows, count, quarantined] = await Promise.all([
        requestedQuery ? memory.search(botId, { ...input, query: requestedQuery }) : memory.list(botId, input),
        memory.count(botId),
        memory.quarantineCount(),
      ]);
      if (!rows.ok) throw rows.error;
      if (!count.ok) throw count.error;
      if (!quarantined.ok) throw quarantined.error;
      return {
        records: rows.value.slice(0, pageSize),
        query: requestedQuery,
        before: requestedBefore,
        hasNext: rows.value.length > pageSize,
        total: count.value,
        quarantined: quarantined.value,
      };
    },
    options,
  );
  const move = () => {
    catalog.reset(empty());
    void catalog.refresh();
  };
  return {
    ...catalog,
    setQuery(value) {
      query = value.trim();
      before = undefined;
      move();
    },
    firstPage() {
      before = undefined;
      move();
    },
    nextPage() {
      const state = catalog.getSnapshot();
      const last = state.records.at(-1);
      if (state.loading || state.error || !state.hasNext || !last) return;
      before = { pinned: last.pinned, updatedAt: last.updatedAt, id: last.id };
      move();
    },
  };
}
