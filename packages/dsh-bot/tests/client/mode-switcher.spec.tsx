// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotModeActions } from '../../src/client/bot-mode/index.js';
import { ModeSwitcher, type ModeSwitcherProps } from '../../src/client/bot-mode/ModeSwitcher.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(language: 'en' | 'zh' = 'en', initial?: Promise<{ enabled: boolean }>, presentation: Pick<ModeSwitcherProps, 'onOpenChats' | 'unreadCount' | 'compact'> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let enabled = false;
  let snapshot: ReturnType<BotModeActions['status']['getSnapshot']> = { state: 'off' };
  const listeners = new Set<() => void>();
  const publish = (state: typeof snapshot['state']) => { snapshot = { state }; for (const listener of listeners) listener(); };
  const actions = {
    status: { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    settings: vi.fn(async () => ({ enabled })),
    configure: vi.fn(async (input: { enabled: boolean; expectedEnabled: boolean }) => {
      enabled = input.enabled; publish(enabled ? 'ready' : 'off'); return { enabled };
    }),
  } satisfies BotModeActions;
  if (initial) actions.settings.mockImplementationOnce(() => initial);
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => {
    let text: string = (language === 'en' ? en : zh).ui[key];
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value));
    return text;
  }) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<ModeSwitcher actions={actions} t={t} {...presentation} />));
  const anchor = () => element.querySelector<HTMLButtonElement>('[data-bot-mode-switch-button]')!;
  const item = (text: string) => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent === text)!;
  const click = async (node: HTMLButtonElement) => { await act(async () => node.click()); };
  return { actions, element, t, anchor, item, click, publish,
    setEnabled: (value: boolean) => { enabled = value; },
    open: async () => { if (anchor().getAttribute('aria-expanded') !== 'true') await click(anchor()); },
    close: async () => { await act(async () => root.unmount()); element.remove(); },
    listenerCount: () => listeners.size,
  };
}

it.each(['en', 'zh'] as const)('%s identifies the current mode and switches in either direction through exact owner CAS', async language => {
  const f = await fixture(language);
  try {
    expect(f.anchor().textContent).toContain(f.t('botMode.standardMode'));
    await f.open();
    expect(f.item(f.t('botMode.standardMode')).hasAttribute('data-menu-selected')).toBe(true);
    expect(f.element.textContent).toContain(f.t('botMode.switchScope'));
    await f.click(f.item(f.t('botMode.botMode')));
    expect(f.actions.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedEnabled: false });
    expect(f.anchor().textContent).toContain(f.t('botMode.botMode'));
    await f.open();
    expect(f.item(f.t('botMode.botMode')).hasAttribute('data-menu-selected')).toBe(true);
    await f.click(f.item(f.t('botMode.standardMode')));
    expect(f.actions.configure).toHaveBeenLastCalledWith({ enabled: false, expectedEnabled: true });
    expect(f.anchor().textContent).toContain(f.t('botMode.standardMode'));
  } finally { await f.close(); }
});

it('keeps an unread or failed owner state unknown, blocks writes, and offers an authoritative read', async () => {
  const read = deferred<{ enabled: boolean }>();
  const f = await fixture('en', read.promise);
  try {
    expect(f.anchor().textContent).toContain(f.t('botMode.modeReading'));
    await f.open();
    expect(f.item(f.t('botMode.botMode')).disabled).toBe(true);
    expect(f.item(f.t('botMode.standardMode')).disabled).toBe(true);
    expect(f.actions.settings).toHaveBeenCalledTimes(1);
    await act(async () => read.reject(new Error('Disconnected')));
    expect(f.anchor().textContent).toContain(f.t('botMode.modeUnknown'));
    expect(f.element.querySelector('[role="alert"]')?.textContent).toContain(f.t('supergroup.settingsFailed'));
    expect(f.actions.configure).not.toHaveBeenCalled();
    await f.click(f.item(f.t('bots.refresh')));
    expect(f.anchor().textContent).toContain(f.t('botMode.standardMode'));
    expect(f.item(f.t('botMode.botMode')).disabled).toBe(false);
  } finally { await f.close(); }
});

