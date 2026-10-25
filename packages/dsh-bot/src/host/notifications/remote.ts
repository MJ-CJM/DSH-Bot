import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { BotKey } from '../../shared/identity.js';
import type { NotifyInput } from '../../shared/notifications.js';
import type { Notifications } from './service.js';
import { OperationError } from '../common/operations.js';
export class NotificationRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private notifications: Notifications,
  ) {
    super(ctx, 'dshBotNotificationRemote', { namespace: 'dshBot.notifications' });
  }
  @Remote async savePolicy(input: unknown, expected: number, confirmed: boolean) {
    return this.notifications.savePolicy(input, expected, confirmed);
  }
  @Remote async markRead(id: string, expected: number) {
    return this.notifications.markRead(id, expected);
  }
  @Remote async testNotification(owner: BotKey, input: NotifyInput, expectedScope: string, confirmed: true) {
    if (confirmed !== true) throw new OperationError('approval-denied');
    const policy = this.notifications.policy(input.policyId);
    if (policy.scopeDigest !== expectedScope) throw new OperationError('conflict');
    const r = await this.notifications.record(owner, input, { kind: 'tool', id: input.relatedId ?? input.operationId });
    return this.notifications.deliver(r.id, expectedScope);
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotNotificationRemote: NotificationRemote;
  }
}
