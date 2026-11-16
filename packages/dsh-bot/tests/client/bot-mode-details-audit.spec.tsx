// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import * as client from '../../src/client/index.js';
import { bot, botModeCapabilities, click, mountClient } from './helpers.js';
import { configure as configureGroup, bots as memberBots } from './group-fixture.js';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import en from '../../locale/en.json';

/** Client/DOM contract evidence only; native layout and keyboard traversal need
 * the root task's browser verification. No Host/model session is started. */
async function fixture(group = false) {
  const plugin: typeof client = { ...client, async apply(ctx, options) {
    ctx.effect(() => ctx.provide('shortcuts', { ...botModeCapabilities,
      registerCommandMode: () => ({ ready: Promise.resolve(), dispose() {} }),
    } as never));
    await client.apply(ctx, options);
  } };
  const app = await mountClient([bot(), ...(group ? memberBots : [])], 'en', remote => {
    remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha-bot', mainSessionId: 'verified-main', preset: { state: 'ok' } }];
    if (group) {
      configureGroup(remote);
      const data = remote.data.groupView!;
      data.messages[0]!.attachments = [{ type: 'file', attachment: { attachmentId: 'file:one', name: 'report.txt', bytes: 4 } }];
      data.deliveries = [{ id: 'delivery:one', turnId: data.messages[0]!.turnId, memberId: data.members[1]!.id,
        ordinal: 0, bot: data.members[1]!.bot, botRevision: 1, presetId: 'beta-preset', contextOutputMessageIds: [],
        contextTruncated: false, state: 'completed', outputMessageId: data.messages[0]!.id }];
    }
  }, {}, plugin);
  const settings = await app.mountEntry('plugins.bundle.config', options => options.key === 'dsh-botgroup', { view: 'page' });
  const toggle = settings.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  await click(toggle);
  const main = await app.mountEntry('main.conversation', options => options.priority === -100, {
    sessionId: group ? 'group-root-one' : 'verified-main', useSession: () => ({ openState: 'open' }), renderFactorySlot: () => <div data-native-conversation="" />,
  });
  await vi.waitFor(() => expect(main.container.querySelector('[data-bot-mode-details]')).not.toBeNull());
  return { app, main, async close() { await main.unmount(); await settings.unmount(); await app.dispose(); } };
}

it('keeps Advanced summary reachable before wrapping narrow details keyboard focus', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const f = await fixture();
  try {
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    const surface = f.main.container.querySelector<HTMLElement>('.dsh-bot-mode-detail-surface')!;
    const summary = surface.querySelector<HTMLElement>('[data-bot-mode-advanced] summary')!;
    const memory = [...surface.querySelectorAll<HTMLButtonElement>('.dsh-bot-mode-action')].at(-1)!;
    expect(summary).not.toBeNull();
    memory.focus();
    const next = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => { memory.dispatchEvent(next); });
    // Summary follows Memory in document order, so this is not the wrap point.
    expect(next.defaultPrevented).toBe(false);
    summary.focus();
    const wrap = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => { summary.dispatchEvent(wrap); });
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(surface.querySelector('button'));
  } finally {
    await f.close();
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else Reflect.deleteProperty(window, 'matchMedia');
  }
});

it.each(['refused', 'transport'] as const)('reports %s attachment open failures and permits retry without duplicate pending opens', async failure => {
  const f = await fixture(true);
  try {
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="materials"]')!);
    const attachment = () => [...f.main.container.querySelectorAll<HTMLButtonElement>('.dsh-bot-mode-materials button')].find(button => button.textContent === 'report.txt')!;
    await vi.waitFor(() => expect(attachment()).toBeTruthy());
    const remote = f.app.remote.groups.openAttachment;
    if (failure === 'refused') remote.mockResolvedValueOnce({ ok: false, error: { code: 'missing', message: 'Attachment unavailable' } } as never);
    else remote.mockRejectedValueOnce(new Error('Disconnected'));
    await click(attachment());
    await vi.waitFor(() => expect(f.main.container.querySelector('[role="alert"]')?.textContent).toContain(en.ui['groups.attachmentUnavailable']));
    let resolve!: (value: { ok: true; value: { opened: true } }) => void;
    remote.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    await click(attachment());
    expect(attachment().disabled).toBe(true);
    await click(attachment());
    expect(remote).toHaveBeenCalledTimes(2);
    await act(async () => { resolve({ ok: true, value: { opened: true } }); });
    expect(attachment().disabled).toBe(false);
    expect(f.main.container.querySelector('[role="alert"]')).toBeNull();
  } finally { await f.close(); }
});

