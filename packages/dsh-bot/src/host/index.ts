import { Messaging, messagingDomain } from './messaging/service.js';
import { MessageStore } from './messaging/store.js';
import { Groups, groupsDomain } from './groups/service.js';
import { ReferenceMemory, referenceMemoryDomain } from './reference-memory/service.js';
import { WorkspaceManagement, workspaceDomain } from './workspace/service.js';
import { WorkspaceRemote, ReferenceMemoryRemote, WORKSPACE_HOST } from './workspace/remote.js';
import { GroupsRemote, GROUPS_HOST } from './groups/remote.js';
import { Collaboration, collaborationDomain } from './collaboration/service.js';
import { CollaborationRemote, ImRemote, COLLABORATION_HOST } from './collaboration/remote.js';
import { openIntegrationStores } from './common/integration-stores.js';
import { Connectors } from './connectors/service.js';
import { Notifications } from './notifications/service.js';
import { ConnectorRemote, NotificationRemote, INTEGRATIONS_HOST } from './connectors/remote.js';
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
export const inject = [
  'storageDomain',
  'agentPresets',
  'typert',
  'loader',
  'tools',
  'agents',
  'sessionController',
  'sessions',
  'workspaceRegistry',
  'subagents',
];
export function apply(ctx: Context, config: Config): void {
  let automation: Awaited<ReturnType<typeof startAutomation>> | undefined;
  let status: AutomationStatus = { state: 'starting' };
  ctx.effect(() => ctx.typert.register(AUTOMATION_HOST), 'dsh-bot: native schedule contract');
  new AutomationStatusRemote(ctx, () => structuredClone(status));
  ctx.effect(() => ctx.typert.register(TYPERT), 'dsh-bot: Host Remote contract');
  const registry = new DshBotRegistry(ctx, config, () => ctx.loader.await());
  new DshBotMemoryRemote(ctx);
  new DshBotActivityRemote(ctx);
  if (registry.config.enableBotManageInStandard) registerStandardBotManage(ctx);
  let integrations: { close(): Promise<void> } | undefined;
  let collaboration: Collaboration | undefined;
  let groups: Groups | undefined;
  let referenceMemory: ReferenceMemory | undefined;
  let management: WorkspaceManagement | undefined;
  let messaging: Messaging | undefined;
  let stopping = false;
  const ready = registry
    .waitUntilReady()
    .then(async () => {
      if (stopping) return;
      const sidecars = await openIntegrationStores(ctx);
      const connectors = new Connectors(ctx, sidecars, registry, registry.config.connectorApplyTimeoutMs, () =>
        registry.invalidate(),
      );
      const notifications = new Notifications(
        ctx,
        sidecars,
        registry,
        {
          sendTimeoutMs: registry.config.notificationSendTimeoutMs,
          dailyLimit: registry.config.notificationDailyLimit,
          cooldownSec: registry.config.notificationCooldownSec,
          retentionDays: registry.config.notificationRetentionDays,
          maxRecords: registry.config.notificationMaxRecords,
        },
        () => registry.invalidate(),
      );
      const releases: Array<() => void> = [];
      let closingIntegrations: Promise<void> | undefined;
      integrations = {
        close() {
          closingIntegrations ??= (async () => {
            const results = await Promise.allSettled([notifications.close(), connectors.close()]);
            for (const release of releases.splice(0)) release();
            await sidecars.close();
            const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
            if (errors.length) throw new AggregateError(errors, 'Integration shutdown failed');
          })();
          return closingIntegrations;
        },
      };
      await notifications.recover();
      releases.push(ctx.provide('dshBotConnectors', connectors), ctx.provide('dshBotNotifications', notifications));
      releases.push(ctx.on('credentials/reference-updated', (ref) => connectors.credentialChanged(ref)));
      releases.push(ctx.on('dsh-bot/changed', (change) => connectors.botChanged(change.id)));
      new ConnectorRemote(ctx, connectors, notifications);
      new NotificationRemote(ctx, notifications);
      await ctx.effect(() => ctx.typert.register(INTEGRATIONS_HOST), 'dsh-bot: integration Remote');
      const mainSessions = new MainSessions(ctx, registry);
      await mainSessions.start();
      registry.mainSessions = mainSessions;
      if (registry.config.messagingEnabled) {
        try {
          await ctx.effect(async () => {
            const domain = await ctx.storageDomain.open(messagingDomain);
            messaging = new Messaging(ctx, registry, new MessageStore(domain, registry.config));
            try {
              await messaging.start();
            } catch (error) {
              await messaging.close();
              throw error;
            }
            return () => messaging?.close();
          }, 'dsh-bot: messaging');
          if (messaging)
            ctx.effect(
              () => ctx.provide('dshBotMessaging', messaging as Messaging),
              'dsh-bot: messaging service',
            );
          ctx.logger.info(
            '[dsh-bot] messaging transport ready; automatic processing awaits scoped safety adapter',
          );
        } catch {
          messaging = undefined;
          ctx.logger.warn('[dsh-bot] messaging store unavailable; existing Bot features remain active');
        }
      }
      try {
        await ctx.effect(async () => {
          const domain = await ctx.storageDomain.open(referenceMemoryDomain);
          try {
            referenceMemory = new ReferenceMemory(ctx, registry, domain, () => registry.invalidate());
          } catch (error) {
            await domain.close();
            throw error;
          }
          return () => referenceMemory?.close();
        }, 'dsh-bot: reference memory');
      } catch {
        ctx.logger.warn('[dsh-bot] reference memory unavailable; internal memory remains active');
      }
      try {
        await ctx.effect(async () => {
          const domain = await ctx.storageDomain.open(workspaceDomain);
          management = new WorkspaceManagement(ctx, registry, connectors, domain);
          return () => management?.close();
        }, 'dsh-bot: management');
      } catch {
        ctx.logger.warn('[dsh-bot] transfer store unavailable; other management entries remain active');
      }
      if (referenceMemory) {
        ctx.effect(
          () => ctx.provide('dshBotReferenceMemory', referenceMemory as ReferenceMemory),
          'dsh-bot: graph service',
        );
        ctx.effect(
          () => ctx.on('dsh-bot/changed', (change) => referenceMemory?.botChanged(change.id)),
          'dsh-bot: graph identity',
        );
      }
      if (management)
        ctx.effect(
          () => ctx.provide('dshBotWorkspace', management as WorkspaceManagement),
          'dsh-bot: management service',
        );
      new WorkspaceRemote(ctx, management);
      new ReferenceMemoryRemote(ctx, referenceMemory);
      await ctx.effect(() => ctx.typert.register(WORKSPACE_HOST), 'dsh-bot: workspace Remote');
      await ctx.effect(async () => {
        const domain = await ctx.storageDomain.open(collaborationDomain);
        collaboration = new Collaboration(ctx, registry, domain, () => registry.invalidate());
        return () => collaboration?.close();
      }, 'dsh-bot: collaboration');
      if (!collaboration) throw new Error('Collaboration startup failed');
      new CollaborationRemote(ctx, collaboration);
      new ImRemote(ctx);
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
      status = { state: 'ready' };
      ctx.logger.info('[dsh-bot] loaded');
    })
    .catch((error) => {
      status = { state: 'failed', reason: 'startup-failed' };
      ctx.logger.error('[dsh-bot] startup failed', error);
    });
  ctx.effect(
    () => async () => {
      stopping = true;
      status = { state: 'stopping' };
      await ready;
      const errors: unknown[] = [];
      for (const close of [
        () => messaging?.close(),
        () => referenceMemory?.close(),
        () => management?.close(),
        () => groups?.close(),
        () => collaboration?.close(),
        () => integrations?.close(),
        () => automation?.close(),
        () => automation?.stores.close(),
        () => registry.mainSessions?.close(),
        () => registry.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Bot runtime shutdown failed');
      ctx.logger.info('[dsh-bot] unloaded');
    },
    'dsh-bot: runtime',
  );
}
