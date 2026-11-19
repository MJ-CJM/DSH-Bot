// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createGroupActions, GroupRouteUnavailable } from '../../src/client/groups-state.js';
import { selectGroupComposer } from '../../src/client/workspace-group.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { GROUP_ROOT_PRESET } from '../../src/shared/groups.js';
import type { SupergroupWorkView } from '../../src/shared/supergroup.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { bots, summary, view } from './group-fixture.js';
import { button, click, field, fill } from './helpers.js';
import en from '../../locale/en.json';

function setup() {
  const ctx = new Context(), data = view();
  const send = vi.fn(async () => ({ ok: true, value: { id: 'turn' } }));
  const read = vi.fn(async () => ({ ok: true, value: data }));
  ctx.provide('remote.dshBot.groups', { view: read, list: async () => ({ ok: true, value: [summary()] }), send } as never);
  const actions = createGroupActions(ctx, {});
  const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  const request = { operationId: 'send:exact', expectedMembershipRevision: 1, text: 'Keep this draft' };
  actions.patchDraft(data.group.rootSessionId, d => ({ ...d, text: request.text }));
  const automatic = () => {
    const owner = data.members[0]?.bot; if (!owner) throw Error('Missing fixture owner');
    data.group.supergroup = { workId: 'work', originSessionId: 'origin', originMessageId: 'input', owner,
      readers: data.members.map(m => m.bot), expiresAt: 99999 };
    const current: SupergroupWorkView = { group: data, work: { id: 'work', revision: 1, owner,
      originSessionId: 'origin', inputMessageId: 'input', inputMessageIds: ['input'], configDigest: 'digest',
      readers: data.members.map(m => m.bot), createdAt: 1, updatedAt: 1, expiresAt: 99999, group: key,
      turnIds: [], groupInputs: [], experts: [], state: 'running' } };
    return current;
  };
  return { ctx, data, actions, key, request, send, read, automatic, close: () => ctx.fiber.dispose() };
}

it('routes a fresh ordinary group even before the directory loads', async () => {
  const f = setup();
  try {
    await expect(f.actions.send(f.key, f.request)).resolves.toEqual({ turnId: 'turn' });
    expect(f.read).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledExactlyOnceWith(f.key, f.request);
  } finally { await f.close(); }
});

it.each(['unavailable', 'malformed', 'generation', 'stale-directory', 'missing-supergroup', 'missing-work', 'wrong-work-group'] as const)
('never falls back to ordinary sending when group routing is %s', async scenario => {
  const f = setup(), sendGroupInput = vi.fn();
  try {
    if (scenario === 'unavailable') f.read.mockRejectedValueOnce(Error('offline'));
    if (scenario === 'malformed') f.read.mockResolvedValueOnce({ ok: true, value: {} as never });
    if (scenario === 'generation') f.data.group.createdAt++;
    if (scenario === 'stale-directory') f.actions.catalog.reset({ groups: [summary()] });
    if (['stale-directory', 'missing-supergroup', 'missing-work', 'wrong-work-group'].includes(scenario)) {
      const current = f.automatic();
      if (scenario !== 'missing-supergroup') f.ctx.provide('remote.dshBotSupergroup', {
        byGroup: async () => ({ ok: true, value: scenario === 'missing-work' ? null : scenario === 'wrong-work-group'
          ? { ...current, work: { ...current.work, group: { ...f.key, groupCreatedAt: 42 } } } : current }), sendGroupInput,
      } as never);
    }
    await expect(f.actions.send(f.key, f.request)).rejects.toBeInstanceOf(GroupRouteUnavailable);
    expect(f.send).not.toHaveBeenCalled(); expect(sendGroupInput).not.toHaveBeenCalled();
    expect(f.actions.draft(f.data.group.rootSessionId).text).toBe(f.request.text);
  } finally { await f.close(); }
});

it('routes an automatic group from fresh identity with an empty directory and preserves exact work CAS', async () => {
  const f = setup(), current = f.automatic();
  const sendGroupInput = vi.fn(async () => ({ ok: true, value: { view: current,
    receipt: { operationId: f.request.operationId, digest: 'digest', messageId: 'input-2', expectedRevision: 1, state: 'queued' } } }));
  f.ctx.provide('remote.dshBotSupergroup', { byGroup: async () => ({ ok: true, value: current }), sendGroupInput } as never);
  try {
    await f.actions.send(f.key, f.request);
    expect(f.send).not.toHaveBeenCalled();
    expect(sendGroupInput).toHaveBeenCalledExactlyOnceWith({ group: f.key, workId: 'work', expectedRevision: 1,
      operationId: f.request.operationId, text: f.request.text, memberIds: [] });
  } finally { await f.close(); }
});

it('does not dispatch after native takeover or navigation cancels a pending route read', async () => {
  const f = setup(), controller = new AbortController();
  let release!: (v: { ok: boolean; value: ReturnType<typeof view> }) => void;
  f.read.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  try {
    const pending = f.actions.send(f.key, f.request, controller.signal);
    controller.abort(); release({ ok: true, value: f.data });
    await expect(pending).rejects.toBeInstanceOf(GroupRouteUnavailable);
    expect(f.send).not.toHaveBeenCalled(); expect(f.actions.draft(f.data.group.rootSessionId).text).toBe(f.request.text);
  } finally { await f.close(); }
});

it('only claims proven group roots, and always yields to native pending interactions', async () => {
  const f = setup(), id = 'group-root-12345678-1234-1234-1234-123456789abc';
  try {
    expect(selectGroupComposer({ sessionId: id as never }, f.actions)).toBeNull();
    expect(selectGroupComposer({ sessionId: id as never }, f.actions, 'standard')).toBeNull();
    expect(selectGroupComposer({ sessionId: id as never }, f.actions, GROUP_ROOT_PRESET)).toEqual({ sessionId: id });
    f.actions.catalog.reset({ groups: [summary()] });
    expect(selectGroupComposer({ sessionId: f.data.group.rootSessionId as never, pendingInteraction: {} as never }, f.actions, GROUP_ROOT_PRESET)).toBeNull();
    expect(selectGroupComposer({ sessionId: f.data.group.rootSessionId as never }, f.actions)).toEqual({ sessionId: f.data.group.rootSessionId });
  } finally { await f.close(); }
});

it('retains the composer draft and operation when the route becomes unknown', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const f = setup(), element = document.createElement('div'), root = createRoot(element);
  document.body.append(element);
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  try {
    await act(async () => root.render(<GroupConversation workspace summary={summary()} actions={f.actions} bots={bots}
      expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
    await vi.waitFor(() => expect(element.querySelector('textarea')).toBeTruthy());
    await fill(field(element, en.ui['groups.message']), 'Keep unknown draft');
    f.read.mockRejectedValueOnce(Error('offline'));
    await click(button(element, en.ui['groups.send']));
    await vi.waitFor(() => expect(element.textContent).toContain(en.ui['groups.routeUnavailable']));
    expect(field(element, en.ui['groups.message']).value).toBe('Keep unknown draft');
    expect(f.actions.draft(f.data.group.rootSessionId).operation?.request.operationId).toBeTruthy();
    expect(f.send).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); element.remove(); await f.close(); }
});
