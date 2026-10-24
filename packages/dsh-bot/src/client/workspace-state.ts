import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { BotKey } from '../shared/integrations.js';
import { graphResultSchema, type GraphStatus } from '../shared/reference-memory.js';
import type { ReferenceMemoryMethods, WorkspaceMethods } from '../shared/workspace-contract.js';
import { createPollingCatalog, type PollingCatalog, type BotCatalogOptions } from './state.js';
const unwrap = <T>(r: RemoteResult<T>): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
export interface WorkspaceActions {
  workspace(input: Parameters<WorkspaceMethods['request']>[0]): ReturnType<WorkspaceMethods['request']>;
  graph(input: Parameters<ReferenceMemoryMethods['request']>[0]): ReturnType<ReferenceMemoryMethods['request']>;
  createGraph(bot: BotKey): PollingCatalog<{ status?: GraphStatus }>;
}
export function createWorkspaceActions(ctx: Context, options: BotCatalogOptions): WorkspaceActions {
  const workspace = (input: Parameters<WorkspaceMethods['request']>[0]) => {
    const remote = ctx.get('remote.dshBot.workspace');
    if (!remote) throw new Error('Workspace unavailable');
    return remote.request(input);
  };
  const graph = (input: Parameters<ReferenceMemoryMethods['request']>[0]) => {
    const remote = ctx.get('remote.dshBot.referenceMemory');
    if (!remote) throw new Error('Reference graph unavailable');
    return remote.request(input);
  };
  return {
    workspace,
    graph,
    createGraph: (bot) =>
      createPollingCatalog(
        ctx,
        {} as { status?: GraphStatus },
        async () => ({
          status: graphResultSchema.parse(unwrap(await graph({ action: 'status', bot }))).status,
        }),
        options,
      ),
  };
}
