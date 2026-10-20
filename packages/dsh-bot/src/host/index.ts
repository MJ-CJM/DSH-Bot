import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { TYPERT } from '../typert.host.js';
import { Config, DshBotRegistry } from './registry.js';
import { registerStandardBotManage } from './tools/bot-manage.js';
import { DshBotMemoryRemote } from './memory/remote.js';
import { DshBotActivityRemote } from './activity/remote.js';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { join } from 'node:path';
import { acquireHostLease, type HostLease } from './automation/lock.js';
import { AUTOMATION_HOST, AutomationStatusRemote } from './automation/remote.js';
import type { AutomationStatus } from '../shared/automation-contract.js';
import { startAutomation } from './automation/coordinator.js';

export { Config, DshBotRegistry };

export const name = 'dsh-bot';
export const inject = ['storageDomain', 'agentPresets', 'typert', 'loader', 'tools', 'agents',
  'sessionController', 'sessions', 'workspaceRegistry', 'jobs', 'subagents'];

export function apply(ctx: Context, config: Config): void {
  // Cordis disposes sibling effects concurrently. Explicitly join all business
  // resources before releasing ownership; stores also drain their producer.
  let lease: HostLease | undefined;
  let automation: Awaited<ReturnType<typeof startAutomation>> | undefined;
  let status: AutomationStatus = { state: 'starting' };
  let shutdown = async () => {};
  const currentLease = () => {
    if (!lease) throw new Error('Host ownership is not initialized');
    return lease;
  };
  const ownership = ctx.effect(async () => {
    lease = await acquireHostLease(join(resolveDshHome(), 'dsh-bot/automation/lock'));
    const identity = lease.identity;
    const owner = identity ? { pid: identity.pid, hostname: identity.hostname, startedAt: identity.startedAt } : undefined;
    status = { state: lease.writable ? 'starting' : 'read_only', ...(owner ? { owner } : {}),
      ...(lease.reason ? { reason: lease.reason } : {}) };
    return async () => {
      await shutdown();
      if (lease?.writable && (automation?.executor.safeToRelease ?? true)) await lease.release();
    };
  }, 'dsh-bot: Host ownership');
  ctx.effect(() => ctx.typert.register(AUTOMATION_HOST), 'dsh-bot: automation contract');
  new AutomationStatusRemote(ctx, () => {
    if (status.state === 'ready' && !lease?.writable) status = { ...status, state: 'read_only', reason: 'ownership-lost' };
    if (lease?.writable) {
      try { lease.assertOwner(); }
      catch { status = { ...status, state: 'read_only', reason: 'ownership-lost' }; }
    }
    return structuredClone(status);
  });
  ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-bot: Host Remote contract');
  const registry = new DshBotRegistry(ctx, config, async () => {
    await ctx.loader.await(); await ownership; currentLease().assertOwner();
  }, () => currentLease().assertOwner());
  new DshBotMemoryRemote(ctx);
  new DshBotActivityRemote(ctx);
  if (registry.config.enableBotManageInStandard) registerStandardBotManage(ctx);
  // The guard service answers bot/unavailable while the Host Loader settles.
  // Its own lifecycle drains initialization and operations on unload.
  let started = false; let stopping = false;
  const ready = registry.waitUntilReady().then(async () => {
    if (stopping) return;
    started = true;
    await ctx.effect(async () => {
      automation = await startAutomation(ctx, registry, currentLease(), registry.config.automation ?? {});
      const runtime = automation;
      status = { ...status, state: 'ready' };
      ctx.logger.info('[dsh-bot] loaded');
      return () => runtime.executor.close();
    }, 'dsh-bot: automation runtime');
  }).catch(error => {
    if (status.state !== 'read_only') {
      status = { ...status, state: 'failed', reason: 'startup-failed' };
      ctx.logger.error('[dsh-bot] automation startup failed', error);
    }
  });
  let closing: Promise<void> | undefined;
  shutdown = () => closing ??= (async () => {
    stopping = true; status = { ...status, state: 'stopping' };
    if (started) await ready;
    await automation?.executor.close();
    await automation?.stores.close();
    await registry.close();
  })();
  ctx.effect(() => shutdown, 'dsh-bot: automation startup guard');
  ctx.effect(() => () => ctx.logger.info('[dsh-bot] unloaded'), 'dsh-bot: lifecycle log');
}
