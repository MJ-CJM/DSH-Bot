import type { ProactiveWork } from './work.js';

/** Read-only projection. Unknown execution never becomes permission to retry. */
export function workProgress(work: ProactiveWork, now = Date.now()) {
  const followUp = work.groupReview?.followUp;
  const budget = followUp?.budget ?? work.groupReview?.budget;
  const expiresAt = budget?.deadlineAt ?? work.taskLimits?.deadlineAt ?? work.expiresAt;
  const expired = Date.parse(expiresAt) <= now || Date.parse(work.expiresAt) <= now;
  const uncertain = work.state === 'unknown' || work.groupReview?.state === 'unknown' || followUp?.state === 'unknown';
  const waiting = !expired && !uncertain && followUp?.state === 'armed';
  const proof = work.evidenceDigest ? 'evidence' : work.state === 'pending' || (work.state === 'unknown' && work.recoveryRevision !== undefined && !work.inputId && !work.externalRunId && !work.groupRepair) ? 'not-sent' : 'unknown';
  return {
    reason: uncertain ? 'unknown' : expired ? 'expired' : waiting ? 'fact' : work.state === 'delivered' ? 'review' : ['pending', 'claimed', 'sent'].includes(work.state) ? 'running' : 'settled',
    owner: followUp?.bot ?? work.target.bot,
    expiresAt,
    proof,
    // Reservations are ceilings, not measured remaining tokens.
    tokenCeiling: budget?.totalTokens ?? work.taskLimits?.maxTokens,
    remainingCalls: waiting ? 1 : followUp ? 0 : undefined,
    next: uncertain ? 'reconcile' : waiting ? 'wait' : work.state === 'delivered' ? 'review' : 'inspect',
  } as const;
}
