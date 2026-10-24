import type { Context } from '@deepseek-ai/cordis';
import type { DshBotRegistry } from '../registry.js';
import type { RunRequest } from '../../shared/automation.js';
import { MainSessionDelivery } from './delivery.js';
import { openAutomationStores } from './store.js';
import { NativeScheduleRemote, RunRemote } from './remote.js';
import { NativeSchedules } from '../native-schedule/service.js';
import { registerAutomationGuard } from '../delegate/guard.js';
import { AutomationError } from './errors.js';
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotDelivery: MainSessionDelivery;
    dshBotAutomationStores: Awaited<ReturnType<typeof openAutomationStores>>;
    dshBotSubmitter: {
      submit(request: RunRequest): ReturnType<Awaited<ReturnType<typeof openAutomationStores>>['runs']['enqueue']>;
    };
  }
}
/** Explicit requests only: no clock, queue driver, quota, catch-up or Host lease. */
export async function startAutomation(ctx: Context, bots: DshBotRegistry) {
  const resolveBot = async (id: string) => {
    const bot = await bots.get(id);
    return { bot, presetId: `${bots.config.presetIdPrefix}${bot.id}` };
  };
  let delivery: MainSessionDelivery | undefined;
  let stopped = false;
  const admissions = new Set<Promise<unknown>>();
  const native = new NativeSchedules(ctx, bots);
  const close = async () => {
    stopped = true;
    await Promise.allSettled([...admissions]);
    await delivery?.close();
    await native.close();
  };
  const stores = await openAutomationStores(ctx, { resolveBot, beforeClose: close });
  try {
    delivery = new MainSessionDelivery(ctx, bots, stores.runs);
    const sender = delivery;
    const submit = (request: RunRequest) => {
      if (stopped) return Promise.reject(new AutomationError('automation/unavailable', 'Executions are closing'));
      const pending = sender.submit(request);
      admissions.add(pending);
      void pending.finally(() => admissions.delete(pending)).catch(() => {});
      return pending;
    };
    ctx.provide('dshBotDelivery', delivery);
    ctx.provide('dshBotAutomationStores', stores);
    ctx.provide('dshBotSubmitter', { submit });
    registerAutomationGuard(ctx, stores.runs);
    await native.start();
    new NativeScheduleRemote(ctx, native, submit);
    new RunRemote(ctx, stores.runs);
    return { delivery, stores, native, close };
  } catch (error) {
    await close();
    await stores.close();
    throw error;
  }
}
