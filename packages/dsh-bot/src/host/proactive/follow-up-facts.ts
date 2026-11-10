import { createHash } from 'node:crypto';
import type { GroupRecord, GroupTurn, GroupDelivery } from '../../shared/groups.js';
import { followUpFactSchema, type FollowUpFact } from '../../shared/proactive/follow-up.js';

export function groupDeliveryFactTime(delivery: GroupDelivery, turn: GroupTurn) {
  return delivery.endedAt ?? delivery.updatedAt ?? delivery.startedAt ?? turn.createdAt;
}

/** Facts are small projections of existing state, never another task lifecycle. */
export function groupFollowUpFact(group: GroupRecord, turn: GroupTurn, deliveries: GroupDelivery[]): FollowUpFact {
  if (turn.group.groupId !== group.id || turn.group.groupCreatedAt !== group.createdAt ||
    deliveries.some(delivery => delivery.turnId !== turn.id)) throw new Error('Group fact ownership mismatch');
  const failed = deliveries.filter(delivery => delivery.state === 'failed');
  const condition: FollowUpFact['condition'] = group.archived || turn.state === 'cancelled'
    ? { kind: 'closed', reason: 'cancelled' }
    : failed.length ? { kind: 'failed', members: failed.slice(0, 16).map(delivery => ({
      deliveryId: delivery.id, memberId: delivery.memberId,
      reason: (delivery.failure?.message || delivery.reasonCode || delivery.stopReason || delivery.state).slice(0, 500),
    })) }
    : turn.state === 'accepted' || turn.state === 'running' ? { kind: 'tracking' }
    : { kind: 'closed', reason: 'resolved' };
  // Delivery state changes persist their own counter atomically. Summing the
  // constituent monotonic counters also covers a crash between two table writes.
  const nativeRevision = group.revision + turn.revision + deliveries.reduce((n, row) => n + (row.revision ?? 0), 0);
  const payload = { origin: { kind: 'group-turn' as const, turnId: turn.id }, title: group.name, condition };
  return followUpFactSchema.parse({
    ...payload, nativeId: turn.id, nativeRevision,
    // A rename/member edit or another delivery completing does not make an old failure new.
    occurredAt: new Date(group.archived ? group.updatedAt : condition.kind === 'failed'
      ? Math.max(...failed.map(row => groupDeliveryFactTime(row, turn)))
      : turn.updatedAt).toISOString(),
    payloadDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  });
}
