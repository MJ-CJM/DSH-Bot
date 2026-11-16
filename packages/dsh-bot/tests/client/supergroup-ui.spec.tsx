// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createSupergroupUiBridge, SupergroupWorkCard, supergroupMessageDefinition } from '../../src/client/supergroup.js';
import type { SupergroupWorkView } from '../../src/shared/supergroup.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { BotCatalog } from '../../src/client/state.js';
import { bots, view } from './group-fixture.js';
import { button, click } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

function workView(): SupergroupWorkView {
  const group = view();
  const key = { groupId: group.group.id, groupCreatedAt: group.group.createdAt };
  group.turns = [{ id: 'linked-turn', group: key, operationId: 'sg', requestDigest: 'digest', inputMessageId: 'group-input',
    createdAt: 1, updatedAt: 1, revision: 2, schemaVersion: 1, membershipRevision: 1, state: 'running',
    orderedMemberIds: group.members.map(row => row.id), mode: 'natural', protocol: 2, contextThroughSeq: 1 }];
  return { group, work: { groupInputs: [], id: 'work-1', revision: 3, owner: { botId: 'alpha', botCreatedAt: 1 },
    originSessionId: 'origin', inputMessageId: 'input', inputMessageIds: ['input', 'continue-input'],
    configDigest: 'digest', readers: [{ botId: 'alpha', botCreatedAt: 1 }],
    createdAt: 1, updatedAt: 1, expiresAt: 1000, group: key, turnIds: ['linked-turn'], state: 'running', experts: [] } };
}
async function fixture(language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(); let data: SupergroupWorkView | null = workView();
  const remote = { forSession: vi.fn(async () => ({ ok: true as const, value: data })),
    cancel: vi.fn<(_: { workId: string; expectedRevision: number }) => Promise<RemoteResult<null>>>(async () => ({ ok: true as const, value: null })),
    settings: vi.fn(async () => ({ ok: true as const, value: { enabled: false } })),
    configure: vi.fn(async () => ({ ok: true as const, value: { enabled: false } })) };
  ctx.provide('remote.dshBotSupergroup', remote);
  const groupRemote = { view: vi.fn(async () => ({ ok: true, value: data?.group })),
    list: vi.fn(async () => ({ ok: true, value: [] })), cancel: vi.fn(async () => ({ ok: true, value: true })) };
  ctx.provide('remote.dshBot.groups', groupRemote as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {}), bridge = createSupergroupUiBridge(ctx, actions);
  const openDiscussion = vi.spyOn(actions, 'open').mockResolvedValue();
  const botSnapshot = { entries: bots.map(bot => ({ bot })) };
  const catalog = { subscribe: () => () => {}, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('main'); document.body.append(element); const root = createRoot(element);
  let sessionId = 'origin', messageId = 'input', revision = 0;
  const render = () => act(async () => root.render(<>
    <p data-native-input="">Human request</p>
    <SupergroupWorkCard key={JSON.stringify([sessionId, messageId])} sessionId={sessionId} messageId={messageId}
      bridge={bridge} actions={actions} bots={catalog} nativeRevision={revision} t={t} />
    <textarea defaultValue="Keep native draft" />
  </>));
  return { ctx, remote, groupRemote, bridge, openDiscussion, element, t, render,
    data: () => data,
    async update(value: SupergroupWorkView | null) { data = value; revision++; await render(); },
    async navigate(id: string, message = 'input') { sessionId = id; messageId = message; await render(); },
    async close() { await act(async () => root.unmount()); element.remove(); await ctx.fiber.dispose(); },
  };
}

it.each(['en', 'zh'] as const)('%s actual card joins exact work, keeps native draft, stops whole work without turn cancellation', async language => {
  const f = await fixture(language);
  try {
    await f.render();
    await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work="work-1"]')).toBeTruthy());
    expect(f.element.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
    await click(button(f.element, f.t('supergroup.stop')));
    expect(f.remote.cancel).toHaveBeenCalledExactlyOnceWith({ workId: 'work-1', expectedRevision: 3 });
    expect(f.groupRemote.cancel).not.toHaveBeenCalled();
    expect(f.element.querySelector('textarea')?.value).toBe('Keep native draft');
    const next = workView(); next.work.revision++; next.group?.turns[0]?.orderedMemberIds.push('member:expert');
    await f.update(next);
    await vi.waitFor(() => expect(f.element.textContent).toContain(f.t('groups.turnSummary', { count: 3, state: f.t('groups.running') })));
    await f.navigate('origin', 'continue-input');
    await vi.waitFor(() => expect(f.remote.forSession).toHaveBeenCalledWith({ sessionId: 'origin', messageId: 'continue-input' }));
    expect(f.element.querySelector('[data-supergroup-work]')).toBeNull();
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('%s compact card shows real work and roster and opens only the exact discussion on request', async language => {
  const f = await fixture(language);
  try {
    const data = workView();
    const group = data.group;
    const member = group?.members[0];
    if (!group || !member) throw new Error('Missing fixture group');
    group.group.name = 'Review this implementation';
    // Reuse of a name/id from another Bot generation must not project its face.
    member.bot.botCreatedAt = 999;
    await f.update(data);
    await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work]')).toBeTruthy());
    const card = f.element.querySelector('[data-supergroup-work]');
    if (!card) throw new Error('Missing work card');
    expect(card.querySelector('strong')?.textContent).toBe(group.group.name);
    expect(card.textContent).toContain(f.t('supergroup.members', { count: 2 }));
    expect(card.querySelector('[data-bot-id="beta"]')?.getAttribute('data-avatar-variant')).toBe('spout');
    expect(card.querySelector('[data-bot-id="alpha"]')?.getAttribute('data-avatar-variant')).toBe('classic');
    expect(card.querySelector('details')?.open).toBe(false);
    expect(f.openDiscussion).not.toHaveBeenCalled();
    await click(button(f.element, f.t('supergroup.viewDiscussion')));
    expect(f.openDiscussion).toHaveBeenCalledExactlyOnceWith(data.work.group);
    expect(f.element.querySelector('textarea')?.value).toBe('Keep native draft');
    data.work.state = 'completed'; await f.update(data);
    await vi.waitFor(() => expect(card.getAttribute('data-supergroup-state')).toBe('completed'));
    expect([...card.querySelectorAll('button')].some(row => row.textContent?.includes(f.t('supergroup.stop')))).toBe(false);
    expect([...card.querySelectorAll('button')].some(row => row.textContent?.includes(f.t('supergroup.viewDiscussion')))).toBe(true);
  } finally { await f.close(); }
});

it('rejects a mismatched session/group reply and never renders the previous work after navigation', async () => {
  const f = await fixture();
  try {
    await f.render(); await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work]')).toBeTruthy());
    await f.navigate('other-session');
    await vi.waitFor(() => expect(f.element.textContent).toContain(f.t('supergroup.unavailable')));
    expect(f.element.querySelector('[data-supergroup-work]')).toBeNull();
    const wrong = workView(); if (wrong.group) wrong.group.group.createdAt = 999;
    await f.update(wrong); await f.navigate('origin');
    await vi.waitFor(() => expect(f.element.textContent).toContain(f.t('supergroup.unavailable')));
    expect(f.element.querySelector('[data-supergroup-work]')).toBeNull();
  } finally { await f.close(); }
});

it('an unlinked ordinary input renders no collaboration and failed refresh retains a labelled prior result', async () => {
  const f = await fixture();
  try {
    await f.update(null);
    await vi.waitFor(() => expect(f.remote.forSession).toHaveBeenCalled());
    expect(f.element.querySelector('[data-supergroup-work]')).toBeNull();
    await f.update(workView()); await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work]')).toBeTruthy());
    f.remote.forSession.mockRejectedValue(new Error('disconnected'));
    await f.update(workView());
    await vi.waitFor(() => expect(f.element.querySelector('[role="alert"]')?.textContent).toBe(f.t('supergroup.unavailable')));
    expect(f.element.querySelector('[data-supergroup-work="work-1"]')).toBeTruthy();
  } finally { await f.close(); }
});

it('discarding a passive read prevents its late response from notifying or leaking to another source', async () => {
  const f = await fixture();
  try {
    let settle: ((value: Awaited<ReturnType<typeof f.remote.forSession>>) => void) | undefined;
    f.remote.forSession.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const source = f.bridge.source('origin', 'input'), listener = vi.fn();
    const off = source.subscribe(listener); off();
    settle?.({ ok: true, value: workView() }); await Promise.resolve(); await Promise.resolve();
    expect(listener).not.toHaveBeenCalled(); expect(source.getSnapshot()).toEqual({});
  } finally { await f.close(); }
});

it('production definition keeps real human append identity and declines machine or replacement messages', () => {
  const event = { type: 'user/message', seq: 4, time: 1, surfaceOp: 'append', data: { id: 'input', source: { kind: 'user' } } };
  expect(supergroupMessageDefinition.match(event as never)).toEqual({ id: 'input', role: 'start' });
  expect(supergroupMessageDefinition.match({ ...event, data: { ...event.data, source: { kind: 'dsh-bot-group' } } } as never)).toBeNull();
  expect(supergroupMessageDefinition.match({ ...event, surfaceOp: 'replace' } as never)).toBeNull();
});


it('stops the exact displayed work with a fresh revision rather than the stale card revision', async () => {
  const f = await fixture();
  try {
    await f.render();
    await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work="work-1"]')).toBeTruthy());
    const fresh = workView(); fresh.work.revision = 12;
    f.remote.forSession.mockResolvedValue({ ok: true, value: fresh });
    await click(button(f.element, f.t('supergroup.stop')));
    expect(f.remote.forSession).toHaveBeenCalledWith({ sessionId: 'origin', messageId: 'input' });
    expect(f.remote.cancel).toHaveBeenCalledExactlyOnceWith({ workId: 'work-1', expectedRevision: 12 });
    expect(f.element.querySelector('textarea')?.value).toBe('Keep native draft');
  } finally { await f.close(); }
});

