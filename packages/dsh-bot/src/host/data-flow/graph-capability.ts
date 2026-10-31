import type { Agent } from '@deepseek-ai/dsh-agent';
// Host-owned exact-call capability for copy/cleanup only; no Remote/tool argument can create one.
const calls = new WeakMap<Agent, Set<string>>();
export const graphCapability = (agent: Agent, callId: string) => calls.get(agent)?.has(callId) ?? false;
export async function withGraphCapability<T>(agent: Agent, callId: string, work: () => Promise<T>): Promise<T> {
  let owned = calls.get(agent); if (!owned) { owned = new Set(); calls.set(agent, owned); }
  owned.add(callId);
  try { return await work(); } finally { owned.delete(callId); if (!owned.size) calls.delete(agent); }
}
