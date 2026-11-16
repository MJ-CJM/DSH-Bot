// @vitest-environment jsdom
import { act, useSyncExternalStore, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import * as client from '../../src/client/index.js';
import { bot, botModeCapabilities, click, mountClient } from './helpers.js';
import en from '../../locale/en.json';

it('switches from the normal footer into the owned Bot sidebar and back, cleaning owned slots across actual seat unmounts', async () => {
  const releaseMode = vi.fn(async () => {});
  const registerMode = vi.fn(() => ({ ready: Promise.resolve(), dispose: releaseMode }));
  const plugin: typeof client = { ...client, async apply(ctx, options) {
    ctx.effect(() => ctx.provide('shortcuts', { ...botModeCapabilities, registerCommandMode: registerMode } as never));
    await client.apply(ctx, options);
  } };
  const app = await mountClient([bot()], 'en', undefined, {}, plugin);
  const element = document.createElement('div'); document.body.append(element); const seat = createRoot(element);
  const t = app.ctx.locale.bind('dsh-bot');
  // Model public single-slot ownership: an installed Bot/guard sidebar replaces
  // the normal sidebar and unmounts its footer while configure is still settling.
  // This is a lifecycle integration fixture, not native layout/portal evidence.
  const renderSeat = () => {
    const entry = app.core.entries('sidebar')[0]
      ?? app.core.entries('sidebar.footer.action').find(row => row.options.id === 'dsh-bot-sessions');
    if (!entry) { seat.render(null); return; }
    const Component = entry.component as ComponentType<Record<string, unknown>>;
    const { hooks, ...injected } = entry.inject?.() ?? {};
    const bound: Record<string, unknown> = {};
    for (const [name, source] of Object.entries(hooks as Record<string, { subscribe(listener: () => void): () => void; getSnapshot(): unknown }> ?? {})) {
      bound[`use${name[0]?.toUpperCase()}${name.slice(1)}`] = (select = (value: unknown) => value) => select(useSyncExternalStore(source.subscribe, source.getSnapshot));
    }
    seat.render(<Component collapsed={false} width={266} wide useSessions={() => ({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })} {...injected} {...bound} t={t} />);
  };
  const offSidebar = app.core.subscribe('sidebar', renderSeat);
  const offFooter = app.core.subscribe('sidebar.footer.action', renderSeat);
  const anchor = () => element.querySelector<HTMLButtonElement>('[data-bot-mode-switch-button]')!;
  const item = (label: string) => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent === label)!;
  const owner = app.ctx.get('remote.dshBotSupergroup')!;
  try {
    await act(async () => renderSeat());
    await vi.waitFor(() => expect(anchor().textContent).toContain(en.ui['botMode.standardMode']));
    expect(element.querySelector('[data-bot-mode-sidebar]')).toBeNull();
    expect(app.core.entries('sidebar.footer.action')).toHaveLength(1);
    expect(element.querySelector('.dsh-bot-mode')).toBeNull();
    expect(app.core.entries('sidebar.footer.action').filter(row => row.options.id === 'dsh-bot-sessions')).toHaveLength(1);

    await click(anchor());
    await click(item(en.ui['sidebar.sessions']));
    expect(element.querySelector('dialog')?.getAttribute('aria-label')).toBe(en.ui['sidebar.sessions']);
    expect(owner.configure).not.toHaveBeenCalled();
    await click([...element.querySelectorAll<HTMLButtonElement>('dialog button')].find(node => node.textContent === en.ui['actions.close'])!);
    await click(anchor());
    await click(item(en.ui['botMode.botMode']));
    await vi.waitFor(() => expect(element.querySelector('[data-bot-mode-sidebar] footer [data-bot-mode-switch-button]')?.textContent).toContain(en.ui['botMode.botMode']));
    expect(element.querySelectorAll('[data-bot-mode-switch-button]')).toHaveLength(1);
    expect(owner.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedEnabled: false });
    expect(registerMode).toHaveBeenCalledTimes(1);
    expect(app.core.entries('main.conversation').some(row => row.options.priority === -100)).toBe(true);
    expect(app.core.entries('shell.leading').some(row => row.options.priority === -100)).toBe(true);

    await click(anchor());
    expect(element.textContent).toContain(en.ui['botMode.switchScope']);
    await click(item(en.ui['botMode.standardMode']));
    await vi.waitFor(() => expect(anchor().textContent).toContain(en.ui['botMode.standardMode']));
    expect(element.querySelector('[data-bot-mode-sidebar]')).toBeNull();
    expect(element.querySelectorAll('[data-bot-mode-switch-button]')).toHaveLength(1);
    expect(owner.configure).toHaveBeenCalledTimes(2);
    expect(owner.configure).toHaveBeenLastCalledWith({ enabled: false, expectedEnabled: true });
    expect(releaseMode).toHaveBeenCalledTimes(1);
    expect(app.core.entries('sidebar')).toHaveLength(0);
    expect(app.core.entries('main.conversation')).toHaveLength(0);
    expect(app.core.entries('shell.leading')).toHaveLength(0);
    expect(app.core.entries('conversation.composer.dock').filter(row => row.options.id === 'dsh-bot-mode-floor')).toHaveLength(0);
    expect(app.core.entries('sidebar.footer.action').filter(row => row.options.id === 'dsh-bot-sessions')).toHaveLength(1);
  } finally {
    offSidebar(); offFooter();
    await act(async () => seat.unmount()); element.remove(); await app.dispose();
  }
});
