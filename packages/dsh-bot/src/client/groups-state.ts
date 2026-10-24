import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { GroupMethods } from '../shared/groups-contract.js';
import { groupViewSchema, groupSummarySchema, type GroupKey, type GroupSummary, type GroupView } from '../shared/groups.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
export const unwrapGroup = <T>(r: RemoteResult<T>): T => { if (!r.ok) throw r.error; return r.value; };
export interface GroupActions {
  remote(): GroupMethods;
  catalog: PollingCatalog<{ groups: GroupSummary[] }>;
  createView(key: GroupKey): PollingCatalog<{ view?: GroupView }>;
  selection: PollingCatalog<{ selectedId?: string }>;
  select(id: string): void;
}
export function createGroupActions(ctx: Context, options: BotCatalogOptions): GroupActions {
  const remote = (): GroupMethods => { const service = ctx.get('remote.dshBot.groups'); if (!service) throw new Error('Groups unavailable'); return service; };
  let selectedId: string | undefined;
  const selection = createPollingCatalog<{ selectedId?: string }>(ctx, {}, async () => ({ selectedId }), options);
  return { remote, selection, select(id) { selectedId = id; void selection.refresh(); },
    catalog: createPollingCatalog(ctx, { groups: [] as GroupSummary[] }, async () => ({ groups: unwrapGroup(await remote().list()).map(g => groupSummarySchema.parse(g)) }), options),
    createView: key => createPollingCatalog(ctx, {} as { view?: GroupView }, async () => ({ view: groupViewSchema.parse(unwrapGroup(await remote().view(key, {}))) }), options),
  };
}
