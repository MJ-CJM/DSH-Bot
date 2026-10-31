import type { NotificationPolicy } from '../../shared/integrations.js';
import { localTime, quietAt } from '../notifications/time.js';
export { localTime };
/** Uses the shipped notification policy/time semantics; deliberately has no notification send port. */
export function notificationDecision(at: number, policy: NotificationPolicy, used: number, lastAt?: number) {
  if (!policy.enabled) return 'policy-disabled';
  if (quietAt(at, policy)) return 'quiet';
  if (used >= policy.dailyLimit) return 'bot-budget';
  if (lastAt !== undefined && at - lastAt < policy.cooldownSec * 1000) return 'cooldown';
  return 'eligible';
}
