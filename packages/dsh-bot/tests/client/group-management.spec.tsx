// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupDelivery, GroupMessage, GroupTurn } from '../../src/shared/groups.js';
import type { ExecutionBridge } from '../../src/client/group-execution.js';
import { GroupStatsSource } from '../../src/client/group-statistics.js';
import type { BotRecord } from '../../src/shared/schema.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { filterGroupDirectory, groupMemberModel } from '../../src/client/group-management.js';
import { GroupDirectory } from '../../src/client/components/GroupDirectory.js';
import { GroupActivityView, GroupMembersView, GroupOverview } from '../../src/client/components/GroupOverview.js';
import { bots, summary, view } from './group-fixture.js';
import { button, click, fill } from './helpers.js';
import en from '../../locale/en.json';

const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => en.ui[key]
  .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];

describe('group directory', () => {
  it('filters and searches without fetching group views', () => {
    const running = summary();
    const archived = summary();
    archived.group = { ...archived.group, id: 'group:archived', name: 'Archived release', archived: true };
    archived.unread = true;
    const rows = filterGroupDirectory([archived, running], '', 'archived');
    expect(rows.map(row => row.group.id)).toEqual(['group:archived']);
    expect(filterGroupDirectory([archived, running], 'synthetic', 'all').map(row => row.group.id)).toEqual(['group:one']);
    expect(filterGroupDirectory([archived, running], '', 'unread').map(row => row.group.id)).toEqual([]);
  });

  it('renders search, filters and a combined member avatar', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const element = document.createElement('div'), root = createRoot(element);
    try {
      await act(async () => root.render(<GroupDirectory rows={[summary()]} bots={bots} onSelect={() => {}} onCreate={() => {}} onRefresh={() => {}} t={t} />));
      expect(element.querySelector('[data-group-avatar="members"]')?.getAttribute('data-group-avatar-count')).toBe('2');
      expect(element.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
      await click(button(element, en.ui['groups.filter']));
      await click(button(element, en.ui['groups.filter.archived']));
      expect(element.textContent).toContain(en.ui['groups.noMatches']);
      await click(button(element, en.ui['groups.clearFilters']));
      await fill(element.querySelector('input[type="search"]') as HTMLInputElement, 'missing');
      expect(element.textContent).toContain(en.ui['groups.noMatches']);
      await click(button(element, en.ui['groups.clearFilters']));
      expect(element.querySelector('[data-group-directory-row="group:one"]')).toBeTruthy();
    } finally { await act(async () => root.unmount()); }
  });
});

