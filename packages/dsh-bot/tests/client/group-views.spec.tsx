// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import type { GroupTurn } from '../../src/shared/groups.js';
import { GROUP_MANAGEMENT_VIEW } from '../../src/client/group-views.js';
import styles from '../../src/client/styles/groups.module.css';
import { bots, configure, summary, view } from './group-fixture.js';
import { button, click, field, fill, mountClient } from './helpers.js';
import en from '../../locale/en.json';

const rootA = 'group-root-one';
const rootB = 'group-root-two';
const ownedSession = (id: string, parentId?: string) => ({
  byId: { [id]: { id, parentId, retainedBy: { mainView: 1 } } } as unknown as SessionListState['byId'],
});

async function mountTwoGroups() {
  return mountClient(bots, 'en', remote => {
    configure(remote);
    const other = summary();
    remote.data.groups.push({ ...other, group: { ...other.group, id: 'group:two', rootSessionId: rootB } });
  }, {}, undefined, false, ownedSession(rootA));
}

it.each([
  ['group → group → original group', ownedSession(rootB), ownedSession(rootA)],
  ['group → ordinary session → original group', ownedSession('ordinary'), ownedSession(rootA)],
  ['group → group → transient child', ownedSession(rootB), ownedSession('child', rootA)],
  ['group → group → transient empty snapshot', ownedSession(rootB), { byId: {} }],
])('keeps the original view registration through %s before the timer settles', async (_name, intermediate, latest) => {
  const app = await mountTwoGroups();
  try {
    await vi.waitFor(() => expect(app.core.entries('conversation.view')).toHaveLength(1));
    const original = app.core.entries('conversation.view')[0];
    const onMutation = vi.fn();
    const unsubscribe = app.core.subscribe('conversation.view', onMutation);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.setSessions(intermediate);
      await app.setSessions(latest);
      await app.setSessions(latest);
      await vi.advanceTimersByTimeAsync(1);
      expect(app.core.entries('conversation.view')[0]).toBe(original);
      expect(onMutation).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); unsubscribe(); }
  } finally { await app.dispose(); }
});

it('settles on the latest group and only renders for its owning Session', async () => {
  const app = await mountTwoGroups();
  try {
    await vi.waitFor(() => expect(app.core.entries('conversation.view')).toHaveLength(1));
    const original = app.core.entries('conversation.view')[0];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.setSessions(ownedSession('ordinary'));
      await app.setSessions(ownedSession(rootB));
      await vi.advanceTimersByTimeAsync(1);
    } finally { vi.useRealTimers(); }
    expect(app.core.entries('conversation.view').map(entry => entry.options.id)).toEqual([GROUP_MANAGEMENT_VIEW]);
    expect(app.core.entries('conversation.view')[0]).not.toBe(original);
    const owner = { viewRequest: null, openView: vi.fn(), completeViewRequest: vi.fn() };
    const workspace = await app.mountEntry('conversation.view', options => options.id === GROUP_MANAGEMENT_VIEW, { ...owner, sessionId: rootA });
    try {
      expect(workspace.container.querySelector('[data-group-view]')).toBeNull();
      await workspace.rerender({ ...owner, sessionId: rootB });
      expect(workspace.container.querySelector('[data-group-view]')).not.toBeNull();
      expect(app.remote.groups.view).toHaveBeenCalledWith({ groupId: 'group:two', groupCreatedAt: 1 }, {});
    } finally { await workspace.unmount(); }
  } finally { await app.dispose(); }
});

it('does not register a deferred view after the plugin unloads', async () => {
  const app = await mountTwoGroups();
  try {
    await vi.waitFor(() => expect(app.core.entries('conversation.view')).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await app.setSessions(ownedSession(rootB));
      await app.unloadPlugin();
      await vi.advanceTimersByTimeAsync(1);
      expect(app.core.entries('conversation.view')).toHaveLength(0);
      expect(app.sessionListeners.size).toBe(0);
    } finally { vi.useRealTimers(); }
  } finally { await app.dispose(); }
});

