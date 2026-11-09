// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { BOT_PANEL_ID, BOT_PANEL_KIND, BotRightPanel, panelEntry, type BotRightPanelProps } from '../../src/client/components/BotRightPanel.js';
import type { SessionBotBadgeProps } from '../../src/client/components/SessionBotBadge.js';
import type { BotCatalogEntry } from '../../src/client/state.js';
import { botKeySchema } from '../../src/shared/identity.js';
import { capabilities, type ProactiveStatus, type Suggestion } from '../../src/shared/proactive/protocol.js';
import { workSchema, type ProactiveWork } from '../../src/shared/proactive/work.js';
import { bot, button, click, mountClient } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
const statuses = [
  { id: 'alpha-bot', presetId: 'host-selected/alpha-bot', mainSessionId: 'alpha-main', preset: { state: 'ok' as const } },
  { id: 'beta-bot', presetId: 'host-selected/beta-bot', mainSessionId: 'beta-main', preset: { state: 'ok' as const } },
];
async function mount(language: 'en' | 'zh' = 'en', rightSidebar = true) {
  const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta', description: 'Reviews notes' })], language,
    (remote) => { remote.data.statuses = statuses; }, {}, undefined, rightSidebar);
  cleanups.push(app.dispose);
  await app.unmountPage();
  return app;
}
const navigation = (params: unknown, revision = 1, visible = true) => () => ({ tab: { visible, navigation: { address: '', params, revision } } });
const botCreatedAt = bot().createdAt;
const isPanel = (options: Record<string, unknown>) => options.key === BOT_PANEL_ID;
const isPreview = (options: Record<string, unknown>) => options.id === 'dsh-bot-preview';
const selectedTab = (container: HTMLElement) => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
type App = Awaited<ReturnType<typeof mountClient>>;
async function mountPreview(app: App) {
  const preview = await app.mountEntry('shell.overlay', isPreview);
  cleanups.push(preview.unmount);
  return preview.container;
}
async function mountIdentity(app: App, sessionId: string, blank = false) {
  const useSessions: SessionBotBadgeProps['useSessions'] = select => select({ byId: { [sessionId]: { blank, retainedBy: { mainView: 1 } } } } as never);
  const usePanelInfo: SessionBotBadgeProps['usePanelInfo'] = select => select({ activePanelId: null });
  const surface = await app.mountEntry(blank ? 'conversation.input.dock' : 'conversation.session.header.utilities',
    options => options.id === (blank ? 'dsh-bot-empty-identity' : 'dsh-bot'), { sessionId, useSessions, usePanelInfo });
  cleanups.push(surface.unmount);
  return surface.container;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Compact Bot details preview', () => {
  it.each(['en', 'zh'] as const)('opens the correct Bot from the header and empty composer identity (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const app = await mount(language);
    const preview = await mountPreview(app);
    expect(preview.querySelector('dialog')).toBeNull();

    await app.setRightSession('alpha-main');
    const header = await mountIdentity(app, 'alpha-main');
    await click(button(header, dictionary['badge.open'].replace('{name}', 'Alpha Bot')));
    const dialog = preview.querySelector('dialog');
    expect(dialog?.getAttribute('aria-label')).toBe(dictionary['botPanel.title']);
    expect(dialog?.querySelector('[data-bot-panel]')?.getAttribute('data-bot-panel')).toBe('alpha-bot');
    expect(dialog?.querySelector('[data-bot-panel-current]')?.textContent).toBe(dictionary['botPanel.current']);
    expect(selectedTab(preview)).toBe(dictionary['botPanel.overview']);
    expect(() => button(preview, dictionary['chat.openChat'])).toThrow();
    expect(app.rightSession()).toBe('alpha-main');

    // Simulate the platform Modal requesting close. Escape and focus are verified in the browser.
    await act(async () => { dialog?.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })); });
    expect(preview.querySelector('dialog')).toBeNull();
    await app.setRightSession('beta-main');
    const dock = await mountIdentity(app, 'beta-main', true);
    await click(button(dock, dictionary['badge.open'].replace('{name}', 'Beta')));
    expect(preview.querySelector('[data-bot-panel]')?.getAttribute('data-bot-panel')).toBe('beta-bot');
    expect(preview.textContent).toContain('Reviews notes');
    expect(app.rightSession()).toBe('beta-main');
    expect(app.openRightTab).not.toHaveBeenCalled();
    expect(app.selectPanel).not.toHaveBeenCalled();
    expect(app.openSession).not.toHaveBeenCalled();
  });

  it('transfers the selected Bot and section only on explicit sidebar open', async () => {
    const app = await mount();
    const preview = await mountPreview(app);
    await app.setRightSession('beta-main');
    const header = await mountIdentity(app, 'beta-main');
    await click(button(header, en.ui['badge.open'].replace('{name}', 'Beta')));
    await click(button(preview, en.ui['botPanel.messages']));
    expect(selectedTab(preview)).toBe(en.ui['botPanel.messages']);
    expect(app.openRightTab).not.toHaveBeenCalled();
    await click(button(preview, en.ui['botPanel.openSidebar']));
    expect(app.openRightTab).toHaveBeenCalledExactlyOnceWith(BOT_PANEL_KIND, { params: { botId: 'beta-bot', botCreatedAt, section: 'messages' } });
    expect(preview.querySelector('dialog')).toBeNull();
    expect(app.rightSession()).toBe('beta-main');
    expect(app.selectPanel).not.toHaveBeenCalled();
  });

  it('closes on conversation change, opens settings for the selected Bot, and releases the overlay on unload', async () => {
    const app = await mount();
    const preview = await mountPreview(app);
    const header = await mountIdentity(app, 'beta-main');
    const badge = button(header, en.ui['badge.open'].replace('{name}', 'Beta'));
    await app.setRightSession('beta-main');
    await click(badge);
    await click(button(preview, en.ui['botPanel.messages']));
    await app.setRightSession('alpha-main');
    expect(preview.querySelector('dialog')).toBeNull();
    await app.setRightSession('beta-main');
    expect(preview.querySelector('dialog')).toBeNull();
    await click(badge);
    expect(selectedTab(preview)).toBe(en.ui['botPanel.overview']);
    await click(button(preview, en.ui['botPanel.settings']));
    expect(preview.querySelector('dialog')).toBeNull();
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    await app.remountPage();
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('beta-bot');

    await app.setRightSession('beta-main');
    await click(badge);
    expect(preview.querySelector('dialog')).not.toBeNull();
    await app.unloadPlugin();
    expect(app.core.entries('shell.overlay').some(entry => isPreview(entry.options))).toBe(false);
    expect(preview.querySelector('dialog')).toBeNull();
    expect(app.rightSessionListeners.size).toBe(0);
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it('keeps a newer preview open when a superseded chat request finishes', async () => {
    const app = await mount();
    const preview = await mountPreview(app);
    const header = await mountIdentity(app, 'alpha-main');
    const badge = button(header, en.ui['badge.open'].replace('{name}', 'Alpha Bot'));
    const actions = app.core.entries('conversation.session.header.utilities').find(entry => entry.options.id === 'dsh-bot')?.inject?.() as
      { onOpenBot(id: string): void } | undefined;
    type Result = Awaited<ReturnType<typeof app.remote.methods.openConversation>>;
    let finishChat!: (result: Result) => void;
    const pending = new Promise<Result>(resolve => { finishChat = resolve; });
    app.remote.methods.openConversation.mockReturnValueOnce(pending);
    await app.setRightSession('alpha-main');

    await act(async () => { actions?.onOpenBot('beta-bot'); });
    await click(button(preview, en.ui['chat.openChat']));
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('beta-bot');
    // A subsequent navigation supersedes the pending request before a new preview opens.
    app.ctx.layout.beginNavigation();
    await click(badge);
    await act(async () => { finishChat({ ok: true, value: { sessionId: 'beta-main' } }); });
    expect(preview.querySelector('[data-bot-panel]')?.getAttribute('data-bot-panel')).toBe('alpha-bot');
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.openRightTab).not.toHaveBeenCalled();
  });

  it.each([true, false])('falls back to the Bots page without a mounted conversation (sidebar installed: %s)', async (rightSidebar) => {
    const app = await mount('en', rightSidebar);
    const preview = await mountPreview(app);
    const header = await mountIdentity(app, 'beta-main');
    await click(button(header, en.ui['badge.open'].replace('{name}', 'Beta')));
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    expect(app.openRightTab).not.toHaveBeenCalled();
    expect(preview.querySelector('dialog')).toBeNull();
    await app.remountPage();
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe('beta-bot');
  });
});

