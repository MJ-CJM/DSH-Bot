// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ConversationSnapshot, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import { createSupergroupUiBridge, SupergroupWorkCard, supergroupMessageDefinition, supergroupNativeRevision } from '../../src/client/supergroup.js';
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

it('keeps native peer replies, hides their completed card, and preserves the controls for real group work', async () => {
  const f = await fixture('zh');
  try {
    // A support service is mounted by the production client, including when Supergroup is disabled.
    f.bridge.support = { actions: {} as NonNullable<typeof f.bridge.support>['actions'] };
    const { work } = workView();
    delete work.group;
    work.id = 'peer:synthetic';
    await f.update({ work });
    await vi.waitFor(() => expect(f.remote.forSession).toHaveBeenCalled());
    expect(f.element.querySelector('[data-supergroup-work]')).toBeNull();
    expect(f.element.querySelector('[data-task-support-entry]')).toBeNull();
    await f.update({ work: { ...work, state: 'completed' } });
    await vi.waitFor(() => expect(f.element.querySelector('[data-supergroup-work]')).toBeNull());
    expect(f.element.querySelector('[data-native-input]')).toBeTruthy();
    expect(f.element.querySelector('textarea')?.value).toBe('Keep native draft');
    await f.update({ work: { ...work, state: 'unknown', reason: 'receipt unavailable' } });
    await vi.waitFor(() => expect(f.element.textContent).toContain('receipt unavailable'));
    const group = workView();
    group.work.state = 'completed';
    await f.update(group);
    await vi.waitFor(() => expect(f.element.querySelector('[data-task-support-entry]')).toBeTruthy());
    expect(button(f.element, f.t('supergroup.viewDiscussion'))).toBeTruthy();
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

it('does not trigger repeated forSession RPCs or re-renders during streaming token updates in ordinary chats', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  const remote = {
    forSession: vi.fn(async () => ({ ok: true as const, value: null as SupergroupWorkView | null })),
    cancel: vi.fn(async () => ({ ok: true as const, value: null })),
    settings: vi.fn(async () => ({ ok: true as const, value: { enabled: false } })),
    configure: vi.fn(async () => ({ ok: true as const, value: { enabled: false } })),
  };
  ctx.provide('remote.dshBotSupergroup', remote);
  const groupRemote = {
    view: vi.fn(async () => ({ ok: true, value: view() })),
    list: vi.fn(async () => ({ ok: true, value: [] })),
    cancel: vi.fn(async () => ({ ok: true, value: true })),
  };
  ctx.provide('remote.dshBot.groups', groupRemote as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  const bridge = createSupergroupUiBridge(ctx, actions);
  const botSnapshot = { entries: bots.map(bot => ({ bot })) };
  const botSubscribe = vi.fn(() => () => {});
  const catalog = { subscribe: botSubscribe, getSnapshot: () => botSnapshot } as unknown as BotCatalog;
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];

  const makeTurn = (turn: number, status: 'open' | 'closed', endSeq?: number): TurnLocation => ({
    turn,
    start: { seq: turn * 10 } as TurnLocation['start'],
    end: endSeq === undefined ? undefined : ({ seq: endSeq } as TurnLocation['end']),
    status,
    steps: [{ turn, step: 1, start: undefined, end: undefined, status, data: {} as never }],
    data: {} as never,
  });
  let turns = new Map<number, TurnLocation>([
    [1, makeTurn(1, 'closed', 15)],
    [2, makeTurn(2, 'closed', 25)],
    [3, makeTurn(3, 'closed', 35)],
    [4, makeTurn(4, 'open')],
  ]);
  const makeSnapshot = (): ConversationSnapshot => ({
    activeTargets: new Set(['chat']),
    views: {
      get: (target: string) => (target === 'chat' ? ({ timeline: { turnOrder: [1, 2, 3, 4], turns } } as never) : undefined),
      grouped: () => undefined,
    },
  });
  let conversationSnapshot = makeSnapshot();
  const listeners = new Set<() => void>();
  const publishConversation = () => {
    conversationSnapshot = makeSnapshot();
    for (const listener of listeners) listener();
  };
  const useConversation = <T,>(selector: (snapshot: ConversationSnapshot) => T): T =>
    useSyncExternalStore(
      listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      () => selector(conversationSnapshot),
    );

  const nodes = [1, 2, 3, 4].map(turn => {
    const turnRecord = turns.get(turn);
    if (!turnRecord) throw new Error(`Missing turn ${turn}`);
    return {
      id: `msg-${turn}`,
      anchorSeq: turn * 10 + 1,
      location: { kind: 'turn' as const, turn: turnRecord },
    };
  }) as Array<Pick<ChatNode<'supergroup-work'>, 'id' | 'anchorSeq' | 'location'>>;

  const renders = new Map<string, number>();
  function StreamingSlotHost({ node }: { node: Pick<ChatNode<'supergroup-work'>, 'id' | 'anchorSeq' | 'location'> }) {
    const nativeRevision = useConversation(snapshot => supergroupNativeRevision(snapshot, node));
    renders.set(node.id, (renders.get(node.id) ?? 0) + 1);
    return <SupergroupWorkCard sessionId="ordinary-chat" messageId={node.id} bridge={bridge}
      actions={actions} bots={catalog} nativeRevision={nativeRevision} t={t} />;
  }

  const element = document.createElement('main');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(nodes.map(node => <StreamingSlotHost key={node.id} node={node} />));
    });
    await vi.waitFor(() => expect(remote.forSession).toHaveBeenCalledTimes(4));
    expect(botSubscribe).not.toHaveBeenCalled();

    const rendersAfterMount = new Map(renders);
    // Simulate 50 streaming token flushes creating new ConversationSnapshot references.
    await act(async () => {
      for (let token = 0; token < 50; token++) publishConversation();
    });
    await Promise.resolve();
    expect(remote.forSession).toHaveBeenCalledTimes(4);
    expect(renders).toEqual(rendersAfterMount);

    // Explicit refresh returning null again must not notify listeners (structuralEqual).
    const sourceListener = vi.fn();
    const offSource = bridge.source('ordinary-chat', 'msg-1').subscribe(sourceListener);
    await vi.waitFor(() => expect(remote.forSession).toHaveBeenCalledTimes(5));
    expect(sourceListener).not.toHaveBeenCalled();
    offSource();

    // Closing turn 4 refreshes only turn 4's message once, never prior closed turns 1-3.
    turns = new Map(turns);
    turns.set(4, makeTurn(4, 'closed', 49));
    await act(async () => { publishConversation(); });
    await vi.waitFor(() => expect(remote.forSession).toHaveBeenCalledTimes(6));
    expect(remote.forSession).toHaveBeenLastCalledWith({ sessionId: 'ordinary-chat', messageId: 'msg-4' });
  } finally {
    await act(async () => root.unmount());
    element.remove();
    await ctx.fiber.dispose();
  }
});
