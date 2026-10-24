import { Groups, groupsDomain } from './groups/service.js';
import { GroupsRemote, GROUPS_HOST } from './groups/remote.js';
import { Collaboration, collaborationDomain } from './collaboration/service.js';
import { CollaborationRemote, ImRemote, COLLABORATION_HOST } from './collaboration/remote.js';
import { openP34Stores } from './p34/store.js';
import { Connectors } from './connectors/service.js';
import { Notifications } from './notifications/service.js';
import { P34Remote, NotificationRemote, P34_HOST } from './p34/remote.js';
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
import { MainSessions } from './main-session.js';
import { startAutomation } from './automation/coordinator.js';
export { Config, DshBotRegistry };
export const name = 'dsh-bot';
export const inject = ['storageDomain', 'agentPresets', 'typert', 'loader', 'tools', 'agents',
  'sessionController', 'sessions', 'workspaceRegistry', 'subagents'];
export function apply(ctx: Context, config: Config): void {
  let automation: Awaited<ReturnType<typeof startAutomation>> | undefined;
  let status: AutomationStatus = { state: 'starting' };
  ctx.effect(() => ctx.typert.register(AUTOMATION_HOST), 'dsh-bot: native schedule contract');
  new AutomationStatusRemote(ctx, () => structuredClone(status));
  ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-bot: Host Remote contract');
  const registry = new DshBotRegistry(ctx, config, () => ctx.loader.await());
  new DshBotMemoryRemote(ctx); new DshBotActivityRemote(ctx);
  if (registry.config.enableBotManageInStandard) registerStandardBotManage(ctx);
  let p34: { close(): Promise<void> } | undefined;
  let collaboration: Collaboration | undefined;
  let groups: Groups | undefined;
  let stopping = false;
  const ready = registry.waitUntilReady().then(async () => {
    if (stopping) return;
    const sidecars = await openP34Stores(ctx);
    const connectors = new Connectors(ctx, sidecars, registry, registry.config.connectorApplyTimeoutMs, () => registry.invalidate());
    const notifications = new Notifications(ctx, sidecars, registry, {
      sendTimeoutMs: registry.config.notificationSendTimeoutMs,
      dailyLimit: registry.config.notificationDailyLimit, cooldownSec: registry.config.notificationCooldownSec,
      retentionDays: registry.config.notificationRetentionDays, maxRecords: registry.config.notificationMaxRecords,
    }, () => registry.invalidate());
    const releases: Array<() => void> = [];
    let closingP34: Promise<void> | undefined;
    p34 = { close() { closingP34 ??= (async () => {
      const results = await Promise.allSettled([notifications.close(), connectors.close()]);
      for (const release of releases.splice(0)) release();
      await sidecars.close();
      const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'P34 shutdown failed');
    })(); return closingP34; } };
    await notifications.recover();
    releases.push(ctx.provide('dshBotConnectors', connectors), ctx.provide('dshBotNotifications', notifications));
    releases.push(ctx.on('credentials/reference-updated', ref => connectors.credentialChanged(ref)));
    releases.push(ctx.on('dsh-bot/changed', change => connectors.botChanged(change.id)));
    new P34Remote(ctx, connectors, notifications); new NotificationRemote(ctx, notifications);
    await ctx.effect(() => ctx.typert.register(P34_HOST), 'dsh-bot: P34 Remote');
    const mainSessions = new MainSessions(ctx, registry);
    await mainSessions.start();
    registry.mainSessions = mainSessions;
    await ctx.effect(async () => {
      const domain = await ctx.storageDomain.open(collaborationDomain);
      collaboration = new Collaboration(ctx, registry, domain, () => registry.invalidate());
      return () => collaboration?.close();
    }, 'dsh-bot: collaboration');
    if (!collaboration) throw new Error('Collaboration startup failed');
    new CollaborationRemote(ctx, collaboration); new ImRemote(ctx);
    await ctx.effect(() => ctx.typert.register(COLLABORATION_HOST), 'dsh-bot: collaboration Remote');
    await ctx.effect(async () => {
      const domain = await ctx.storageDomain.open(groupsDomain);
      groups = new Groups(ctx, registry, domain, () => registry.invalidate());
      return () => groups?.close();
    }, 'dsh-bot: groups');
    if (!groups) throw new Error('Groups startup failed');
    await groups.start();
    ctx.effect(() => ctx.provide('dshBotGroups', groups as Groups), 'dsh-bot: groups service');
    new GroupsRemote(ctx, groups);
    await ctx.effect(() => ctx.typert.register(GROUPS_HOST), 'dsh-bot: groups Remote');
    automation = await startAutomation(ctx, registry);
    status = { state: 'ready' }; ctx.logger.info('[dsh-bot] loaded');
  }).catch(error => { status = { state: 'failed', reason: 'startup-failed' }; ctx.logger.error('[dsh-bot] startup failed', error); });
  ctx.effect(() => async () => {
    stopping = true; status = { state: 'stopping' }; await ready;
    const errors: unknown[] = [];
    for (const close of [() => groups?.close(), () => collaboration?.close(), () => p34?.close(), () => automation?.close(), () => automation?.stores.close(), () => registry.mainSessions?.close(), () => registry.close()]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Bot runtime shutdown failed');
    ctx.logger.info('[dsh-bot] unloaded');
  }, 'dsh-bot: runtime');
}