it('reports a result navigation refusal without an unhandled rejection', async () => {
  const f = await fixture(true);
  try {
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="materials"]')!);
    const result = () => [...f.main.container.querySelectorAll<HTMLButtonElement>('.dsh-bot-mode-materials button')].find(button => button.textContent?.includes('Original beta'))!;
    await vi.waitFor(() => expect(result()).toBeTruthy());
    f.app.remote.groups.open.mockResolvedValueOnce({ ok: false, error: { code: 'missing', message: 'Result unavailable' } } as never);
    await click(result());
    await vi.waitFor(() => expect(f.main.container.querySelector('[role="alert"]')?.textContent).toContain(en.ui['activity.openError']));
    expect(f.app.openSession).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('labels group member navigation as opening a conversation in Bot mode', async () => {
  const f = await fixture(true);
  try {
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="members"]')!);
    const member = () => f.main.container.querySelector<HTMLButtonElement>('[data-group-member="member:alpha"] button')!;
    await vi.waitFor(() => expect(member()).toBeTruthy());
    const label = `${memberBots[0]!.name} · ${en.ui['chat.openChat']}`;
    expect(member().getAttribute('aria-label')).toBe(label);
    expect(member().title).toBe(label);
    await click(member());
    expect(f.app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith(memberBots[0]!.id);
    expect(f.app.openSession).toHaveBeenCalledWith('test-created-session');
    expect(f.main.container.querySelector('.dsh-bot-mode-detail-surface')).toBeNull();
  } finally { await f.close(); }
});

it('retains cached materials after a disconnected refresh and exposes an explicit retry', async () => {
  const f = await fixture(true);
  try {
    const groups = (f.app.main.inject!() as unknown as BotsPageInjected).groups!;
    const createView = groups.createView;
    let store: ReturnType<GroupActions['createView']> | undefined;
    vi.spyOn(groups, 'createView').mockImplementation(key => { store = createView(key); return store; });
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="materials"]')!);
    await vi.waitFor(() => expect(f.main.container.querySelector('.dsh-bot-mode-materials')?.textContent).toContain('report.txt'));
    f.app.remote.groups.view.mockRejectedValueOnce(new Error('Disconnected'));
    await act(async () => { await store!.refresh(); });
    const alert = f.main.container.querySelector('[role="alert"]')!;
    expect(alert?.textContent).toContain(en.ui['groups.disconnected']);
    expect(f.main.container.querySelector('.dsh-bot-mode-materials')?.textContent).toContain('report.txt');
    await click(alert.querySelector('button')!);
    expect(f.main.container.querySelector('[role="alert"]')).toBeNull();
  } finally { await f.close(); }
});

it('closes narrow details with Escape and releases native content inertness', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const f = await fixture();
  try {
    const opener = f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!;
    await click(opener);
    const surface = f.main.container.querySelector<HTMLElement>('.dsh-bot-mode-detail-surface')!;
    const native = f.main.container.querySelector<HTMLElement>('.dsh-bot-mode-conversation')!;
    expect(native.inert).toBe(true);
    await act(async () => { surface.querySelector('button')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(f.main.container.querySelector('.dsh-bot-mode-detail-surface')).toBeNull();
    expect(native.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  } finally {
    await f.close();
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else Reflect.deleteProperty(window, 'matchMedia');
  }
});

it('opens group settings and follow-up inside Bot mode without navigating to another management page', async () => {
  const f = await fixture(true);
  try {
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-details]')!);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="settings"]')!);
    await vi.waitFor(() => expect(f.main.container.querySelector('[data-group-overview="group:one"]')).not.toBeNull());
    expect(f.main.container.textContent).toContain(en.ui['teams.onDemand']);
    expect(f.main.container.textContent).toContain(en.ui['teams.title']);
    expect(f.main.container.querySelector('[data-group-overview] details')?.hasAttribute('open')).toBe(false);
    await click(f.main.container.querySelector<HTMLButtonElement>('[data-bot-mode-tab="tasks"]')!);
    await vi.waitFor(() => expect(f.main.container.querySelector('[data-follow-up="detail"]')).not.toBeNull());
    expect(f.app.openSession).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
