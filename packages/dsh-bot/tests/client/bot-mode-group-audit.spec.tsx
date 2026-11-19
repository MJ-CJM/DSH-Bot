// @vitest-environment jsdom
import { act, useSyncExternalStore, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import type { ComposerChainProps, ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { expect, it, vi } from 'vitest';
import { registerGroupExecution } from '../../src/client/group-execution.js';
import { selectGroupComposer } from '../../src/client/workspace-group.js';
import { GroupConversation } from '../../src/client/components/GroupsPanel.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { bots, view } from './group-fixture.js';
import { fill, click } from './helpers.js';
import en from '../../locale/en.json';

/** Real public registration/core; no native renderer or Host approval is mocked as runtime proof. */
async function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  const core = new SlotCore();
  const undeclare = core.register({ name: 'root', children: {
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: {
      hooks: { tabInfo: () => () => { throw new Error('This registration test does not mount native docking geometry'); } },
    } },
  } }, (() => null) as never);
  const blocks = new Map();
  const provide = [
    ctx.provide('slots', {
      inject: (_name: string, callback: () => () => void) => callback(), register: core.register.bind(core),
    } as never),
    ctx.provide('locale', { bind: () => (key: string) => key } as never),
    ctx.provide('sidebarRight', { openTab: vi.fn() } as never),
    ctx.provide('sidebarRightTabs', { register: () => () => {} } as never),
    ctx.provide('conversation', { blocks: { set: (id: string, value: unknown) => value === undefined ? blocks.delete(id) : blocks.set(id, value) } } as never),
  ];
  const bridge = registerGroupExecution(ctx);
  await vi.waitFor(() => expect(core.entries('dsh-bot.group.execution')).toHaveLength(1));
  const releaseReadOnly = bridge.retainReadOnly('child-exact' as never, 'Read only execution');
  return { core, bridge, blocks, async close() {
    releaseReadOnly(); await ctx.fiber.dispose(); for (const release of provide.reverse()) await release(); undeclare();
  } };
}

it('lets a real pending native interaction win while keeping ordinary child input suppressed', async () => {
  const f = await fixture();
  const nativePending = { kind: 'approval', key: 'approval-exact' };
  // The native ui-approval public registration is priority 1 in both supported
  // baselines. Its actual PendingApproval class/Remote waterfall is a runtime gate.
  const removeApproval = f.core.register({ name: 'conversation.composer', priority: 1,
    select: owner => (owner as ComposerChainProps).pendingInteraction === nativePending ? nativePending : null,
  }, (() => <button type="button">Native Reject</button>) as never);
  const elect = (pendingInteraction: unknown) => f.core.entries('conversation.composer').find(entry =>
    (entry.select as (owner: unknown) => unknown)({ sessionId: 'child-exact', pendingInteraction }) !== null);
  try {
    const ordinary = elect(undefined);
    expect(ordinary?.options.priority).toBe(-30);
    expect(f.blocks.has('child-exact')).toBe(true);
    expect(elect(nativePending)?.options.priority).toBe(1);
  } finally { removeApproval(); await f.close(); }
});

