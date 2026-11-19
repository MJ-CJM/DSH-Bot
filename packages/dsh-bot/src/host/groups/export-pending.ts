import type { GroupRecord } from '../../shared/groups.js';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import { outlets } from '../data-flow/tool-guard.js';
import type { GroupState } from './state.js';

/** Count only metadata whose owner can safely discard. Reading the summary
 * must not reveal or revalidate private reply bodies, or reconstruct old output. */
export function countPendingGroupExports(state: GroupState, group: GroupRecord): number {
  if (group.archived) return 0;
  let flow: ReturnType<typeof outlets>;
  try { flow = outlets(state.registry); } catch { return 0; }
  if (!flow) return 0;
  let count = 0;
  for (const turn of state.turns(group)) {
    if (turn.membershipRevision !== group.membershipRevision) continue;
    for (const delivery of state.deliveries(turn.id)) {
      if (groupExportReviewStatus(group, turn, delivery) !== 'pending' ||
        !delivery.exportFlowId || !delivery.revision || delivery.revision < 1) continue;
      const row = flow.kernel.domain.table('flows').get(delivery.exportFlowId);
      // rejectReview accepts these states without reading or publishing content,
      // including replies whose source/audience/expiry no longer permits preview.
      if (row?.state === 'awaiting-approval' || row?.state === 'cancelled' && !row.envelope &&
        row.redactedAt !== undefined && !row.envelopeDigest) count++;
    }
  }
  return count;
}