describe('group overview', () => {
  it('resolves member, group, Bot and DSH model precedence', () => {
    const data = view();
    const [alpha, beta] = data.members;
    data.group.modelSelection = { provider: 'group-provider', model: 'group-model' };
    data.group.memberModelSelections = [{ memberId: alpha?.id ?? '', modelSelection: { provider: 'member-provider', model: 'member-model' } }];
    expect(groupMemberModel(data.group, alpha as NonNullable<typeof alpha>, bots[0]).source).toBe('groups.modelSourceMember');
    expect(groupMemberModel(data.group, beta as NonNullable<typeof beta>, bots[1]).source).toBe('groups.modelSourceGroup');
    delete data.group.modelSelection;
    delete data.group.memberModelSelections;
    expect(groupMemberModel(data.group, alpha as NonNullable<typeof alpha>, { ...bots[0], model: { provider: 'bot-provider', model: 'bot-model' } } as BotRecord).source).toBe('groups.modelSourceBot');
    expect(groupMemberModel(data.group, alpha as NonNullable<typeof alpha>, bots[0]).source).toBe('groups.modelSourceDsh');
  });

  it('shows real member state and opens an activity run by turn id', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const data = view();
    const key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
    const turn: GroupTurn = { id: 'turn:one', group: key, operationId: 'op:one', requestDigest: 'digest', inputMessageId: 'question:one',
      createdAt: 1, updatedAt: 1, revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: ['member:alpha'], mode: 'natural', contextThroughSeq: 1, state: 'partial' };
    data.turns = [turn];
    data.deliveries = [{ id: 'delivery:one', turnId: turn.id, memberId: 'member:alpha', ordinal: 0,
      bot: { botId: 'alpha', botCreatedAt: bots[0]?.createdAt ?? 1 }, botRevision: 1, presetId: 'bot-alpha', contextOutputMessageIds: [], contextTruncated: false,
      state: 'failed', childSessionId: 'child:one', failure: { code: 'QUOTA', message: 'quota exhausted' } }];
    data.messages = [{ id: 'question:one', seq: 1, at: 1, text: 'Compare the options', turnId: turn.id, authorKind: 'user' }];
    data.group.memberModelSelections = [{ memberId: 'member:alpha', modelSelection: { provider: 'member-provider', model: 'member-model' } }];
    const remote = { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary()] }) } as unknown as GroupMethods;
    const ctx = new Context(); ctx.provide('remote.dshBot.groups', remote);
    const actions = createGroupActions(ctx, {}), onOpenRun = vi.fn();
    const element = document.createElement('div'), root = createRoot(element);
    try {
      await act(async () => root.render(<GroupOverview summary={summary()} actions={actions} bots={bots} onEdit={() => {}} onOpenRun={onOpenRun} t={t} />));
      await vi.waitFor(() => expect(element.textContent).toContain('member-provider / member-model'));
      expect(element.textContent).toContain(en.ui['groups.failed']);
      await click(button(element, en.ui['groups.view.activity']));
      expect(element.textContent).toContain('Compare the options');
      expect(element.textContent).toContain(en.ui['groups.failure.quota']);
      await click(button(element, en.ui['groups.viewRun']));
      expect(onOpenRun).toHaveBeenCalledWith(data, 'turn:one');
      await click(button(element, en.ui['groups.view.settings']));
      expect(element.querySelector('[data-path-label]')?.textContent).toBe('/synthetic');
    } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); }
  });
});


