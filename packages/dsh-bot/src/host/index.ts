import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { TYPERT } from '../typert.host.js';
import { Config, DshBotRegistry } from './registry.js';
import { registerStandardBotManage } from './tools/bot-manage.js';
import { DshBotMemoryRemote } from './memory/remote.js';
import { DshBotActivityRemote } from './activity/remote.js';
import { AUTOMATION_HOST, AutomationStatusRemote } from './automation/remote.js';
import type { AutomationStatus } from '../shared/automation-contract.js';
import { startAutomation } from './automation/coordinator.js';
export { Config, DshBotRegistry };
export const name = 'dsh-bot';
export const inject = ['storageDomain', 'agentPresets', 'typert', 'loader', 'tools', 'agents',
  'sessionController', 'sessions', 'workspaceRegistry', 'jobs', 'subagents'];
export function apply(ctx: Context, config: Config): void {
  let automation: Awaited<ReturnType<typeof startAutomation>> | undefined;
  let status: AutomationStatus = { state: 'starting' };
  ctx.effect(() => ctx.typert.register(AUTOMATION_HOST), 'dsh-bot: native schedule contract');
  new AutomationStatusRemote(ctx, () => structuredClone(status));
  ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-bot: Host Remote contract');
  const registry = new DshBotRegistry(ctx, config, () => ctx.loader.await());
  new DshBotMemoryRemote(ctx); new DshBotActivityRemote(ctx);
  if (registry.config.enableBotManageInStandard) registerStandardBotManage(ctx);
  let stopping = false;
  const ready = registry.waitUntilReady().then(async () => {
    if (stopping) return;
    automation = await startAutomation(ctx, registry, registry.config.automation ?? {});
    status = { state: 'ready' }; ctx.logger.info('[dsh-bot] loaded');
  }).catch(error => { status = { state: 'failed', reason: 'startup-failed' }; ctx.logger.error('[dsh-bot] startup failed', error); });
  ctx.effect(() => async () => {
    stopping = true; status = { state: 'stopping' }; await ready;
    await automation?.close(); await automation?.stores.close(); await registry.close();
    ctx.logger.info('[dsh-bot] unloaded');
  }, 'dsh-bot: runtime');
}
