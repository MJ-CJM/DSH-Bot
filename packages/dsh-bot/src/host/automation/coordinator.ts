import type { Context } from '@deepseek-ai/cordis';
import type { DshBotRegistry } from '../registry.js';
import type { Config } from './config.js';
import { RunExecutor } from './executor.js';
import { dshExecutorRuntime } from './runtime.js';
import type { HostLease } from './lock.js';
import { openAutomationStores } from './store.js';
import { RoutineRemote, RunRemote } from './remote.js';
import { Dispatcher } from './dispatcher.js';
import { DelegateReporter } from '../delegate/reporter.js';
import { dshReportRuntime } from '../delegate/runtime.js';
import { registerAutomationGuard } from '../delegate/guard.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotExecutor: RunExecutor;
    dshBotAutomationStores: Awaited<ReturnType<typeof openAutomationStores>>;
    dshBotDispatcher: Dispatcher;
    dshBotReporter: DelegateReporter;
  }
}

/** Called only after P1 startup under the lease and store recovery. */
export async function startAutomation(ctx: Context, bots: DshBotRegistry, lease: HostLease, config: Partial<Config>) {
  const runtime = dshExecutorRuntime(ctx, bots);
  let executor: RunExecutor | undefined;
  let dispatcher: Dispatcher | undefined;
  let reporter: DelegateReporter | undefined;
  const close = async () => { await dispatcher?.close(); await reporter?.close(); await executor?.close(); };
  if (!lease.identity) throw new Error('Missing Host identity');
  const stores = await openAutomationStores(ctx, { ownerId: lease.identity.token,
    assertOwner: () => lease.assertOwner(), resolveBot: runtime.resolveBot, config,
    beforeClose: close });
  try {
    ctx.effect(() => ctx.jobs.attachController('dsh-bot executor'), 'dsh-bot: jobs controller');
    executor = new RunExecutor(ctx, stores.runs, runtime, () => lease.assertOwner(), config);
    dispatcher = new Dispatcher(ctx, stores, executor, () => lease.assertOwner(), config);
    ctx.provide('dshBotExecutor', executor);
    ctx.provide('dshBotAutomationStores', stores);
    ctx.provide('dshBotDispatcher', dispatcher);
    registerAutomationGuard(ctx, stores.runs);
    reporter = new DelegateReporter(ctx, stores, dshReportRuntime(ctx, bots), () => lease.assertOwner(), config);
    ctx.provide('dshBotReporter', reporter);
    new RoutineRemote(ctx, stores.routines, dispatcher);
    new RunRemote(ctx, stores.runs);
    return { executor, stores, dispatcher, reporter, close };
  } catch (error) { await close(); await stores.close(); throw error; }
}
