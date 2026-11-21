import { expect, it, vi } from 'vitest';
import { GROUP_ROOT_PRESET } from '../src/shared/groups.js';
import { Serial } from '../src/host/common/operations.js';
import { GroupMessages } from '../src/host/groups/messages.js';
import type { GroupRoots } from '../src/host/groups/roots.js';
import type { GroupState } from '../src/host/groups/state.js';

it('uses one round lookup and event snapshot to page a long group while preserving the latest summary and replies', async () => {
  const key = { groupId: 'group', groupCreatedAt: 1 };
  const group = { id: key.groupId, createdAt: key.groupCreatedAt, rootSessionId: 'root' };
  const turns = Array.from({ length: 2_000 }, (_, i) => ({
    id: 'turn-' + i, inputMessageId: 'input-' + i, replyTo: i > 0 ? 'input-' + (i - 1) : undefined, state: 'completed',
  }));
  const events = turns.map((turn, i) => ({
    type: 'user/message', seq: i + 1, time: i + 1,
    data: { id: turn.inputMessageId, source: { kind: 'user' }, content: [{ type: 'text', text: 'Example' }] },
  }));
  const snapshotEvents = vi.fn(() => [...events, { type: 'turn/end' }]);
  const agent = { session: { header: { agentPreset: GROUP_ROOT_PRESET }, snapshotEvents } };
  const readTurns = vi.fn(() => turns);
  const state = {
    queue: new Serial(), roots: new Map([[group.id, { agent }]]), registry: {}, reasons: new Map(),
    members: () => [], turns: readTurns, deliveries: () => [], record: () => group,
    closedExportReviews: () => new Map(), table: () => new Map(),
  } as unknown as GroupState;
  const history = new GroupMessages(state, { restore: async () => {} } as unknown as GroupRoots);
  const page = await history.view(key, { beforeSeq: 150, limit: 1 });
  expect(readTurns).toHaveBeenCalledTimes(1);
  expect(snapshotEvents).toHaveBeenCalledTimes(1);
  expect(page.messages).toHaveLength(1);
  expect(page.messages[0]).toMatchObject({ seq: 149, replyTo: 'input-147' });
  expect(page.hasEarlier).toBe(true);
  expect(page.latest?.seq).toBe(2000);
  expect((await history.summary(page.group)).latest).toEqual(page.latest);
});