it('opens image attachments in the native lightbox without calling the generic attachment action', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { GroupMessageCard } = await import('../../src/client/components/GroupTimeline.js');
  const element = document.createElement('div'), root = createRoot(element);
  const onPreviewAttachment = vi.fn(async () => 'blob:native-preview');
  const onOpenAttachment = vi.fn(async () => {});
  const attachment = { type: 'image' as const, attachment: { attachmentId: 'image:one', mediaType: 'image/png' as const,
    bytes: 3, width: 10, height: 10, name: 'diagram.png' } };
  const message = { ...view().messages[0], id: 'message:image', attachments: [attachment] } as GroupMessage;
  try {
    await act(async () => root.render(<GroupMessageCard message={message}
      labels={{ code: { copyLabel: 'copy', copiedLabel: 'copied' }, footnotes: 'footnotes' }}
      onReply={() => {}} onOpenSession={async () => {}} onOpenAttachment={onOpenAttachment}
      onPreviewAttachment={onPreviewAttachment} t={t} />));
    await click(button(element, en.ui['groups.openAttachment'].replace('{name}', 'diagram.png')));
    await vi.waitFor(() => expect(element.querySelector('[role="dialog"]')).toBeTruthy());
    expect(onPreviewAttachment).toHaveBeenCalledWith('message:image', attachment.attachment);
    expect(onOpenAttachment).not.toHaveBeenCalled();
    expect(element.querySelector('img')?.getAttribute('src')).toBe('blob:native-preview');
    await click(button(element, en.ui['actions.close']));
    expect(element.querySelector('[role="dialog"]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

function managementData(count = 1) {
  const data = view();
  data.messages = [];
  for (let index = 0; index < count; index++) {
    const id = `turn:${index}`;
    data.turns.push({ id, group: { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
      operationId: `op:${index}`, requestDigest: 'digest', inputMessageId: `question:${index}`, createdAt: index + 1, updatedAt: index + 1,
      revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: ['member:alpha'], mode: 'natural', contextThroughSeq: index + 1, state: 'completed' });
    data.messages.push({ id: `question:${index}`, seq: index + 1, at: index + 1, text: `Question ${index}`, turnId: id, authorKind: 'user' });
    data.deliveries.push({ id: `delivery:${index}`, turnId: id, memberId: 'member:alpha', ordinal: 0,
      bot: { botId: 'alpha', botCreatedAt: bots[0]?.createdAt ?? 1 }, botRevision: 1, presetId: 'bot-alpha', contextOutputMessageIds: [], contextTruncated: false,
      state: 'completed', childSessionId: `child:${index}` });
  }
  return data;
}

it('focuses older runs and their statistics, respects manual scopes, and releases hidden statistics', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = managementData(12);
  let leases = 0;
  const binding = { session: { getSnapshot: () => ({ openState: 'ready' }), subscribe: () => () => {},
    projections: { faceOf: () => ({ subscribe: () => () => {}, getSnapshot: () => undefined }) } } } as unknown as SessionBinding;
  const statistics = new GroupStatsSource(() => ({ retain: () => {
    leases++;
    return { binding, ready: Promise.resolve(binding), release: () => { leases--; } };
  } }) as unknown as ISessions);
  const source = vi.spyOn(statistics, 'source');
  const bridge = { ctx: { get: () => undefined }, statistics } as unknown as ExecutionBridge;
  const actions = {} as ReturnType<typeof createGroupActions>;
  const element = document.createElement('div'), root = createRoot(element);
  const scroll = vi.fn();
  const render = async (sequence: number, active = true) => act(async () => root.render(<GroupActivityView
    view={{ ...data }} bots={bots} actions={actions} executionBridge={bridge} active={active}
    focusRequest={{ turnId: 'turn:0', sequence }} t={t} />));
  try {
    await render(1);
    expect(element.querySelector('[data-group-activity="turn:0"]')?.getAttribute('data-focused')).toBe('true');
    expect(element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('turn:0');
    expect(source.mock.calls.map(call => call[1])).toEqual(['child:0']);
    expect(leases).toBe(1);
    const target = element.querySelector('[data-group-activity="turn:0"]') as HTMLElement;
    target.scrollIntoView = scroll;
    await click(element.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement);
    await click(element.querySelector('[data-statistics-question="turn:11"]')?.closest('button') as HTMLButtonElement);
    expect(element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('turn:11');
    await render(1);
    expect(element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('turn:11');
    expect(scroll).not.toHaveBeenCalled();
    await render(1, false);
    expect(leases).toBe(0);
    await render(1);
    expect(element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('turn:11');
    await click(element.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement);
    await click(element.querySelector('[data-statistics-scope="group"]')?.closest('button') as HTMLButtonElement);
    expect(element.querySelector('[data-statistics-scope="group"]')).toBeTruthy();
    await render(2);
    expect(element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('turn:0');
    expect(scroll).toHaveBeenCalledTimes(2); // returning to the section, then explicit repeat navigation
  } finally { await act(async () => root.unmount()); statistics.dispose(); }
  expect(leases).toBe(0);
});

it('offers editing in headerless settings and prevents editing archived groups', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = managementData(), onEdit = vi.fn(), ctx = new Context();
  ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }) } as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {}), element = document.createElement('div'), root = createRoot(element);
  try {
    await act(async () => root.render(<GroupOverview summary={summary()} actions={actions} bots={bots}
      showHeader={false} section="settings" onEdit={onEdit} t={t} />));
    await click(button(element, en.ui['groups.edit']));
    expect(onEdit).toHaveBeenCalledWith(data);
    data.group.archived = true;
    await act(async () => root.render(<GroupOverview key="archived" summary={summary()} actions={actions} bots={bots}
      showHeader={false} section="settings" onEdit={onEdit} t={t} />));
    expect(button(element, en.ui['groups.edit']).disabled).toBe(true);
  } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); }
});

it('labels missing or attachment-only questions without IDs and resolves a paged question only when asked', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = managementData(), historical = data.messages[0] as GroupMessage;
  historical.text = 'Full original question\nIncluding the second line';
  data.messages = [{ ...historical, id: 'newer', seq: 2, text: 'Newer reply' }]; data.hasEarlier = true;
  const remoteView = vi.fn(async (_key: unknown, page: { beforeSeq?: number }) => ({ ok: true, value:
    page.beforeSeq ? { ...data, hasEarlier: false, messages: [historical] } : data }));
  const ctx = new Context(); ctx.provide('remote.dshBot.groups', { view: remoteView } as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {}), onAskBot = vi.fn(), element = document.createElement('div'), root = createRoot(element);
  try {
    await act(async () => root.render(<GroupActivityView view={data} bots={bots} actions={actions} t={t} />));
    expect(element.textContent).toContain(en.ui['statistics.historical']);
    expect(element.textContent).not.toContain(historical.id);
    expect(remoteView).not.toHaveBeenCalled();
    await act(async () => root.render(<GroupMembersView view={data} bots={bots} actions={actions} onAskBot={onAskBot} t={t} />));
    expect(remoteView).not.toHaveBeenCalled();
    await click(element.querySelector('[data-group-member] button') as HTMLButtonElement);
    await click(button(element, en.ui['groups.askInChat']));
    expect(remoteView.mock.calls.map(call => call[1])).toEqual([{}, { beforeSeq: 2 }]);
    expect(onAskBot).toHaveBeenCalledWith(bots[0], historical.text, expect.any(AbortSignal));
    data.messages = [{ ...historical, text: '', attachments: [{ type: 'image', attachment: { attachmentId: 'image:one', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'diagram.png' } }] }];
    await act(async () => root.render(<GroupActivityView view={data} bots={bots} actions={actions} t={t} />));
    expect(element.textContent).toContain(en.ui['groups.attachments']);
    expect(element.textContent).not.toContain(historical.id);
  } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); }
});