it('reacts to pending arrival and rejection without clearing the read-only block or mounting editable input', async () => {
  const f = await fixture();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  let pending: { kind: 'approval'; key: string } | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const publish = (next: typeof pending) => { pending = next; for (const listener of listeners) listener(); };
  const reject = vi.fn(() => publish(undefined));
  const removeApproval = f.core.register({ name: 'conversation.composer', priority: 1,
    select: owner => (owner as ComposerChainProps).pendingInteraction ?? null,
  }, (() => <button type="button" onClick={reject}>Native Reject</button>) as never);
  // ConversationContent's public owner contract is reactive: its subscribed
  // useSessionStatus provides pendingInteraction to the chain on every change.
  // Exercise our real registered selector, not a static read of Session status.
  function ContentOwner() {
    const pendingInteraction = useSyncExternalStore(subscribe, () => pending);
    const entry = f.core.entries('conversation.composer').find(row =>
      (row.select as (owner: unknown) => unknown)({ sessionId: 'child-exact', pendingInteraction }) !== null);
    const Elected = entry?.component as ComponentType | undefined;
    return Elected ? <Elected /> : <textarea data-editable-fallback="" />;
  }
  try {
    await act(async () => root.render(<ContentOwner />));
    expect(element.querySelector('textarea')).toBeNull();
    expect(element.querySelector('button')).toBeNull();
    await act(async () => publish({ kind: 'approval', key: 'exact-arrival' }));
    expect(element.querySelector('button')?.textContent).toBe('Native Reject');
    expect(element.querySelector('textarea')).toBeNull();
    expect(f.blocks.has('child-exact')).toBe(true);
    await act(async () => element.querySelector<HTMLButtonElement>('button')?.click());
    expect(reject).toHaveBeenCalledTimes(1);
    expect(element.querySelector('button')).toBeNull();
    expect(element.querySelector('textarea')).toBeNull();
    expect(f.blocks.has('child-exact')).toBe(true);
  } finally { await act(async () => root.unmount()); element.remove(); removeApproval(); await f.close(); }
  expect(listeners.size).toBe(0);
  expect(f.blocks.size).toBe(0);
});

it('renders the child Chat occurrence despite saved Trace without mutating that saved selection', async () => {
  const f = await fixture();
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const savedView = 'trace';
  const renderSession = vi.fn((_slot: string, owner: { view?: string }) => <div data-child-view={owner.view ?? savedView} />);
  const renderFactorySlot = vi.fn((_name: string, _owner: unknown, selection?: { slots: { views: ComponentType<ConversationViewsProps> } }) => {
    const Views = selection?.slots.views;
    return Views ? <Views {...{ renderSlot: renderSession } as ConversationViewsProps} /> : renderSession('conversation.session', {});
  });
  const Component = f.core.entries('dsh-bot.group.execution')[0]?.component as ComponentType<{ renderFactorySlot: typeof renderFactorySlot }>;
  try {
    await act(async () => root.render(<Component renderFactorySlot={renderFactorySlot} />));
    expect(element.querySelector('[data-child-view]')?.getAttribute('data-child-view')).toBe('chat');
    expect(renderSession).toHaveBeenLastCalledWith('conversation.session', { view: 'chat' });
    expect(savedView).toBe('trace');
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, { slots: { views: expect.any(Function) } });
  } finally { await act(async () => root.unmount()); element.remove(); await f.close(); }
});

async function groupFixture(automatic: boolean, commandMenu = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), data = view();
  data.group.mode = 'natural';
  if (automatic) {
    const owner = data.members[0]?.bot;
    if (!owner) throw new Error('Missing audit Bot');
    data.group.supergroup = { workId: 'audit-work', originSessionId: 'origin', originMessageId: 'origin-message', owner,
      readers: data.members.map(row => row.bot), expiresAt: Date.now() + 60_000 };
  }
  const send = vi.fn<GroupMethods['send']>();
  ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }),
    list: async () => ({ ok: true, value: [data] }), send } as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  actions.catalog.reset({ groups: [data] });
  const upload = vi.spyOn(actions, 'upload').mockImplementation(async (_sessionId, file) => ({ receiptId: 'audit-receipt', name: file.name, bytes: file.size }));
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => en.ui[key]
    .replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  let pending: { kind: 'approval'; key: string } | undefined;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const publish = (next: typeof pending) => { pending = next; for (const listener of listeners) listener(); };
  const reject = vi.fn(() => publish(undefined));
  const services = commandMenu ? { hostCommands: vi.fn(async () => new Set(['feedback'])), exportLog: () => false, feedback: () => true, installed: () => true } : undefined;
  function ContentOwner() {
    const pendingInteraction = useSyncExternalStore(subscribe, () => pending);
    const matched = selectGroupComposer({ sessionId: data.group.rootSessionId as never, pendingInteraction: pendingInteraction as never }, actions);
    return matched ? <GroupConversation workspace summary={data} actions={actions} bots={bots} commandServices={services}
      expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} /> :
      <button type="button" onClick={reject}>Native Reject</button>;
  }
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<ContentOwner />));
  await vi.waitFor(() => expect(element.querySelector('textarea')).not.toBeNull());
  return { element, actions, upload, send, data, publish, reject, t,
    async close() { await act(async () => root.unmount()); element.remove(); await ctx.fiber.dispose(); upload.mockRestore(); },
  };
}