it('confirms closing an edited group form in the conversation view', async () => {
  const app = await mountTwoGroups();
  try {
    await vi.waitFor(() => expect(app.core.entries('conversation.view')).toHaveLength(1));
    const workspace = await app.mountEntry('conversation.view', options => options.id === GROUP_MANAGEMENT_VIEW, {
      sessionId: rootA, viewRequest: null, openView: vi.fn(), completeViewRequest: vi.fn(),
    });
    try {
      const { container } = workspace;
      await click(button(container, en.ui['groups.view.settings']));
      await click(button(container, en.ui['groups.edit']));
      const editor = container.querySelector('form');
      if (!editor) throw new Error('Group editor is missing');
      const name = field(editor, en.ui['groups.name']);
      await fill(name, 'Edited group name');
      await click(button(editor, en.ui['groups.close']));
      expect(container.querySelector('dialog')?.getAttribute('aria-label')).toBe(en.ui['navigation.unsaved']);
      await click(button(container, en.ui['navigation.keepEditing']));
      expect(container.querySelector('dialog')).toBeNull();
      expect(name.value).toBe('Edited group name');
      await click(button(editor, en.ui['groups.close']));
      await click(button(container, en.ui['navigation.discardLeave']));
      expect(container.querySelector('form')).toBeNull();
      expect(app.remote.groups.edit).not.toHaveBeenCalled();
    } finally { await workspace.unmount(); }
  } finally { await app.dispose(); }
});

