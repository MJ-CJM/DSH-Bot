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
  let inputIndex = -1;
  for (const [index, e] of events.entries()) {
    if (e.type === 'user/message' && !isNativeAmbientSource(e.data.source.kind)) {
      related = e.data.source.kind === 'user' && inputs.has(e.data.id); inputIndex = index; pending.clear();
    }
    if (related && e.type === 'approval/asked') pending.add(e.data.id);
    if (e.type === 'approval/decided') pending.delete(e.data.id);
  }
  const receipt = work.resumes?.at(-1);
  const relatedBusy = agentBusy && related && !events.slice(inputIndex + 1).some(e => e.type === 'turn/end');
  const resumeIndex = receipt ? events.findIndex(e => e.type === 'user/message' && e.data.id === receipt.messageId && e.data.source.kind === 'user') : -1;
  const resumeSettled = resumeIndex >= 0 && events.slice(resumeIndex + 1).some(e => e.type === 'turn/end');
  const state = work.state === 'cancelled' ? 'closed' : work.state === 'unknown' ? 'unknown'
    : pending.size ? relatedBusy ? 'waiting-approval' : 'unknown'
    : receipt?.state === 'unknown' ? 'unknown' : receipt?.state === 'dispatching' ? 'dispatch-intent'
    : work.state === 'running' || relatedBusy ? 'running'
    : receipt?.state === 'queued' && !resumeSettled ? 'queued'
    : work.blockers?.some(r => r.state === 'waiting') ? 'waiting-input'
    : work.blockers?.some(r => r.state === 'ready') ? 'ready-to-resume'
    : work.groupInputs.at(-1)?.delivery?.state === 'delivered' && work.state === 'completed' ? 'delivered'
    : work.state === 'completed' ? 'closed' : receipt?.state === 'queued' ? 'queued' : 'waiting-input';
  return { state, nativeApprovalCount: pending.size, holdsAgent: relatedBusy && pending.size > 0,
    timerWakeup: continuousCapabilities.timerWakeup, durableToolResume: continuousCapabilities.durableToolResume };
}
