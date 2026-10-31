import en from '../../../locale/en.json' with { type: 'json' };
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import { getBotBinding } from '../data-flow/agent-binding.js';
import { isLiveGroupWorker, getGroupWorkerBinding, workerReservations } from '../groups/worker-tool.js';
interface Lease { owner: Agent; from: BotKey; to: BotKey; presetId?: string; agent?: Agent }
const leases = new Map<string, Lease>();
const same = (a: BotKey | undefined, b: BotKey) => a?.botId === b.botId && a.botCreatedAt === b.botCreatedAt;
/** Reserved before native creation. Only its fresh startup Agent may claim it once. */
export function reserveDelegate(childId: string, owner: Agent, from: BotKey, to: BotKey, presetId?: string) {
  const lease: Lease = { owner, from, to, presetId };
  if (leases.has(childId)) throw new Error('Delegate identity already reserved');
  leases.set(childId, lease);
  return () => { if (leases.get(childId) === lease) leases.delete(childId); };
}
export function protectDelegateContinuation(agent: Agent, bot: BotKey, source: string) {
  const lease = leases.get(agent.session.id);
  if (source === 'startup' && lease && !lease.agent && same(bot, lease.to) &&
    agent.session.header.parentSession === lease.owner.session.id && agent.session.header.agentPreset === lease.presetId)
    lease.agent = agent;
  const active = () => {
    const current = leases.get(agent.session.id);
    return Boolean(current?.agent === agent && same(bot, current.to) && same(getBotBinding(current.owner), current.from) &&
      current.owner.ctx.get('agents')?.get(current.owner.session.id) === current.owner &&
      agent.session.header.parentSession === current.owner.session.id);
  };
  const header = agent.session.header;
  const child = Boolean(header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0));
  const group = getGroupWorkerBinding(agent);
  const freshGroup = source === 'startup' && group && workerReservations.get(agent.session.id) === group &&
    (!group.agent || group.agent === agent) && group.isActive?.();
  // Fail before native materialization publishes a default-parent activation/settlement.
  // Cold history reads do not create an Agent; an execution resume requires a new checked child.
  if (child && !active() && !freshGroup)
    throw new HarnessError(en.tools['bot_delegate.continuationBlocked'], 'automation/unavailable');
  return agent.ctx.effect(() => agent.ctx.on('agent/pre-step', async (_payload, next) => {
    if (!child || isLiveGroupWorker(agent) || active()) return next();
    // Keep this Agent-owned guard after unload and after its startup lease ends.
    return { kind: 'reject' as const, reason: en.tools['bot_delegate.continuationBlocked'] };
  }, { prepend: true }), 'dsh-bot: checked delegate activation lease');
}