it('registers group views only for the active group root and focuses runs through the public owner', async () => {
  const rootId = 'group-root-one';
  const initialSessions = { byId: { [rootId]: { id: rootId, retainedBy: { mainView: 1 } } } } as unknown as SessionListState;
  const app = await mountClient(bots, 'en', remote => {
    configure(remote);
    const data = view();
    const turn: GroupTurn = { id: 'turn:one', group: { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
      operationId: 'op:one', requestDigest: 'digest', inputMessageId: 'question:one', createdAt: 1, updatedAt: 1,
      revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: ['member:alpha'], mode: 'natural', contextThroughSeq: 1, state: 'completed' };
    data.turns = [turn];
    data.messages = [{ id: 'question:one', seq: 1, at: 1, text: 'Run this question', turnId: turn.id, authorKind: 'user' }];
    remote.data.groupView = data;
  }, {}, undefined, false, initialSessions);
  try {
    await vi.waitFor(() => expect(app.core.entries('conversation.view').map(entry => entry.options.id)).toEqual([GROUP_MANAGEMENT_VIEW]));
    const openView = vi.fn(), completeViewRequest = vi.fn();
    const owner = { sessionId: rootId, openView, completeViewRequest };
    const runs = await app.mountEntry('conversation.view', options => options.id === GROUP_MANAGEMENT_VIEW, {
      ...owner, viewRequest: { view: GROUP_MANAGEMENT_VIEW, focus: 'turn:one' },
    });
    await vi.waitFor(() => expect(runs.container.textContent).toContain('Run this question'));
    const panel = runs.container.querySelector(`[data-group-view="${GROUP_MANAGEMENT_VIEW}"]`);
    expect(Array.from(panel?.classList ?? [])).toEqual(expect.arrayContaining([styles.panel, styles.managementPanel]));
    expect(panel?.querySelector('[data-group-statistics-bar]')).not.toBeNull();
    expect(runs.container.querySelector('[data-group-activity-focus]')?.getAttribute('data-group-activity-focus')).toBe('turn:one');
    expect(completeViewRequest).toHaveBeenCalledTimes(1);
    const activity = runs.container.querySelector<HTMLElement>('[data-group-activity="turn:one"]');
    if (!activity) throw new Error('Focused activity is missing');
    const scroll = vi.fn();
    activity.scrollIntoView = scroll;
    await runs.rerender({ ...owner, viewRequest: null });
    await click(button(runs.container, en.ui['groups.viewRun']));
    expect(openView).toHaveBeenCalledWith(GROUP_MANAGEMENT_VIEW, 'turn:one');
    expect(scroll).not.toHaveBeenCalled();
    await runs.rerender({ ...owner, viewRequest: { view: GROUP_MANAGEMENT_VIEW, focus: 'turn:one' } });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(completeViewRequest).toHaveBeenCalledTimes(2);
    await click(button(runs.container, en.ui['groups.view.settings']));
    const edit = button(runs.container, en.ui['groups.edit']);
    expect(edit.getAttribute('data-platform-variant')).toBe('outline');
    await click(edit);
    const editor = panel?.querySelector('form');
    if (!editor) throw new Error('Group editor is missing');
    expect(Array.from(editor.classList)).toContain(styles.editor);
    expect(editor.querySelector('input:not([type])')?.getAttribute('value')).toBe(view().group.name);
    await click(button(editor, en.ui['groups.close']));
    expect(panel?.querySelector('form')).toBeNull();
    expect(app.remote.groups.edit).not.toHaveBeenCalled();
    await runs.unmount();
    await app.setSessions({ byId: { normal: { id: 'normal', retainedBy: { mainView: 1 } } } } as unknown as SessionListState);
    await vi.waitFor(() => expect(app.core.entries('conversation.view')).toHaveLength(0));
  } finally { await app.dispose(); }
});

it('keeps native view IDs unique while pending and consumes requests in an active management view', async () => {
  const rootId = 'group-root-one';
  const initialSessions = { byId: { [rootId]: { id: rootId, retainedBy: { mainView: 1 } } } } as unknown as SessionListState;
  const app = await mountClient(bots, 'en', remote => {
    configure(remote);
    const data = view();
    data.turns = [{ id: 'turn:one', group: { groupId: data.group.id, groupCreatedAt: data.group.createdAt },
      operationId: 'op:one', requestDigest: 'digest', inputMessageId: 'question:one', createdAt: 1, updatedAt: 1,
      revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: ['member:alpha'], mode: 'natural', contextThroughSeq: 1, state: 'completed' }];
    data.messages = [{ id: 'question:one', seq: 1, at: 1, text: 'Directory run', turnId: 'turn:one', authorKind: 'user' }];
    remote.data.groupView = data;
  }, {}, undefined, false, initialSessions);
  const releaseChat = app.core.register({ name: 'conversation.view', id: 'chat', label: 'Chat' }, () => null);
  try {
    const page = app.main.inject?.() as unknown as BotsPageInjected;
    await act(async () => { await page.groups?.openRun({ groupId: 'group:one', groupCreatedAt: 1 }, 'turn:one'); });
    expect(app.openSession).toHaveBeenCalledWith(rootId);
    expect(page.groups?.runRequests.getSnapshot()?.turnId).toBe('turn:one');
    const ids = app.core.entries('conversation.view').map(entry => entry.options.id);
    expect(ids).toEqual(['chat', GROUP_MANAGEMENT_VIEW]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(app.core.entries('conversation.view').some(entry => entry.options.priority === -1000)).toBe(false);
    expect(app.core.entries('conversation.session.header.utilities').some(entry => entry.options.id === 'dsh-bot-group-run')).toBe(false);
    const runs = await app.mountEntry('conversation.view', options => options.id === GROUP_MANAGEMENT_VIEW, {
      sessionId: rootId, viewRequest: null, openView: vi.fn(), completeViewRequest: vi.fn(),
    });
    await vi.waitFor(() => expect(runs.container.querySelector('[data-group-activity-focus]')?.getAttribute('data-group-activity-focus')).toBe('turn:one'));
    expect(page.groups?.runRequests.getSnapshot()).toBeUndefined();
    await runs.unmount();
    await act(async () => { await page.groups?.openRun({ groupId: 'group:one', groupCreatedAt: 1 }, 'turn:one'); });
    const active = await app.mountEntry('conversation.view', options => options.id === GROUP_MANAGEMENT_VIEW, {
      sessionId: rootId, viewRequest: null, openView: vi.fn(), completeViewRequest: vi.fn(),
    });
    await vi.waitFor(() => expect(page.groups?.runRequests.getSnapshot()).toBeUndefined());
    expect(active.container.querySelector('[data-group-activity-focus]')?.getAttribute('data-group-activity-focus')).toBe('turn:one');
    expect(app.core.entries('conversation.view').map(entry => entry.options.id)).toEqual(['chat', GROUP_MANAGEMENT_VIEW]);
    await active.unmount();
  } finally { releaseChat(); await app.dispose(); }
});