it('reports failed draft handoffs and discards historical lookups after leaving the group', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = managementData(), original = data.messages[0]; data.messages = [];
  const onAskBot = vi.fn(async () => { throw new Error('draft blocked'); });
  const lookup = vi.fn(async () => original);
  const actions = { quotedMessage: lookup } as unknown as ReturnType<typeof createGroupActions>;
  const element = document.createElement('div'), root = createRoot(element);
  const render = () => act(async () => root.render(<GroupMembersView view={data} bots={bots} actions={actions} onAskBot={onAskBot} t={t} />));
  try {
    await render();
    await click(element.querySelector('[data-group-member] button') as HTMLButtonElement);
    await click(button(element, en.ui['groups.askInChat']));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['groups.askFailed']);
    let resolve: (message: GroupMessage | undefined) => void = () => {};
    lookup.mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    await click(element.querySelector('[data-group-member] button') as HTMLButtonElement);
    await click(button(element, en.ui['groups.askInChat']));
    const signal = (lookup.mock.calls.at(-1) as unknown as [unknown, string, AbortSignal])[2];
    await act(async () => root.render(<GroupMembersView view={data} bots={bots} actions={actions}
      active={false} onAskBot={onAskBot} t={t} />));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(original));
    expect(onAskBot).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});

it('shows disabled members and queued or starting executions with the correct status', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = managementData(), element = document.createElement('div'), root = createRoot(element);
  try {
    for (const state of ['pending', 'starting'] as const) {
      (data.deliveries[0] as GroupDelivery).state = state;
      await act(async () => root.render(<GroupMembersView view={data} bots={bots} t={t} />));
      expect(element.querySelector('[data-state-dot]')?.getAttribute('data-state-dot')).toBe('ongoing');
    }
    if (data.members[0]) data.members[0].enabled = false;
    await act(async () => root.render(<GroupMembersView view={data} bots={bots} t={t} />));
    expect(element.textContent).toContain(en.ui['navigation.memberDisabled']);
    expect(element.querySelector('[data-state-dot]')?.getAttribute('data-state-dot')).toBe('idle');
  } finally { await act(async () => root.unmount()); }
});