it('lets a pending group-root native interaction take over and restores the exact unsent group draft after rejection', async () => {
  const f = await groupFixture(false);
  try {
    const initial = f.element.querySelector('textarea'); if (!initial) throw new Error('No group input');
    await fill(initial, 'Keep this unsent group text');
    await click(f.element.querySelector('[data-group-command-launcher]') as HTMLElement);
    await vi.waitFor(() => expect(f.element.querySelector('[data-group-command="memory"]')).not.toBeNull());
    await click(f.element.querySelector('[data-group-command="memory"]') as HTMLElement);
    const before = structuredClone(f.actions.draft(f.data.group.rootSessionId));
    await act(async () => f.publish({ kind: 'approval', key: 'root-approval' }));
    expect(f.element.querySelector('textarea')).toBeNull();
    expect(f.element.querySelector('button')?.textContent).toBe('Native Reject');
    expect(f.actions.draft(f.data.group.rootSessionId).text).toBe(before.text);
    expect(f.actions.draft(f.data.group.rootSessionId).memoryStatusOnly).toBe(true);
    await click(f.element.querySelector<HTMLButtonElement>('button') as HTMLButtonElement);
    await vi.waitFor(() => expect(f.element.querySelector('textarea')?.value).toBe(before.text));
    expect(f.element.querySelector('[data-group-memory-status]')).not.toBeNull();
    expect(f.reject).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.actions.draft(f.data.group.rootSessionId).operation).toEqual(before.operation);
  } finally { await f.close(); }
});

it.each([false, true])('file admission before upload matches manual/automatic group policy (automatic=%s)', async automatic => {
  const f = await groupFixture(automatic);
  try {
    const picker = f.element.querySelector<HTMLInputElement>('input[type="file"]'); if (!picker) throw new Error('No file input');
    expect(picker.disabled).toBe(automatic);
    await click(f.element.querySelector('[data-group-command-launcher]') as HTMLElement);
    await vi.waitFor(() => expect(Boolean(f.element.querySelector('[data-group-command="file"]'))).toBe(!automatic));
    await act(async () => f.element.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(f.element.textContent).not.toContain(f.t('botMode.inputUnsupported'));
    // Even an already queued/synthetic change must not make a receipt for an
    // automatic group. The ordinary group still uses the existing upload path.
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['text'], 'scope.txt', { type: 'text/plain' })] });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(f.upload).toHaveBeenCalledTimes(automatic ? 0 : 1);
    expect(f.actions.draft(f.data.group.rootSessionId).uploads).toHaveLength(automatic ? 0 : 1);
    expect(f.send).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each([false, true])('slash/plus command menu offers files only for a manual group (automatic=%s)', async automatic => {
  const f = await groupFixture(automatic, true);
  try {
    const input = f.element.querySelector('textarea'); if (!input) throw new Error('No group input');
    await fill(input, '/');
    await vi.waitFor(() => expect(f.element.querySelector('[data-group-command-menu]')).not.toBeNull());
    expect(Boolean(f.element.querySelector('[data-group-command="file"]'))).toBe(!automatic);
    expect(f.element.querySelector('[data-group-command="feedback"]')).not.toBeNull();
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await fill(input, '');
    const launcher = f.element.querySelector<HTMLButtonElement>('[data-group-command-launcher]'); if (!launcher) throw new Error('No plus command launcher');
    expect(launcher.getAttribute('aria-label')).toBe(f.t(automatic ? 'groups.commands' : 'groups.addOrCommand'));
    expect(launcher.title).toBe(f.t(automatic ? 'groups.commands' : 'groups.addOrCommand'));
    await click(launcher);
    await vi.waitFor(() => expect(f.element.querySelector('[data-group-command-menu]')).not.toBeNull());
    expect(Boolean(f.element.querySelector('[data-group-command="file"]'))).toBe(!automatic);
    expect(f.upload).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