it.each(['conflict', 'lost response'])('blocks duplicate writes and requires a read after %s without replaying the save', async reason => {
  const f = await fixture();
  const save = deferred<{ enabled: boolean }>();
  f.actions.configure.mockImplementationOnce(() => save.promise);
  try {
    await f.open();
    await f.click(f.item(f.t('botMode.botMode')));
    await f.click(f.item(f.t('botMode.botMode')));
    expect(f.actions.configure).toHaveBeenCalledTimes(1);
    expect(f.anchor().textContent).toContain(f.t('botMode.standardMode'));
    expect(f.item(f.t('botMode.botMode')).disabled).toBe(true);
    f.setEnabled(true); // The Host can have committed despite the failed response.
    await act(async () => save.reject(new Error(reason)));
    expect(f.anchor().textContent).toContain(f.t('botMode.modeUnknown'));
    expect(f.item(f.t('botMode.botMode')).disabled).toBe(true);
    await f.click(f.item(f.t('botMode.botMode')));
    expect(f.actions.configure).toHaveBeenCalledTimes(1);
    await act(async () => f.publish('ready'));
    expect(f.anchor().textContent).toContain(f.t('botMode.botMode'));
    expect(f.actions.configure).toHaveBeenCalledTimes(1);
    await f.click(f.item(f.t('botMode.standardMode')));
    expect(f.actions.configure).toHaveBeenLastCalledWith({ enabled: false, expectedEnabled: true });
  } finally { await f.close(); }
});

it('rechecks externally settled mode changes and displays failed readiness without pretending Bot mode is active', async () => {
  const f = await fixture();
  try {
    f.setEnabled(true);
    await act(async () => f.publish('failed'));
    expect(f.anchor().textContent).toContain(f.t('botMode.modeUnavailable'));
    await f.open();
    expect(f.element.querySelector('[role="alert"]')?.textContent).toContain(f.t('botMode.notReady'));
    expect(f.item(f.t('botMode.standardMode')).disabled).toBe(false);
    f.setEnabled(false);
    await act(async () => f.publish('off'));
    expect(f.anchor().textContent).toContain(f.t('botMode.standardMode'));
    expect(f.actions.configure).not.toHaveBeenCalled();
    expect(f.listenerCount()).toBe(1);
  } finally { await f.close(); }
  expect(f.listenerCount()).toBe(0);
});

it('does not publish a late settings response after unmount', async () => {
  const read = deferred<{ enabled: boolean }>();
  const f = await fixture('en', read.promise);
  await f.close();
  await act(async () => read.resolve({ enabled: true }));
  expect(f.actions.configure).not.toHaveBeenCalled();
  expect(f.listenerCount()).toBe(0);
});

it('keeps Bot chats reachable from the one menu even before the mode is known, without submitting a setting', async () => {
  const read = deferred<{ enabled: boolean }>(), onOpenChats = vi.fn();
  const f = await fixture('en', read.promise, { onOpenChats, unreadCount: 3 });
  try {
    expect(f.element.querySelector('[data-bot-unread="footer"]')?.getAttribute('aria-label')).toBe('3 unread conversations');
    expect(f.element.querySelector('[data-bot-unread="footer"]')?.textContent).toBe('3');
    await f.open();
    expect(f.item(f.t('botMode.botMode')).disabled).toBe(true);
    expect(f.item(f.t('sidebar.sessions')).disabled).toBe(false);
    await f.click(f.item(f.t('sidebar.sessions')));
    expect(onOpenChats).toHaveBeenCalledTimes(1);
    expect(f.anchor().getAttribute('aria-expanded')).toBe('false');
    expect(f.actions.configure).not.toHaveBeenCalled();
  } finally { await f.close(); await act(async () => read.resolve({ enabled: false })); }
});

it('fits the compact rail without a wide unread badge and keeps the complete mode/count accessible to keyboard users', async () => {
  const f = await fixture('en', undefined, { compact: true, unreadCount: 123, onOpenChats: vi.fn() });
  try {
    const trigger = f.anchor();
    expect(trigger.style.width).toBe('32px');
    expect(trigger.style.height).toBe('32px');
    expect(trigger.style.padding).toBe('0px');
    expect(trigger.getAttribute('aria-label')).toContain(f.t('botMode.standardMode'));
    expect(trigger.getAttribute('aria-label')).toContain('123 unread conversations');
    expect(trigger.textContent).toBe('');
    const unread = trigger.querySelector<HTMLElement>('[data-bot-unread="footer"]')!;
    expect(unread.style.position).toBe('absolute');
    expect(unread.style.width).toBe('6px');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await f.open();
    expect(f.item(f.t('sidebar.sessions')).disabled).toBe(false);
  } finally { await f.close(); }
});
