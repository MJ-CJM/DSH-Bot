import type { ProactiveWork } from './work.js';

/** Reference data only. No transcript, private memory, credentials or reusable grant. */
export function taskHandoff(work: ProactiveWork) {
  return {
    ticketId: work.ticketId, assignmentId: work.assignmentId,
    goal: work.acceptance?.goal ?? work.title,
    revision: work.revision, generation: work.generation,
    evidenceDigest: work.evidenceDigest ?? null,
    unresolved: work.state === 'accepted' ? 'none; accepted by owner' : 'owner acceptance required',
    scope: 'Read and discuss this task evidence only. This context does not authorize execution or sending.',
    source: { id: work.sourceId, triggerId: work.triggerId },
    expiresAt: work.expiresAt,
  };
}
