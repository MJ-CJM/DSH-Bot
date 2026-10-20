import type { Context } from '@deepseek-ai/cordis';
import type { DshBotRegistry } from '../registry.js';
import type { Config } from './config.js';
import { RunExecutor } from './executor.js';
import { dshExecutorRuntime } from './runtime.js';
import type { HostLease } from './lock.js';
import { openAutomationStores } from './store.js';
import { RoutineRemote, RunRemote } from './remote.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotExecutor: RunExecutor;
    dshBotAutomationStores: Awaited<ReturnType<typeof openAutomationStores>>;
  }
}

/** Called only after P1 startup under the lease; no timer/automatic queue draining until T14. */
export async function startAutomation(ctx: Context, bots: DshBotRegistry, lease: HostLease, config: Partial<Config>) {
  const runtime = dshExecutorRuntime(ctx, bots);
  let executor: RunExecutor | undefined;
  if (!lease.identity) throw new Error('Missing Host identity');
  const stores = await openAutomationStores(ctx, { ownerId: lease.identity.token,
    assertOwner: () => lease.assertOwner(), resolveBot: runtime.resolveBot, config,
    beforeClose: () => executor?.close() ?? Promise.resolve() });
  try {
    ctx.effect(() => ctx.jobs.attachController('dsh-bot executor'), 'dsh-bot: jobs controller');
    executor = new RunExecutor(ctx, stores.runs, runtime, () => lease.assertOwner(), config);
    ctx.provide('dshBotExecutor', executor);
    ctx.provide('dshBotAutomationStores', stores);
    new RoutineRemote(ctx, stores.routines);
    new RunRemote(ctx, stores.runs);
    return { executor, stores };
  } catch (error) { await executor?.close(); await stores.close(); throw error; }
}
