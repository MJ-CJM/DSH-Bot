import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { P34_REMOTE } from '../../shared/p34-contract.js';
import { p34CatalogSchema, type BotKey, type NotifyInput } from '../../shared/p34.js';
import type { Connectors } from '../connectors/service.js';
import type { Notifications } from '../notifications/service.js';
import { P34Error } from './common.js';
export const P34_HOST = { package: 'dsh-bot/p34', face: 'host', schemas: [],
  get invocations() { return P34_REMOTE.descriptors; }, model: { services: [], events: [], objects: [] } } satisfies TypertContribution;
export class P34Remote extends TypertRemoteService {
  constructor(ctx: Context, private connectors: Connectors, private notifications: Notifications) { super(ctx, 'dshBotP34', { namespace: 'dshBot.connectors' }); }
  @Remote async catalog() {
    const notifications = this.notifications.list();
    return p34CatalogSchema.parse({ definitions: this.connectors.definitions(), assignments: this.connectors.assignments(), runtime: this.connectors.runtime(),
      policies: this.notifications.policies(), notifications, unread: notifications.filter(r => r.readAt === undefined).length,
      imSupported: this.notifications.supported(), desktopSupported: false, defaults: { dailyLimit: this.notifications.options.dailyLimit, cooldownSec: this.notifications.options.cooldownSec } });
  }
  @Remote async saveDefinition(input: unknown, expected: number) { return this.connectors.saveDefinition(input, expected); }
  @Remote async saveAssignment(input: unknown, expected: number) { return this.connectors.saveAssignment(input, expected); }
  @Remote async applyIdle(bot: BotKey) { return this.connectors.applyIdle(bot); }
  @Remote async importLegacy(bot: BotKey) { return this.connectors.importLegacy(bot); }
}
export class NotificationRemote extends TypertRemoteService {
  constructor(ctx: Context, private notifications: Notifications) { super(ctx, 'dshBotNotificationRemote', { namespace: 'dshBot.notifications' }); }
  @Remote async savePolicy(input: unknown, expected: number, confirmed: boolean) { return this.notifications.savePolicy(input, expected, confirmed); }
  @Remote async markRead(id: string, expected: number) { return this.notifications.markRead(id, expected); }
  @Remote async testNotification(owner: BotKey, input: NotifyInput, expectedScope: string, confirmed: true) {
    if (confirmed !== true) throw new P34Error('approval-denied');
    const policy = this.notifications.policy(input.policyId); if (policy.scopeDigest !== expectedScope) throw new P34Error('conflict');
    const r = await this.notifications.record(owner, input, { kind: 'tool', id: input.relatedId ?? input.operationId });
    return this.notifications.deliver(r.id, expectedScope);
  }
}
declare module '@deepseek-ai/cordis' { interface Context { dshBotP34: P34Remote; dshBotNotificationRemote: NotificationRemote } }
