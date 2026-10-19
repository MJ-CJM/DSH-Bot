// @vitest-environment jsdom
import { act } from 'react';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import type { BotsRightTabInjected } from '../../src/client/components/BotsRightTab.js';
import { BOTS_TAB_ID, BOTS_TAB_KIND } from '../../src/client/right-tab.js';
import type { ActivitySession } from '../../src/shared/activity.js';
import { bot, button, click, loadBuiltClient, mountClient } from './helpers.js';

const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(
  language: 'en' | 'zh' = 'en', configure?: Parameters<typeof mountClient>[2], built = false,
) {
  const app = await mountClient([bot()], language, configure, {}, built ? loadBuiltClient() : undefined, true);
  apps.push(app);
  await app.unmountPage();
  return app;
}
function session(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionSummary['id'], displayTitle: id, updatedAt, running: false, blank: false,
    retainedBy: {}, projectionValues: { agentPreset: 'host-selected/alpha-bot' }, ...extra };
}
function activity(id: string, at = Date.now()): ActivitySession {
  return { sessionId: id, botId: 'alpha-bot', updatedAt: at, unread: true,
    lastMessage: { role: 'assistant', preview: `Reply for ${id}`, at } };
}
async function setSessions(app: Awaited<ReturnType<typeof mount>>, rows: SessionSummary[]) {
  await app.setSessions({ ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) });
}
function option(container: ParentNode): HTMLButtonElement {
  const row = container.querySelector<HTMLButtonElement>('[role="option"][data-bot-id="alpha-bot"]');
  if (!row) throw new Error('Missing right-sidebar Bot row');
  return row;
}
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.dispose();
  vi.restoreAllMocks();
});