describe('Bot details in the native right sidebar', () => {
  it.each(['en', 'zh'] as const)('registers one page type with a live title and releases it on unload (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const app = await mount(language);
    const definition = app.rightDefinitions.get(BOT_PANEL_ID);
    expect(definition).toMatchObject({ id: BOT_PANEL_ID, kind: BOT_PANEL_KIND });
    expect(definition?.title('')).toBe(dictionary['botPanel.title']);
    // A page about one Bot needs a Bot; it offers no guide capsule and keeps one page per pane.
    expect(definition?.guide).toBeUndefined();
    expect(definition?.multiple).toBeUndefined();
    const title = await app.mountEntry('sidebar.right.pane.tab.title', isPanel, { sessionId: 'elsewhere', useTabInfo: navigation({ botId: 'beta-bot', botCreatedAt }) });
    expect(title.container.textContent).toBe('Beta');
    await title.rerender({ sessionId: 'elsewhere', useTabInfo: navigation({ botId: 'gone-bot' }) });
    expect(title.container.textContent).toBe(dictionary['botPanel.title']);
    await title.unmount();
    await app.unloadPlugin();
    expect(app.rightDefinitions.has(BOT_PANEL_ID)).toBe(false);
    expect(app.core.entries('sidebar.right.pane.tab').some(entry => entry.options.key === BOT_PANEL_ID)).toBe(false);
  });

  it.each(['en', 'zh'] as const)('shows another Bot with chat and settings actions, and the current Bot without a redundant open (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const app = await mount(language);
    const panel = await app.mountEntry('sidebar.right.pane.tab', isPanel, { sessionId: 'alpha-main', useTabInfo: navigation({ botId: 'beta-bot', botCreatedAt }) });
    const root = panel.container;
    expect(root.querySelector('[data-bot-panel="beta-bot"]')).not.toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('Beta');
    expect(root.textContent).toContain('Reviews notes');
    expect(selectedTab(root)).toBe(dictionary['botPanel.overview']);
    await click(button(root, dictionary['chat.openChat']));
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('beta-bot');
    expect(app.openSession).toHaveBeenCalledWith('test-created-session');
    await click(button(root, dictionary['botPanel.settings']));
    expect(app.selectPanel).toHaveBeenCalledWith('dsh-bot');
    await panel.rerender({ sessionId: 'alpha-main', useTabInfo: navigation({ botId: 'alpha-bot' }, 2) });
    expect(root.querySelector('[data-bot-panel-current]')?.textContent).toBe(dictionary['botPanel.current']);
    expect(() => button(root, dictionary['chat.openChat'])).toThrow();
    await panel.unmount();
  });

  it.each([1360, 390])('shares live work, focuses the exact item, and releases hidden views at %s px', async width => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', width);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mount();
    const proactive = app.ctx.get('remote.dshBot.proactive');
    if (!proactive) throw new Error('Proactive Remote missing');
    const alpha = { botId: 'alpha-bot', botCreatedAt: bot().createdAt };
    const beta = { ...alpha, botId: 'beta-bot' };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const suggestion: Suggestion = {
      id: 'alpha-decision', sourceId: 'synthetic-source', triggerId: 'synthetic-trigger',
      title: 'Investigate a new CI failure', state: 'open', attempt: 1, policyVersion: 'v1',
      observedAt: new Date().toISOString(), expiresAt, revision: 0, scope: 'inspect-ci-result',
    };
    let suggestions: Suggestion[] = [];
    let works: ProactiveWork[] = [];
    let unavailable = false;
    let localFeed: ProactiveStatus['localFeed'] = 'ready';
    const status = vi.spyOn(proactive, 'status').mockImplementation(async () => ({
      ok: true, value: { state: unavailable ? 'unavailable' : 'ready', capabilities, localFeed,
        localFeedScope: { id: 'synthetic-source', generation: 0, repository: 'fixture/repo', branch: 'main' } },
    }));
    const suggestionsRead = vi.spyOn(proactive, 'botSuggestions').mockImplementation(async owner => ({
      ok: true, value: botKeySchema.parse(owner).botId === alpha.botId ? suggestions : [],
    }));
    const workRead = vi.spyOn(proactive, 'botWork').mockImplementation(async () => ({ ok: true, value: works }));
    const runtime = (botId: string, revision: number, visible = true) => ({
      sessionId: 'alpha-main', useTabInfo: navigation({ botId, botCreatedAt, section: 'tasks' }, revision, visible),
    });
    const panel = await app.mountEntry('sidebar.right.pane.tab', isPanel, runtime(alpha.botId, 1));
    cleanups.push(panel.unmount);
    expect(status).toHaveBeenCalledTimes(1);
    expect(panel.container.textContent).toContain(en.ui['botPanel.taskEmpty']);
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    suggestions = [suggestion];
    await tick();
    expect(panel.container.textContent).toContain(suggestion.title);
    expect(panel.container.textContent).toContain(en.ui['botPanel.taskGroup.decide']);
    await click(button(panel.container, en.ui['botPanel.overview']));
    const overview = panel.container.querySelector('[data-bot-panel-overview]');
    expect(overview?.textContent).toContain(en.ui['botPanel.taskGroup.decide']);
    expect(overview?.querySelector('details')?.open).toBe(false);
    await click(button(panel.container, en.ui['botPanel.viewTasks']));
    expect(selectedTab(panel.container)).toBe(en.ui['botPanel.tasks']);
    expect(status).toHaveBeenCalledTimes(2);

    await click(button(panel.container, `${suggestion.title}${en.ui['botPanel.taskSuggestion']}`));
    await app.remountPage();
    expect(app.container.querySelector('[data-bot-detail]')?.getAttribute('data-bot-detail')).toBe(alpha.botId);
    expect(selectedTab(app.container)).toBe(en.ui['detail.work']);
    expect(document.activeElement?.getAttribute('data-proactive-decision')).toBe(suggestion.id);
    const dutyPanel = app.container.querySelector(`[aria-label="${en.ui['responsibility.title']}"]`);
    expect((dutyPanel?.compareDocumentPosition(document.activeElement as Node) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(status).toHaveBeenCalledTimes(2);

    const delivery = workSchema.parse({
      ticketId: 'alpha-ticket', assignmentId: 'alpha-assignment', decisionId: suggestion.id,
      triggerId: suggestion.triggerId, sourceId: suggestion.sourceId, title: 'Review the CI analysis',
      target: { bot: alpha, botUpdatedAt: 1, provider: 'fixture', model: 'synthetic' },
      expiresAt, policyVersion: 'v1', revision: 1, generation: 1, state: 'delivered',
    });
    works = [delivery, { ...delivery, ticketId: 'beta-ticket', title: 'Other Bot private work',
      target: { ...delivery.target, bot: beta }, state: 'unknown' }];
    suggestions = [];
    localFeed = 'revoked';
    await tick();
    expect(status).toHaveBeenCalledTimes(3);
    expect(workRead).toHaveBeenLastCalledWith(alpha);
    expect(app.container.querySelector('[data-proactive-ticket]')?.getAttribute('data-proactive-ticket')).toBe(delivery.ticketId);
    expect(app.container.querySelector('[data-proactive-ci-feed]')?.textContent).toContain(en.ui['proactive.feed.revoked']);
    expect(panel.container.textContent).toContain(delivery.title);
    expect(panel.container.textContent).not.toContain('Other Bot private work');
    await click(button(panel.container, `${delivery.title}${en.ui['proactive.state.delivered']}`));
    expect(document.activeElement?.getAttribute('data-proactive-ticket')).toBe(delivery.ticketId);

    unavailable = true;
    await tick();
    expect(panel.container.textContent).toContain(delivery.title);
    expect(panel.container.textContent).toContain('Refresh failed.');
    const reads = status.mock.calls.length;
    await panel.rerender(runtime(alpha.botId, 1, false));
    await click(button(app.container, en.ui['detail.overview']));
    await tick();
    expect(status).toHaveBeenCalledTimes(reads);
    expect(panel.container.textContent).toContain(delivery.title); // retained DOM with no active lease

    unavailable = false;
    let complete!: (value: Awaited<ReturnType<typeof proactive.status>>) => void;
    status.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await panel.rerender(runtime(alpha.botId, 1));
    await panel.rerender(runtime(beta.botId, 2));
    expect(panel.container.textContent).toContain('Other Bot private work');
    expect(panel.container.textContent).toContain(en.ui['botPanel.taskGroup.check']);
    expect(panel.container.textContent).not.toContain(delivery.title);
    const suggestionsReads = suggestionsRead.mock.calls.length;
    await act(async () => complete({ ok: true, value: { state: 'ready', capabilities } }));
    expect(suggestionsRead).toHaveBeenCalledTimes(suggestionsReads);
    expect(panel.container.textContent).not.toContain(delivery.title);
    await click(button(panel.container, en.ui['botPanel.otherWork']));
    expect(selectedTab(app.container)).toBe(en.ui['detail.work']);
    expect(document.activeElement?.hasAttribute('data-bot-other-work')).toBe(true);
    const activeDutyPanel = app.container.querySelector(`[aria-label="${en.ui['responsibility.title']}"]`);
    expect((activeDutyPanel?.compareDocumentPosition(document.activeElement as Node) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe('Bot panel navigation', () => {
  const t = (key: string, params?: Record<string, unknown>) => ((en.ui as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name]));
  const entries: BotCatalogEntry[] = [{ bot: bot(), status: statuses[0] }, { bot: bot({ id: 'beta-bot', name: 'Beta' }), status: statuses[1] }];
  const snapshot = { entries, loaded: true, loading: false, pollIntervalMs: 1000 };
  function render(params: unknown, revision: number, sessionId = 'alpha-main', catalogEntries = entries) {
    const props = { sessionId, useTabInfo: navigation(params, revision), useCatalog: (select: (value: typeof snapshot) => unknown) => select({ ...snapshot, entries: catalogEntries }),
      onOpenSession: vi.fn(), onStart: vi.fn(async () => {}), onOpenSettings: vi.fn(), t } as unknown as BotRightPanelProps;
    return <BotRightPanel {...props} />;
  }
  it('resolves the named Bot, the Session\'s own Bot for a restored tab, and nothing for an unknown Bot', () => {
    expect(panelEntry(entries, 'alpha-main', { botId: 'beta-bot', botCreatedAt })?.bot.id).toBe('beta-bot');
    expect(panelEntry(entries, 'alpha-main', { botId: 'beta-bot' })).toBeUndefined();
    expect(panelEntry(entries, 'beta-main', { botId: 'beta-bot' })?.bot.id).toBe('beta-bot');
    expect(panelEntry(entries, 'beta-main', undefined)?.bot.id).toBe('beta-bot');
    expect(panelEntry(entries, 'alpha-main', { botId: 'gone' })).toBeUndefined();
    expect(panelEntry(entries, 'unrelated', undefined)).toBeUndefined();
  });
  it('opens a requested section and resets the view on every navigation, even to the same Bot', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const selected = () => selectedTab(container);
    try {
      await act(async () => root.render(render({ botId: 'beta-bot', botCreatedAt, section: 'messages' }, 1)));
      expect(selected()).toBe(t('botPanel.messages'));
      await click(button(container, t('botPanel.tasks')));
      expect(selected()).toBe(t('botPanel.tasks'));
      // A refresh without navigation keeps the reader's place.
      await act(async () => root.render(render({ botId: 'beta-bot', botCreatedAt, section: 'messages' }, 1)));
      expect(selected()).toBe(t('botPanel.tasks'));
      await act(async () => root.render(render({ botId: 'beta-bot', botCreatedAt, section: 'messages' }, 2)));
      expect(selected()).toBe(t('botPanel.messages'));
      await act(async () => root.render(render({ botId: 'alpha-bot' }, 3)));
      expect(selected()).toBe(t('botPanel.overview'));
      await act(async () => root.render(render({ botId: 'gone-bot' }, 4)));
      expect(container.textContent).toContain(t('botPanel.missing'));
      await act(async () => root.render(render(undefined, 0, 'unrelated')));
      expect(container.textContent).toContain(t('botPanel.empty'));
    } finally { await act(async () => root.unmount()); container.remove(); }
  });

  it('keeps a previously opened panel bound to the original Bot generation', async () => {
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const params = { botId: 'beta-bot', botCreatedAt, section: 'tasks' };
    const replacement = { ...bot({ id: 'beta-bot', name: 'New generation' }), createdAt: botCreatedAt + 1, updatedAt: botCreatedAt + 1 };
    try {
      await act(async () => root.render(render(params, 1)));
      expect(container.querySelector('[data-bot-panel="beta-bot"]')).not.toBeNull();
      await act(async () => root.render(render(params, 1, 'alpha-main', [{ bot: replacement }])));
      expect(container.textContent).toContain(t('botPanel.missing'));
      expect(container.textContent).not.toContain(replacement.name);
      await act(async () => root.render(render({ ...params, botCreatedAt: replacement.createdAt }, 2, 'alpha-main', [{ bot: replacement }])));
      expect(container.textContent).toContain(replacement.name);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
