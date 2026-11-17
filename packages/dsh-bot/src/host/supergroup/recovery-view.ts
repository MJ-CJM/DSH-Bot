import { isNativeAmbientSource } from '../common/native-ambient-source.js';
import type { SupergroupWork } from '../../shared/supergroup.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-user-approval';

export const continuousCapabilities = Object.freeze({ timerWakeup: false, durableToolResume: false,
  timerReason: 'native-cold-recovery-unproven' as const, toolReason: 'native-approval-is-process-local' as const });
/** Read-only projection of Work and native Session authority. Never creates a second state machine. */
export function recoveryView(work: SupergroupWork, events: readonly SessionEvent[], agentBusy: boolean) {
  const pending = new Set<string>();
  const inputs = new Set([...work.inputMessageIds, ...(work.resumes ?? []).map(r => r.messageId)]);
  let related = false;
  for (const e of events) {
    if (e.type === 'user/message' && !isNativeAmbientSource(e.data.source.kind)) {
      related = e.data.source.kind === 'user' && inputs.has(e.data.id); pending.clear();
    }
    if (related && e.type === 'approval/asked') pending.add(e.data.id);
    if (e.type === 'approval/decided') pending.delete(e.data.id);
  }
  const receipt = work.resumes?.at(-1);
  const state = work.state === 'cancelled' ? 'closed' : work.state === 'unknown' ? 'unknown'
    : pending.size ? agentBusy ? 'waiting-approval' : 'unknown'
    : receipt?.state === 'unknown' ? 'unknown' : receipt?.state === 'dispatching' ? 'dispatch-intent'
    : work.state === 'running' || agentBusy ? 'running'
    : work.blockers?.some(r => r.state === 'waiting') ? 'waiting-input'
    : work.blockers?.some(r => r.state === 'ready') ? 'ready-to-resume'
    : work.groupInputs.at(-1)?.delivery?.state === 'delivered' && work.state === 'completed' ? 'delivered'
    : work.state === 'completed' ? 'closed' : receipt?.state === 'queued' ? 'queued' : 'waiting-input';
  return { state, nativeApprovalCount: pending.size, holdsAgent: agentBusy && pending.size > 0,
    timerWakeup: continuousCapabilities.timerWakeup, durableToolResume: continuousCapabilities.durableToolResume };
}