describe('Bots right tab through public Cordis and SlotCore contracts', () => {
  it('retains its initial selection, focus and scroll when new activity reorders Bots', async () => {
    const app = await mount('en', (remote) => { remote.data.records.push(bot({ id: 'beta-bot', name: 'Beta' })); });
    const tab = await app.mountRightTab();
    const row = option(tab);
    const list = tab.querySelector<HTMLElement>('[role="listbox"]');
    if (!list) throw new Error('Missing listbox');
    expect(row.getAttribute('aria-selected')).toBe('true');
    list.focus(); list.scrollTop = 30;
    app.remote.data.activities = [{ ...activity('beta-latest'), botId: 'beta-bot' }];
    const actions = app.core.entries('sidebar.right.pane.tab')[0]?.inject?.() as unknown as BotsRightTabInjected;
    await act(async () => actions.onRefresh());
    expect(list.querySelector('[role="option"]')?.getAttribute('data-bot-id')).toBe('beta-bot');
    expect(option(tab)).toBe(row);
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(list);
    expect(list.scrollTop).toBe(30);
  });
  it.each(['en', 'zh'] as const)('registers a localized type, guide, keyed body/title and both openers, then releases them (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const app = await mount(language);
    expect(app.registerRightTab).toHaveBeenCalledTimes(1);
    const definition = app.rightDefinitions.get(BOTS_TAB_ID);
    expect(definition).toMatchObject({ id: BOTS_TAB_ID, kind: BOTS_TAB_KIND });
    expect(definition?.title('')).toBe(dictionary['rightTab.title']);
    expect(definition?.guide?.[0]?.title()).toBe(dictionary['rightTab.title']);
    expect(definition?.guide?.[0]?.description?.()).toBe(dictionary['rightTab.description']);
    expect(definition?.multiple).toBeUndefined();
    expect(app.core.entries('sidebar.right.pane.tab').map((entry) => entry.options.key)).toEqual([BOTS_TAB_ID]);
    expect((await app.mountRightTitle()).textContent).toBe(dictionary['rightTab.title']);
    await app.setRightSession('current-session');
    const opener = await app.mountRightOpener('current-session');
    await click(button(opener, dictionary['rightTab.open']));
    expect(app.openRightTab).toHaveBeenCalledExactlyOnceWith(BOTS_TAB_KIND);
    const hero = await app.mountRightOpener('current-session', true);
    expect(button(hero, dictionary['rightTab.open'])).toBeDefined();
    const tab = await app.mountRightTab();
    expect(tab.querySelector('[data-bots-right-tab]')).not.toBeNull();
    expect(option(tab).querySelector<HTMLElement>('[data-bot-avatar]')?.style.width).toBe('32px');
    await app.unloadPlugin();
    expect(app.rightDefinitions.size).toBe(0);
    expect(app.core.entries('sidebar.right.pane.tab')).toEqual([]);
    expect(app.core.entries('sidebar.right.pane.tab.title')).toEqual([]);
    expect(app.core.entries('conversation.hero.options')).toEqual([]);
    expect(app.core.entries('conversation.session.header.utilities')).toEqual([]);
    expect(tab.textContent).toBe('');
    expect(opener.textContent).toBe('');
    expect(app.rightSessionListeners.size).toBe(0);
    expect(app.sessionListeners.size).toBe(0);
    await app.reloadPlugin();
    expect(app.rightDefinitions.size).toBe(1);
    expect(app.registerRightTab).toHaveBeenCalledTimes(2);
    expect(app.core.entries('sidebar.right.pane.tab')).toHaveLength(1);
  });

  it.each(['source', 'built'] as const)('opens the latest eligible Host session after markRead and follows only after destination commit (%s)', async (implementation) => {
    const now = Date.now();
    const app = await mount('en', (remote) => { remote.data.activities = [activity('older', now - 60_000), activity('latest', now), activity('evicted', now + 50_000)]; }, implementation === 'built');
    await setSessions(app, [session('older', now - 60_000), session('latest', now), session('archived', now + 1_000),
      session('subagent', now + 2_000, { origin: 'subagent' }),
      session('other-bot', now + 3_000, { projectionValues: { agentPreset: 'host-selected/other-bot' } })]);
    await app.setWorkspaces({ archivedSessionIds: ['archived' as SessionSummary['id']] });
    await app.setRightSession('source-session');
    await app.mountRightOpener('source-session');
    const tab = await app.mountRightTab();
    let finish!: () => void;
    const original = app.remote.methods.activity.markRead.getMockImplementation();
    if (!original) throw new Error('Missing markRead double');
    app.remote.methods.activity.markRead.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return original(...args);
    });
    await click(option(tab));
    expect(app.remote.methods.activity.markRead).toHaveBeenCalledExactlyOnceWith('latest');
    expect(app.openSession).not.toHaveBeenCalled();
    expect(option(tab).disabled).toBe(true);
    await click(option(tab));
    await act(async () => { finish(); });
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('latest');
    expect(app.remote.methods.activity.markRead.mock.invocationCallOrder[0]).toBeLessThan(app.openSession.mock.invocationCallOrder[0] ?? 0);
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
    expect(app.rightSession()).toBe('latest');
    await app.mountRightOpener('latest');
    expect(app.openRightTab).toHaveBeenCalledExactlyOnceWith(BOTS_TAB_KIND);
    await app.mountRightOpener('latest');
    expect(app.openRightTab).toHaveBeenCalledTimes(1);
  });

  it('creates a Bot session with the Host-selected preset and follows the blank-session Hero commit', async () => {
    const app = await mount('zh', (remote) => {
      remote.data.statuses = [{ id: 'alpha-bot', presetId: 'host-custom/preset-v2', preset: { state: 'ok' } }];
    });
    await app.setRightSession('source-session');
    const tab = await app.mountRightTab();
    await click(option(tab));
    expect(app.createSession).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'bots-workspace', agentPreset: 'host-custom/preset-v2' });
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.remote.methods.activity.markRead).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
    await app.mountRightOpener('test-created-session', true);
    expect(app.openRightTab).toHaveBeenCalledExactlyOnceWith(BOTS_TAB_KIND);
  });

  it('blocks initial catalog loading but keeps the prior loaded view usable during background refresh', async () => {
    const app = await mount();
    await app.setSessions({ phase: 'pending' });
    const tab = await app.mountRightTab();
    expect(option(tab).disabled).toBe(true);
    await click(option(tab));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(tab.textContent).toContain(en.ui['bots.loading']);
    await app.setSessions({ phase: 'ready' });
    let finish!: () => void;
    const original = app.remote.methods.list.getMockImplementation();
    if (!original) throw new Error('Missing list double');
    app.remote.methods.list.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return original(); });
    await click(button(tab, en.ui['bots.refresh']));
    const row = option(tab);
    expect(row.disabled).toBe(false);
    expect(tab.textContent).not.toContain(en.ui['bots.loading']);
    expect(app.openWorkspace).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(option(tab)).toBe(row);
    expect(option(tab).disabled).toBe(false);
  });

  it('shows localized failures and retry, without leaking transport details or starting from a failed catalog', async () => {
    const app = await mount('zh');
    const tab = await app.mountRightTab();
    app.remote.methods.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('store/unavailable', 'sensitive host diagnostic', {}) });
    await click(button(tab, zh.ui['bots.refresh']));
    expect(tab.querySelector('[role="alert"]')?.textContent).toContain(zh.ui['errors.load']);
    expect(tab.textContent).not.toContain('sensitive host diagnostic');
    await click(option(tab));
    expect(app.openWorkspace).not.toHaveBeenCalled();
    await click(button(tab, zh.ui['actions.retry']));
    app.createSession.mockRejectedValueOnce(new Error('private workspace path'));
    await click(option(tab));
    expect(tab.querySelector('[role="alert"]')?.textContent).toContain(zh.ui['activity.openError']);
    expect(tab.textContent).not.toContain('private workspace path');
  });

  it.each(['tab-unmount', 'plugin-unload', 'other-navigation'] as const)('cancels late markRead navigation after %s', async (change) => {
    const app = await mount('en', (remote) => { remote.data.activities = [activity('latest')]; });
    await setSessions(app, [session('latest', Date.now())]);
    await app.setRightSession('source-session');
    const tab = await app.mountRightTab();
    let finish!: () => void;
    const original = app.remote.methods.activity.markRead.getMockImplementation();
    if (!original) throw new Error('Missing markRead double');
    app.remote.methods.activity.markRead.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; }); return original(...args);
    });
    await click(option(tab));
    if (change === 'tab-unmount') await app.unmountRightTab();
    if (change === 'plugin-unload') await app.unloadPlugin();
    if (change === 'other-navigation') await act(async () => { app.selectPanel('dsh-bot' as never); });
    await act(async () => { finish(); });
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it.each(['tab-unmount', 'plugin-unload', 'other-navigation'] as const)('cancels late new-session status responses after %s', async (change) => {
    const app = await mount();
    const tab = await app.mountRightTab();
    let finish!: () => void;
    const original = app.remote.methods.status.getMockImplementation();
    if (!original) throw new Error('Missing status double');
    app.remote.methods.status.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; }); return original();
    });
    await click(option(tab));
    if (change === 'tab-unmount') await app.unmountRightTab();
    if (change === 'plugin-unload') await app.unloadPlugin();
    if (change === 'other-navigation') await act(async () => { app.selectPanel('dsh-bot' as never); });
    await act(async () => { finish(); });
    expect(app.openWorkspace).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it('clears a failed navigation follow before a later independent visit to the same session', async () => {
    const app = await mount('en', (remote) => { remote.data.activities = [activity('latest')]; });
    await setSessions(app, [session('latest', Date.now())]);
    await app.setRightSession('source-session');
    const tab = await app.mountRightTab();
    // openSession runs after the plugin's beforeOpen hook has queued the target.
    app.openSession.mockImplementationOnce(() => { throw new Error('navigation failed'); });
    await click(option(tab));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('latest');
    expect(tab.querySelector('[role="alert"]')?.textContent).toBe(en.ui['activity.openError']);
    expect(app.openRightTab).not.toHaveBeenCalled();
    await app.setRightSession('latest');
    await app.mountRightOpener('latest');
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it.each(['panel', 'session'] as const)('drops a pending follow when a different %s navigation wins before destination commit', async (change) => {
    const app = await mount('en', (remote) => { remote.data.activities = [activity('latest')]; });
    await setSessions(app, [session('latest', Date.now())]);
    const tab = await app.mountRightTab();
    await click(option(tab));
    expect(app.rightSession()).toBe('latest');
    expect(app.openRightTab).not.toHaveBeenCalled();
    await act(async () => {
      if (change === 'panel') app.selectPanel('dsh-bot' as never);
      else app.openSession('unrelated' as never);
    });
    await app.setRightSession('latest');
    await app.mountRightOpener('latest');
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it('shows opener errors and refuses stale injected actions after unload', async () => {
    const app = await mount('zh');
    await app.setRightSession('current-session');
    const opener = await app.mountRightOpener('current-session');
    app.openRightTab.mockImplementationOnce(() => { throw new Error('private shell error'); });
    await click(button(opener, zh.ui['rightTab.open']));
    expect(opener.querySelector('[role="alert"]')?.textContent).toBe(zh.ui['rightTab.openError']);
    expect(opener.textContent).not.toContain('private shell error');
    const actions = app.core.entries('sidebar.right.pane.tab')[0]?.inject?.() as unknown as BotsRightTabInjected;
    await app.unloadPlugin();
    await actions.onOpenSession('latest');
    await actions.onStart('alpha-bot');
    await actions.onStartInWorkspace('alpha-bot', 'workspace-one');
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.openWorkspace).not.toHaveBeenCalled();
  });
});
