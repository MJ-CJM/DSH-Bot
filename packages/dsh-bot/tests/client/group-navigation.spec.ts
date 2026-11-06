import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { createGroupActions } from '../../src/client/groups-state.js';
const group = { groupId: 'group', groupCreatedAt: 1 };
describe('workspace group navigation ownership', () => {
  it.each(['owner-unmount', 'plugin-unload', 'newer-open'] as const)('never forces late navigation after %s', async reason => {
    const ctx = new Context(), openSession = vi.fn();
    let settle!: (receipt: Awaited<ReturnType<GroupMethods['open']>>) => void;
    const open = vi.fn<GroupMethods['open']>(() => new Promise(resolve => { settle = resolve; }));
    ctx.provide('remote.dshBot.groups', { open } as unknown as GroupMethods);
    ctx.provide('uiWorkspace', { openSession } as unknown as Context['uiWorkspace']);
    const actions = createGroupActions(ctx, {}), owner = new AbortController();
    try {
      const pending = actions.open(group, owner.signal);
      const finishFirst = settle;
      if (reason === 'owner-unmount') owner.abort();
      if (reason === 'plugin-unload') await ctx.fiber.dispose();
      if (reason === 'newer-open') {
        const next = actions.open({ groupId: 'other', groupCreatedAt: 2 });
        settle({ ok: true, value: { sessionId: 'next-root', workspaceId: 'workspace' } }); await next;
      }
      finishFirst({ ok: true, value: { sessionId: 'old-root', workspaceId: 'workspace' } }); await pending;
      expect(openSession).toHaveBeenCalledTimes(reason === 'newer-open' ? 1 : 0);
      if (reason === 'newer-open') expect(openSession).toHaveBeenCalledWith('next-root');
    } finally { await ctx.fiber.dispose(); }
  });
});

it('loads an older quote only from its exact group, then uses public retained session loadThrough', async () => {
  const { view } = await import('./group-fixture.js');
  const ctx = new Context(), loadThrough = vi.fn(async () => {}), binding = vi.fn(() => ({ session: { loadThrough } }));
  const latest = view(), original = latest.messages[0];
  if (!original) throw new Error('Missing quote fixture');
  latest.messages = [{ ...original, id: 'new', seq: 10 }]; latest.hasEarlier = true;
  const older = { ...view(), hasEarlier: false };
  const read = vi.fn<GroupMethods['view']>(async (_key, options) => ({ ok: true, value: options.beforeSeq ? older : latest }));
  ctx.provide('remote.dshBot.groups', { view: read, open: async () => ({ ok: true, value: { sessionId: 'group-root-one', workspaceId: 'workspace' } }) } as unknown as GroupMethods);
  ctx.provide('sessions', { binding } as never);
  try {
    const actions = createGroupActions(ctx, {});
    const quoted = await actions.quotedMessage(group, original.id);
    expect(quoted?.id).toBe(original.id);
    expect(read.mock.calls.every(call => call[0] === group)).toBe(true);
    expect(read.mock.calls[1]?.[1]).toEqual({ beforeSeq: 10 });
    await actions.loadThrough(group, original.seq);
    expect(binding).toHaveBeenCalledWith('group-root-one'); expect(loadThrough).toHaveBeenCalledWith(original.seq);
  } finally { await ctx.fiber.dispose(); }
});

it('stops quoted-message pagination when the requesting view is cancelled', async () => {
  const { view } = await import('./group-fixture.js');
  const ctx = new Context(), controller = new AbortController();
  let settle: (result: Awaited<ReturnType<GroupMethods['view']>>) => void = () => {};
  const read = vi.fn<GroupMethods['view']>(() => new Promise(resolve => { settle = resolve; }));
  ctx.provide('remote.dshBot.groups', { view: read } as unknown as GroupMethods);
  try {
    const actions = createGroupActions(ctx, {});
    const pending = actions.quotedMessage(group, 'older-question', controller.signal);
    controller.abort();
    settle({ ok: true, value: { ...view(), hasEarlier: true } });
    expect(await pending).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await actions.quotedMessage(group, 'older-question', controller.signal)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  } finally { await ctx.fiber.dispose(); }
});
