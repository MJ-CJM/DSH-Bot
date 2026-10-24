import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { INTEGRATIONS_REMOTE } from '../../shared/integrations-contract.js';
import { integrationCatalogSchema, type BotKey } from '../../shared/integrations.js';
import type { Connectors } from '../connectors/service.js';
import type { Notifications } from '../notifications/service.js';
export const INTEGRATIONS_HOST = {
  package: 'dsh-bot/p34',
  face: 'host',
  schemas: [],
  get invocations() {
    return INTEGRATIONS_REMOTE.descriptors;
  },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
export class ConnectorRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private connectors: Connectors,
    private notifications: Notifications,
  ) {
    super(ctx, 'dshBotP34', { namespace: 'dshBot.connectors' });
  }
  @Remote async catalog() {
    const notifications = this.notifications.list();
    return integrationCatalogSchema.parse({
      definitions: this.connectors.definitions(),
      assignments: this.connectors.assignments(),
      runtime: this.connectors.runtime(),
      policies: this.notifications.policies(),
      notifications,
      unread: notifications.filter((r) => r.readAt === undefined).length,
      imSupported: this.notifications.supported(),
      desktopSupported: false,
      defaults: {
        dailyLimit: this.notifications.options.dailyLimit,
        cooldownSec: this.notifications.options.cooldownSec,
      },
    });
  }
  @Remote async saveDefinition(input: unknown, expected: number) {
    return this.connectors.saveDefinition(input, expected);
  }
  @Remote async saveAssignment(input: unknown, expected: number) {
    return this.connectors.saveAssignment(input, expected);
  }
  @Remote async applyIdle(bot: BotKey) {
    return this.connectors.applyIdle(bot);
  }
  @Remote async importLegacy(bot: BotKey) {
    return this.connectors.importLegacy(bot);
  }
}
export { NotificationRemote } from '../notifications/remote.js';
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotP34: ConnectorRemote;
  }
}
