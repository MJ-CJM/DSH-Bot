import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { digest } from '../common/operations.js';

// Only the live owner bridge can grant this capability. Source strings alone confer no authority.
const admitted = new WeakMap<Agent, Map<string, { digest: string; check(): Promise<void> }>>();
export function admitSupergroupInput(agent: Agent, message: UserMessage, check: () => Promise<void>) {
  let entries = admitted.get(agent);
  if (!entries) { entries = new Map(); admitted.set(agent, entries); }
  entries.set(message.id, { digest: digest(message), check });
  return () => entries?.delete(message.id);
}
export async function isAdmittedSupergroupInput(agent: Agent, message: UserMessage) {
  const entry = admitted.get(agent)?.get(message.id);
  if (!entry || entry.digest !== digest(message)) return false;
  await entry.check(); return true;
}
