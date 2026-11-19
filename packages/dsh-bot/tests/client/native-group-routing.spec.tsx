// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { stopGroupWork } from '../../src/client/stop-group.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { view } from './group-fixture.js';
import type { SupergroupWorkView } from '../../src/shared/supergroup.js';

function workView(): SupergroupWorkView {
  const group = view();
  group.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'input', owner: group.members[0]!.bot, readers: group.members.map(row => row.bot), expiresAt: 1000 };
  return { group, work: { id: 'work', revision: 5, owner: group.members[0]!.bot, originSessionId: 'origin', inputMessageId: 'input', inputMessageIds: ['input'], configDigest: 'digest', readers: group.members.map(row => row.bot), createdAt: 1, updatedAt: 1, expiresAt: 1000, group: { groupId: group.group.id, groupCreatedAt: group.group.createdAt }, turnIds: [], state: 'running', groupInputs: [], experts: [] } };
}
describe('automatic group composer bridge', () => {
  it('passes real member identities/reply through owner Remote, preserves conflict draft, and never falls back to ordinary send', async () => {
    const ctx = new Context(); const current = workView();
    const send = vi.fn();
    const sendGroupInput = vi.fn(async () => ({ ok: true, value: { view: current, receipt: { operationId: 'op', digest: 'digest', messageId: 'actual-root-input', expectedRevision: 5, state: 'conflict' } } }));
    const release = ctx.provide('remote.dshBot.groups', { send, list: async () => ({ ok: true, value: [current.group] }), view: async () => ({ ok: true, value: current.group }) } as never);
    const releaseSuper = ctx.provide('remote.dshBotSupergroup', { byGroup: async () => ({ ok: true, value: current }), sendGroupInput } as never);
    const actions = createGroupActions(ctx, { pollIntervalMs: 5000 });
    actions.catalog.reset({ groups: [current.group!] });
    const key = current.work.group!; const root = current.group!.group.rootSessionId;
    actions.patchDraft(root, value => ({ ...value, text: '@Alpha inspect cost', mentions: ['member:alpha'] }));
    try {
      await expect(actions.send!(key, { operationId: 'op', expectedMembershipRevision: 1, text: '@Alpha inspect cost', memberIds: ['member:alpha'], replyTo: 'historic-beta' })).rejects.toThrow('not queued');
      expect(sendGroupInput).toHaveBeenCalledExactlyOnceWith({ group: key, workId: 'work', expectedRevision: 5, operationId: 'op', text: '@Alpha inspect cost', memberIds: ['member:alpha'], replyTo: 'historic-beta' });
      expect(send).not.toHaveBeenCalled(); expect(actions.draft(root).text).toBe('@Alpha inspect cost');
      expect(actions.draft(root).errorCode).toBe('supergroup-conflict');
      await expect(actions.send!(key, { operationId: 'op2', expectedMembershipRevision: 1, text: 'file', fileReceiptIds: ['file'] })).rejects.toThrow('unsupported');
      expect(sendGroupInput).toHaveBeenCalledTimes(1);
    } finally { await releaseSuper(); await release(); await ctx.fiber.dispose(); }
  });
});

it('does not cancel a completed work from a stale running group, or cancel a different generation', async () => {
  const current = workView(), group = current.group!.group;
  const cancel = vi.fn(async () => {}), refresh = vi.fn(async () => {});
  const actions = { read: async () => current, cancel, refresh };
  current.work.state = 'completed';
  await stopGroupWork(group, actions);
  expect(cancel).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  current.work.state = 'running'; current.work.group!.groupCreatedAt += 1;
  await expect(stopGroupWork(group, actions)).rejects.toThrow('identity mismatch');
  expect(cancel).not.toHaveBeenCalled();
  current.work.group!.groupCreatedAt = group.createdAt; current.work.id = 'other-work';
  await expect(stopGroupWork(group, actions)).rejects.toThrow('identity mismatch');
  expect(cancel).not.toHaveBeenCalled();
});
