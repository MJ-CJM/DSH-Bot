import type { GroupRecord, GroupTurn, GroupViewDelivery } from './groups.js';

/** Classify review work from metadata without loading the reply or its provenance. */
export function groupExportReviewStatus(group: GroupRecord, turn: GroupTurn | undefined, delivery: GroupViewDelivery): 'pending' | 'stale' | undefined {
  if (!turn || turn.id !== delivery.turnId || turn.group.groupId !== group.id || turn.group.groupCreatedAt !== group.createdAt ||
      delivery.outputMessageId || delivery.outputSeq !== undefined || delivery.staleExportClosedAt !== undefined) return;
  const held = delivery.reasonCode === 'export-approval-required' && delivery.exportFlowId;
  const legacy = !turn.guestQuestion && delivery.state === 'unknown' && delivery.reasonCode === 'native-failure' && !delivery.exportFlowId;
  if (held || legacy) return turn.membershipRevision === group.membershipRevision ? 'pending' : 'stale';
}
