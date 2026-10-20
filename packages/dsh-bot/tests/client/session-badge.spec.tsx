// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { ActivitySession } from '../../src/shared/activity.js';
import type { ActivitySnapshot } from '../../src/client/activity-state.js';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { SessionBotBadge, type SessionBotBadgeInjected, type SessionBotBadgeProps } from '../../src/client/components/SessionBotBadge.js';
import { createBotCatalog } from '../../src/client/state.js';
import { bot, button, click, field, mountClient, remoteDouble } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountBadge(preset?: unknown, language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  const remote = remoteDouble([bot({ id: 'alpha-bot', name: 'Alpha Bot', avatar: '🦊' })]);
  ctx.provide('remote.dshBot', remote.methods);
  ctx.provide('remote.dshBot.activity', remote.methods.activity);
  const catalog = createBotCatalog(ctx);
  const sessionId = 'session-badge-test' as SessionBotBadgeProps['sessionId'];
  const listeners = new Set<() => void>();
  let sessions = { byId: { [sessionId]: { projectionValues: { agentPreset: preset }, retainedBy: { mainView: 1 } } } } as unknown as SessionListState;
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const getSnapshot = () => sessions;
  const useSessions: SessionBotBadgeProps['useSessions'] = (selector) => {
    const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return selector(value);
  };
  const useCatalog: SessionBotBadgeProps['useCatalog'] = (selector) => {
    const value = useSyncExternalStore(catalog.observe, catalog.getSnapshot, catalog.getSnapshot);
    return selector(value);
  };
  const activityListeners = new Set<() => void>();
  let activity: ActivitySnapshot = { sessions: [], bots: [], loading: false, loaded: true, pollIntervalMs: 5000 };
  const activitySource = {
    getSnapshot: () => activity,
    subscribe: (listener: () => void) => { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; },
  };
  const useActivity: SessionBotBadgeProps['useActivity'] = (selector) => selector(useSyncExternalStore(activitySource.subscribe, activitySource.getSnapshot));
  const panelListeners = new Set<() => void>();
  let panelInfo: PanelInfo = { activePanelId: null };
  const panelSource = {
    getSnapshot: () => panelInfo,
    subscribe: (listener: () => void) => { panelListeners.add(listener); return () => { panelListeners.delete(listener); }; },
  };
  const usePanelInfo: SessionBotBadgeProps['usePanelInfo'] = (selector) => selector(useSyncExternalStore(panelSource.subscribe, panelSource.getSnapshot));
  const onMarkRead = vi.fn<(id: string) => Promise<void>>(async () => {});
  const dictionary: Record<string, string> = language === 'en' ? en.ui : zh.ui;
  const t: SessionBotBadgeProps['t'] = (key, params) => {
    const value = dictionary[key];
    if (value === undefined) throw new Error(`Missing ${language} locale ${key}`);
    return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`));
  };
  const onOpenBot = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    await ctx.fiber.dispose();
  });
  await act(async () => {
    root.render(<SessionBotBadge sessionId={sessionId} useSessions={useSessions}
      useCatalog={useCatalog} useActivity={useActivity} usePanelInfo={usePanelInfo} onMarkRead={onMarkRead} onOpenBot={onOpenBot} t={t} />);
  });
  return {
    ctx, container, remote, catalog, onOpenBot, listeners, activityListeners, panelListeners, onMarkRead,
    async setActivity(rows: ActivitySession[]) {
      await act(async () => { activity = { ...activity, sessions: rows }; for (const listener of activityListeners) listener(); });
    },
    async setPanel(activePanelId: PanelInfo['activePanelId']) {
      await act(async () => { panelInfo = { activePanelId }; for (const listener of panelListeners) listener(); });
    },
    async setMainSession(selected: boolean) {
      await act(async () => {
        sessions = { ...sessions, byId: { [sessionId]: { ...sessions.byId[sessionId], retainedBy: selected ? { mainView: 1 } : {} } } } as unknown as SessionListState;
        for (const listener of listeners) listener();
      });
    },
    async selectPreset(value: unknown) {
      await act(async () => {
        sessions = { ...sessions, byId: { [sessionId]: { projectionValues: { agentPreset: value }, retainedBy: { mainView: 1 } } } } as unknown as SessionListState;
        for (const listener of listeners) listener();
      });
    },
  };
}

describe('Session Bot badge with public session projection and the shared catalog', () => {
  const unread = (at = 100): ActivitySession => ({ sessionId: 'session-badge-test', botId: 'alpha-bot',
    updatedAt: at, unread: true, lastMessage: { role: 'assistant', preview: 'A completed reply', at } });

  it('marks only the visible native main session and retries for newly completed replies', async () => {
    const app = await mountBadge('host-selected/alpha-bot');
    await app.setActivity([unread()]);
    expect(app.onMarkRead).toHaveBeenCalledExactlyOnceWith('session-badge-test');
    await app.setActivity([{ ...unread(), unread: false }]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(1);
    await app.setActivity([unread(200)]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(2);
    await app.setPanel('dsh-bot' as PanelInfo['activePanelId']);
    await app.setActivity([unread(300)]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(2);
    await app.setPanel(null);
    expect(app.onMarkRead).toHaveBeenCalledTimes(3);
    await app.setMainSession(false);
    await app.setActivity([unread(400)]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(3);
    await app.setMainSession(true);
    expect(app.onMarkRead).toHaveBeenCalledTimes(4);
  });

  it('defers background-tab reads, ignores stale Bot ownership, and cleans all subscriptions', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const app = await mountBadge('host-selected/alpha-bot');
    await app.setActivity([unread()]);
    expect(app.onMarkRead).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(app.onMarkRead).toHaveBeenCalledTimes(1);
    await app.setActivity([{ ...unread(200), botId: 'another-bot' }]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(1);
    await app.selectPreset('standard');
    await app.setActivity([unread(300)]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(1);
    const cleanup = cleanups.pop();
    await cleanup?.();
    expect(app.listeners.size).toBe(0);
    expect(app.activityListeners.size).toBe(0);
    expect(app.panelListeners.size).toBe(0);
  });

  it('keeps failed reads unread and retries on the next public activity refresh', async () => {
    const app = await mountBadge('host-selected/alpha-bot');
    app.onMarkRead.mockRejectedValueOnce(new Error('transport details must not render'));
    await app.setActivity([unread()]);
    expect(app.container.textContent).not.toContain('transport details');
    await app.setActivity([unread()]);
    expect(app.onMarkRead).toHaveBeenCalledTimes(2);
  });

  it('mounts a real badge without a timer and refreshes on reset/visibility only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mountBadge('host-selected/alpha-bot');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    expect(app.remote.methods.status).toHaveBeenCalledTimes(1);
    await act(async () => app.ctx.emit('connection/reset'));
    expect(app.remote.methods.list).toHaveBeenCalledTimes(2);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(app.remote.methods.list).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('activates polling only for the Bots page and shares mutation refreshes with passive badge subscribers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mountClient([bot()]);
    cleanups.push(app.dispose);
    const badge = app.core.entries('conversation.session.header.utilities')[0]?.inject?.() as unknown as SessionBotBadgeInjected;
    const listener = vi.fn();
    const stopBadge = badge.hooks.catalog.subscribe(listener);
    await app.unmountPage();
    expect(vi.getTimerCount()).toBe(0);
    const oldCalls = app.remote.methods.list.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(oldCalls);
    await app.remountPage();
    expect(vi.getTimerCount()).toBe(1);
    const mountedCalls = app.remote.methods.list.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(app.remote.methods.list).toHaveBeenCalledTimes(mountedCalls + 1);
    const page = app.main.inject?.() as unknown as { onUpdate(id: string, patch: { name: string }): Promise<void> };
    await act(async () => page.onUpdate('alpha-bot', { name: 'Updated from page' }));
    expect(badge.hooks.catalog.getSnapshot().entries[0]?.bot.name).toBe('Updated from page');
    expect(listener).toHaveBeenCalled();
    await app.unmountPage();
    expect(vi.getTimerCount()).toBe(0);
    stopBadge();
  });

  it.each(['en', 'zh'] as const)('shows a disabled deleted badge only for the Host prefix in %s', async (language) => {
    const app = await mountBadge('custom-deleted', language);
    const dictionary = language === 'en' ? en.ui : zh.ui;
    expect(app.container.textContent).toBe(dictionary['badge.deleted']);
    expect(app.container.querySelector('button')).toBeNull();
    expect(app.container.querySelector('span')?.title).toBe(dictionary['badge.deletedHint']);
    await click(app.container.querySelector('span') as HTMLSpanElement);
    expect(app.onOpenBot).not.toHaveBeenCalled();
    await app.selectPreset('bot-deleted');
    expect(app.container.textContent).toBe('');
    await app.selectPreset('custom-');
    expect(app.container.textContent).toBe('');
    app.remote.data.records = [];
    await act(async () => app.catalog.refresh());
    await app.selectPreset('custom-deleted');
    expect(app.container.textContent).toBe(dictionary['badge.deleted']);
    app.remote.methods.list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => app.catalog.refresh());
    expect(app.container.textContent).toBe('');
  });

  it('changes an owned live Bot badge to deleted after removal and restores it after recreation', async () => {
    const app = await mountBadge('standard');
    app.remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha-bot', preset: { state: 'ok' } }];
    await act(async () => app.catalog.refresh());
    await app.selectPreset('custom-alpha-bot');
    expect(app.container.querySelector('button')?.textContent).toContain('Alpha Bot');
    app.remote.data.records = [];
    app.remote.data.statuses = [];
    await act(async () => app.catalog.refresh());
    expect(app.container.textContent).toBe(en.ui['badge.deleted']);
    expect(app.container.querySelector('button')).toBeNull();
    app.remote.data.records = [bot({ id: 'alpha-bot', name: 'Recreated Bot' })];
    app.remote.data.statuses = [{ id: 'alpha-bot', presetId: 'custom-alpha-bot', preset: { state: 'ok' } }];
    await act(async () => app.catalog.refresh());
    expect(app.container.querySelector('button')?.textContent).toContain('Recreated Bot');
  });

  it.each([undefined, null, 42, 'standard', 'bot-alpha-bot', 'bot-unknown'])('does not display an unmapped preset %s', async (preset) => {
    const app = await mountBadge(preset);
    expect(app.container.querySelector('button')).toBeNull();
    expect(app.container.textContent).toBe('');
    expect(app.onOpenBot).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('maps a custom Host preset id to the Bot and opens its details in %s', async (language) => {
    const app = await mountBadge('host-selected/alpha-bot', language);
    const badge = app.container.querySelector('button');
    expect(badge?.textContent).toContain('Alpha Bot');
    expect(badge?.textContent).toContain('🦊');
    const dictionary = language === 'en' ? en.ui : zh.ui;
    expect(badge?.getAttribute('aria-label')).toBe(dictionary['badge.open'].replace('{name}', 'Alpha Bot'));
    await click(badge as HTMLButtonElement);
    expect(app.onOpenBot).toHaveBeenCalledExactlyOnceWith('alpha-bot');
    expect(app.remote.methods.list).toHaveBeenCalledTimes(1);
    expect(app.remote.methods.status).toHaveBeenCalledTimes(1);
  });

  it('tracks current projection changes between Bot and non-Bot selections', async () => {
    const app = await mountBadge('standard');
    await app.selectPreset('host-selected/alpha-bot');
    expect(app.container.querySelector('button')?.textContent).toContain('Alpha Bot');
    await app.selectPreset('minimal');
    expect(app.container.querySelector('button')).toBeNull();
  });

  it('uses catalog refreshes for changed name, avatar, status mapping and deletion', async () => {
    const app = await mountBadge('host-selected/alpha-bot');
    const avatar = 'data:image/png;base64,aGVsbG8=';
    app.remote.data.records = [bot({ id: 'alpha-bot', name: 'Renamed Bot', avatar })];
    await act(async () => app.catalog.refresh());
    expect(app.container.querySelector('button')?.textContent).toBe('Renamed Bot');
    expect(app.container.querySelector('img')?.getAttribute('src')).toBe(avatar);
    app.remote.data.statuses = [];
    await act(async () => app.catalog.refresh());
    expect(app.container.querySelector('button')).toBeNull();
    app.remote.data.statuses = [{ id: 'alpha-bot', presetId: 'host-selected/alpha-bot', preset: { state: 'broken' } }];
    await act(async () => app.catalog.refresh());
    // A broken preset remains identifiable, so its Bot details can be repaired.
    expect(app.container.querySelector('button')?.textContent).toBe('Renamed Bot');
    app.remote.data.records = [];
    await act(async () => app.catalog.refresh());
    expect(app.container.querySelector('button')).toBeNull();
  });

  it('registers the header slot, navigates to exact Bot details repeatedly, and disposes the contribution', async () => {
    const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta Bot' })]);
    cleanups.push(app.dispose);
    const entries = app.core.entries('conversation.session.header.utilities');
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.component).toBe(SessionBotBadge);
    expect(entry?.options.id).toBe('dsh-bot');
    const actions = entry?.inject?.() as unknown as SessionBotBadgeInjected;
    // Both occupants subscribe to one catalog; the badge does not poll separately.
    const page = app.main.inject?.() as SessionBotBadgeInjected | undefined;
    expect(actions.hooks.catalog.getSnapshot).toBe(page?.hooks.catalog.getSnapshot);

    await act(async () => actions.onOpenBot('beta-bot'));
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    expect(field(app.container, en.ui['editor.id']).value).toBe('beta-bot');
    expect(field(app.container, en.ui['editor.name']).value).toBe('Beta Bot');
    await click(button(app.container, en.ui['actions.close']));
    expect(app.container.querySelector('dialog')).toBeNull();
    await act(async () => actions.onOpenBot('beta-bot'));
    expect(app.selectPanel).toHaveBeenCalledTimes(2);
    expect(field(app.container, en.ui['editor.id']).value).toBe('beta-bot');

    await app.unloadPlugin();
    expect(app.core.entries('conversation.session.header.utilities')).toHaveLength(0);
    expect(app.container.querySelector('dialog')).toBeNull();
    await act(async () => actions.onOpenBot('alpha-bot'));
    expect(app.selectPanel).toHaveBeenCalledTimes(2);
  });

  it('retains a badge detail request while Bots is unmounted and consumes it after the fresh catalog loads', async () => {
    const app = await mountClient([bot()]);
    cleanups.push(app.dispose);
    const actions = app.core.entries('conversation.session.header.utilities')[0]?.inject?.() as unknown as SessionBotBadgeInjected;
    await app.unmountPage();
    await act(async () => actions.onOpenBot('alpha-bot'));
    await app.remountPage();
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    expect(field(app.container, en.ui['editor.id']).value).toBe('alpha-bot');
    await click(button(app.container, en.ui['actions.close']));
    // A consumed navigation is not replayed by later catalog refreshes.
    await act(async () => app.ctx.emit('connection/reset'));
    expect(app.container.querySelector('dialog')).toBeNull();
  });
});
