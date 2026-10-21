import type { Context } from '@deepseek-ai/cordis';
import type { DshBotRegistry } from '../registry.js';
import type { Config } from './config.js';
import type { RunRequest } from '../../shared/automation.js';
import { RunExecutor } from './executor.js';
import { dshExecutorRuntime } from './runtime.js';
import { openAutomationStores } from './store.js';
import { NativeScheduleRemote, RunRemote } from './remote.js';
import { NativeSchedules } from '../native-schedule/service.js';
import { DelegateReporter } from '../delegate/reporter.js';
import { dshReportRuntime } from '../delegate/runtime.js';
import { registerAutomationGuard } from '../delegate/guard.js';
import { AutomationError } from './errors.js';
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotExecutor: RunExecutor;
    dshBotAutomationStores: Awaited<ReturnType<typeof openAutomationStores>>;
    dshBotSubmitter: { submit(request: RunRequest): ReturnType<Awaited<ReturnType<typeof openAutomationStores>>['runs']['enqueue']> };
    dshBotReporter: DelegateReporter;
  }
}
/** Explicit requests only: no clock, queue driver, quota, catch-up or Host lease. */
export async function startAutomation(ctx: Context, bots: DshBotRegistry, config: Partial<Config>) {
  const runtime = dshExecutorRuntime(ctx, bots);
  let executor: RunExecutor | undefined; let reporter: DelegateReporter | undefined;
  let stopped = false; const admissions = new Set<Promise<unknown>>();
  const native = new NativeSchedules(ctx, bots);
  const close = async () => {
    stopped = true; await Promise.allSettled([...admissions]);
    await reporter?.close(); await executor?.close(); await native.close();
  };
  const stores = await openAutomationStores(ctx, { resolveBot: runtime.resolveBot, beforeClose: close });
  try {
    ctx.effect(() => ctx.jobs.attachController('dsh-bot executor'), 'dsh-bot: jobs controller');
    executor = new RunExecutor(ctx, stores.runs, runtime, () => {}, config);
    const runner = executor;
    const submit = (request: RunRequest) => {
      if (stopped) return Promise.reject(new AutomationError('automation/unavailable', 'Executions are closing'));
      const pending = stores.runs.enqueue(request).then(run => {
        if (!stopped) void runner.execute(run.id).catch(() => ctx.logger.warn('[dsh-bot] explicit execution failed'));
        return run;
      });
      admissions.add(pending); void pending.finally(() => admissions.delete(pending)).catch(() => {}); return pending;
    };
    ctx.provide('dshBotExecutor', executor); ctx.provide('dshBotAutomationStores', stores); ctx.provide('dshBotSubmitter', { submit });
    registerAutomationGuard(ctx, stores.runs);
    reporter = new DelegateReporter(ctx, stores, dshReportRuntime(ctx, bots), () => {}, config);
    ctx.provide('dshBotReporter', reporter);
    await native.start();
    new NativeScheduleRemote(ctx, native, submit); new RunRemote(ctx, stores.runs);
    return { executor, stores, native, close };
  } catch (error) { await close(); await stores.close(); throw error; }
}
