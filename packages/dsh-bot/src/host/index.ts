import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { TYPERT } from '../typert.host.js';
import { Config, DshBotRegistry } from './registry.js';
import { registerStandardBotManage } from './tools/bot-manage.js';
import { DshBotMemoryRemote } from './memory/remote.js';
import { DshBotActivityRemote } from './activity/remote.js';

export { Config, DshBotRegistry };

export const name = 'dsh-bot';
export const inject = ['storageDomain', 'agentPresets', 'typert', 'loader', 'tools', 'agents'];

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-bot: Host Remote contract');
  const registry = new DshBotRegistry(ctx, config, () => ctx.loader.await());
  new DshBotMemoryRemote(ctx);
  new DshBotActivityRemote(ctx);
  if (registry.config.enableBotManageInStandard) registerStandardBotManage(ctx);
  // The guard service answers bot/unavailable while the Host Loader settles.
  // Its own lifecycle drains initialization and operations on unload.
  void registry.waitUntilReady().then(() => ctx.logger.info('[dsh-bot] loaded')).catch(() => {});
  ctx.effect(() => () => ctx.logger.info('[dsh-bot] unloaded'), 'dsh-bot: lifecycle log');
}
