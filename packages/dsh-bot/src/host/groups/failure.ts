import type { Agent } from '@deepseek-ai/dsh-agent';
import { GROUP_FAILURE_MESSAGE_MAX, type GroupFailure } from '../../shared/groups.js';

const clip = (text: string) => {
  if (text.length <= GROUP_FAILURE_MESSAGE_MAX) return text;
  let end = GROUP_FAILURE_MESSAGE_MAX - 1;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
};

/**
 * Read one member run's native terminal failure from the child's own Session log.
 * A local `spawn` result reports only `stopReason: 'error'` (it fills `diagnostic`
 * for out-of-process runs only); the structured `LlmFailure` is on `turn/end`.
 * Only a turn that ended after this delivery started counts, so an earlier run's
 * failure is never attributed to a later one.
 */
export function memberRunFailure(agent: Pick<Agent, 'session'> | undefined, startedAt: number): GroupFailure | undefined {
  const events = agent?.session.snapshotEvents() ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== 'turn/end') continue;
    const reason = event.data.reason;
    if (event.time < startedAt || reason.kind !== 'error') return undefined;
    const { code, status, message } = reason.error;
    return {
      ...(code ? { code: code.slice(0, 64) } : {}),
      ...(Number.isInteger(status) ? { status } : {}),
      message: clip(message),
    };
  }
  return undefined;
}
