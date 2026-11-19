import { expect, it } from 'vitest';
import { countPendingGroupExports } from '../src/host/groups/export-pending.js';
import type { GroupState } from '../src/host/groups/state.js';
import type { GroupRecord } from '../src/shared/groups.js';
import { flowFixture, alpha, beta } from './deepening/managed-flow-fixture.js';

it('counts actionable pending metadata without reading any private body or invoking preview', () => {
  const group = { id: 'group', createdAt: 1, membershipRevision: 2 } as GroupRecord;
  const row = { state: 'awaiting-approval' };
  Object.defineProperty(row, 'envelope', { get() { throw Error('Private body must not be inspected'); } });
  const flows = new Map<string, object>([['held', row], ['rejected', { state: 'cancelled', redactedAt: 1 }],
    ['sent', { state: 'delivered' }], ['uncertain', { state: 'unknown' }]]);
  const base = { turnId: 'turn', reasonCode: 'export-approval-required', revision: 1 };
  const deliveries = ['held', 'rejected', 'sent', 'uncertain', 'missing'].map(exportFlowId => ({ ...base, exportFlowId }));
  deliveries.push({ ...base, exportFlowId: 'held', reasonCode: 'export-rejected' },
    { ...base, exportFlowId: 'held', revision: 0 }, { ...base, exportFlowId: 'held', turnId: 'another' });
  const state = { registry: { memoryKernel: {}, memoryOutlets: { kernel: { domain: { table: () => flows } } } },
    turns: () => [{ id: 'turn', group: { groupId: 'group', groupCreatedAt: 1 }, membershipRevision: 2 },
      { id: 'old-turn', group: { groupId: 'group', groupCreatedAt: 1 }, membershipRevision: 1 }],
    deliveries: (turnId: string) => turnId === 'old-turn' ? [{ ...base, turnId, exportFlowId: 'held' }] : deliveries } as unknown as GroupState;
  expect(countPendingGroupExports(state, group)).toBe(2);
  expect(countPendingGroupExports(state, { ...group, archived: true })).toBe(0);
  expect(countPendingGroupExports(state, { ...group, createdAt: 2 })).toBe(0);
  expect(countPendingGroupExports(state, { ...group, membershipRevision: 3 })).toBe(0);
  Object.assign(state.registry, { memoryOutlets: undefined });
  expect(countPendingGroupExports(state, group)).toBe(0);
});

it('keeps an unreadable held reply counted while safe owner discard remains available', async () => {
  const f = await flowFixture();
  try {
    const target = { kind: 'group' as const, groupId: 'group', groupCreatedAt: 1, members: [alpha, beta] };
    const id = await f.flow.holdForReview(f.flow.draft('group-result', alpha, 'private', 'pending', target, 'PRIVATE_COUNT_CANARY'));
    const state = { registry: f.registry(), turns: () => [{ id: 'turn', group: { groupId: 'group', groupCreatedAt: 1 }, membershipRevision: 1 }],
      deliveries: () => [{ id: 'delivery', turnId: 'turn', reasonCode: 'export-approval-required', exportFlowId: id, revision: 1 }] } as unknown as GroupState;
    const group = { id: 'group', createdAt: 1, membershipRevision: 1 } as GroupRecord;
    expect(countPendingGroupExports(state, group)).toBe(1);
    f.current.set('beta', 99);
    expect(() => f.flow.review(id)).toThrow();
    expect(countPendingGroupExports(state, group)).toBe(1);
    await f.flow.rejectReview(id);
    // The durable delivery still needs its final rejection receipt; discard is idempotent.
    expect(countPendingGroupExports(state, group)).toBe(1);
    state.deliveries = () => [{ turnId: 'turn', reasonCode: 'export-rejected', revision: 2 }] as never;
    expect(countPendingGroupExports(state, group)).toBe(0);
  } finally { await f.close(); }
});
