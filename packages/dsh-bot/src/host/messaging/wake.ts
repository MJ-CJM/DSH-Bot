import type { PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { wakeSourceSchema } from '../../shared/messaging.js';
const ambient = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']);
export const isWake = (message: UserMessage) => wakeSourceSchema.safeParse(message.source).success;
/** Native next() adds ambient context. It is not business input that may wake a model. */
export function withoutWakeControls(claimed: UserMessage[], decision: PreStepDecision): PreStepDecision {
  if (decision.kind !== 'enter') return decision;
  const messages = decision.messages.filter((m) => !isWake(m));
  if (claimed.some(isWake) && !messages.some((m) => !ambient.has(m.source.kind))) return { kind: 'reject' };
  return { ...decision, messages };
}
