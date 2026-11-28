import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import en from '../../../locale/en.json' with { type: 'json' };
import { OperationError } from '../common/operations.js';

type Policy = 'ask' | 'never';
interface ApprovalSource { root: Agent; policy: Policy; revision: number }
const current = new WeakMap<Agent, () => boolean>();
function policy(service: ApprovalService, agent: Agent): Policy | undefined {
  const value = service.overrideOf(agent.session) ?? service.config.policy ?? 'ask';
  return value === 'ask' || value === 'never' ? value : undefined;
}
/** The root is supplied only by the exact live group reservation, never by model data. */
export function installWorkerApproval(agent: Agent, root: () => Agent | undefined) {
  return agent.ctx.effect(() => {
    let inherited: ApprovalSource | undefined;
    let closed = false;
    const source = (): ApprovalSource | undefined => {
      const parent = root(), approval = parent?.ctx.get('approval');
      if (!parent || !approval) return;
      const selected = policy(approval, parent); if (!selected) return;
      const revision = parent.session.snapshotEvents().findLast(event => event.type === 'approval/policy')?.seq ?? -1;
      return { root: parent, policy: selected, revision };
    };
    const matches = () => {
      try {
        const next = source(), approval = agent.ctx.get('approval');
        return Boolean(!closed && next && approval && inherited && next.root === inherited.root &&
          next.policy === inherited.policy && next.revision === inherited.revision && policy(approval, agent) === next.policy);
      } catch { return false; }
    };
    const refresh = () => {
      if (closed) return false;
      try {
        const next = source(), approval = agent.ctx.get('approval');
        if (!next || !approval) return false;
        if (policy(approval, agent) !== next.policy) approval.setPolicy(agent, next.policy);
        inherited = next;
        return matches();
      } catch { return false; }
    };
    current.set(agent, matches);
    refresh();
    const beforeStep = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (!refresh()) throw new OperationError('approval-denied');
      return next();
    }, { prepend: true });
    // Tools may request native approval from inside their body, after tools/execute.
    // Revalidate at the public answerer return boundary before the tool resumes;
    // returning rejection also keeps the native approval audit outcome accurate.
    const approval = agent.ctx.on('approval/request', async (request, next) => {
      if (request.agent !== agent) return next();
      if (request.signal?.aborted) return 'cancelled';
      const admitted = inherited;
      if (!admitted || !matches()) return 'rejected';
      const outcome = await next();
      if (outcome !== 'allowed-once') return outcome;
      if (request.signal?.aborted) return 'cancelled';
      try {
        const settled = source();
        return !closed && matches() && settled?.root === admitted.root && settled.policy === admitted.policy &&
          settled.revision === admitted.revision ? outcome : 'rejected';
      } catch { return 'rejected'; }
    }, { prepend: true });
    const guidance = agent.ctx.systemPrompt.context({ name: 'dsh-bot:group-approval', required: true,
      order: agent.ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 1, interpolate: false,
      text: () => matches() ? en.tools['group_message.approvalGuidance'].replace('{policy}', inherited?.policy ?? 'never') : '',
    });
    return () => { closed = true; if (current.get(agent) === matches) current.delete(agent); approval(); beforeStep(); guidance(); };
  }, 'dsh-bot: group root approval policy');
}
/** This also rejects an approval that outlived a root policy change, even ask→never→ask. */
export const workerApprovalMatches = (agent: Agent): boolean => current.get(agent)?.() === true;