it('re-reads once after a native CAS conflict and cancels only the same work at its new revision', async () => {
  const f = await fixture();
  try {
    const first = workView(), next = workView(); first.work.revision = 8; next.work.revision = 9;
    f.remote.forSession.mockResolvedValueOnce({ ok: true, value: first }).mockResolvedValueOnce({ ok: true, value: next });
    f.remote.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'dsh-bot/conflict', message: 'stale' } as never });
    await f.bridge.cancel(workView().work);
    expect(f.remote.forSession).toHaveBeenCalledTimes(2);
    expect(f.remote.cancel.mock.calls).toEqual([[{ workId: 'work-1', expectedRevision: 8 }], [{ workId: 'work-1', expectedRevision: 9 }]]);
  } finally { await f.close(); }
});

it.each(['completed', 'partial', 'cancelled', 'unknown'] as const)('does not cancel a work that became %s before the click', async state => {
  const f = await fixture();
  try {
    const latest = workView(); latest.work.state = state; latest.work.revision = 10;
    f.remote.forSession.mockResolvedValue({ ok: true, value: latest });
    await f.bridge.cancel(workView().work);
    expect(f.remote.cancel).not.toHaveBeenCalled();
    f.remote.forSession.mockClear(); await f.bridge.cancel(latest.work);
    expect(f.remote.forSession).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(['work', 'owner-generation', 'group-generation', 'origin', 'input', 'view-group'] as const)('refuses changed %s identity without cancelling anything', async field => {
  const f = await fixture();
  try {
    const wrong = workView();
    if (field === 'work') wrong.work.id = 'another-work';
    if (field === 'owner-generation') wrong.work.owner.botCreatedAt++;
    if (field === 'group-generation') wrong.work.group!.groupCreatedAt++;
    if (field === 'origin') wrong.work.originSessionId = 'another-origin';
    if (field === 'input') wrong.work.inputMessageId = 'another-input';
    if (field === 'view-group') wrong.group!.group.createdAt++;
    f.remote.forSession.mockResolvedValue({ ok: true, value: wrong });
    await expect(f.bridge.cancel(workView().work)).rejects.toThrow('identity mismatch');
    expect(f.remote.cancel).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('does not retry a transport failure or a second CAS conflict', async () => {
  const f = await fixture();
  try {
    f.remote.cancel.mockRejectedValueOnce(new Error('disconnected'));
    await expect(f.bridge.cancel(workView().work)).rejects.toThrow('disconnected');
    expect(f.remote.cancel).toHaveBeenCalledTimes(1);
    f.remote.cancel.mockClear(); f.remote.forSession.mockClear();
    f.remote.cancel.mockResolvedValue({ ok: false, error: { code: 'dsh-bot/conflict', message: 'stale' } as never });
    await expect(f.bridge.cancel(workView().work)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    expect(f.remote.cancel).toHaveBeenCalledTimes(2); expect(f.remote.forSession).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});
