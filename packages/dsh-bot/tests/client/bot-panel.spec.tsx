// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { BOT_PANEL_ID, BOT_PANEL_KIND, BotRightPanel, panelEntry, type BotRightPanelProps } from '../../src/client/components/BotRightPanel.js';
import type { BotCatalogEntry } from '../../src/client/state.js';
import { bot, button, click, mountClient } from './helpers.js';

const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
const statuses = [
  { id: 'alpha-bot', presetId: 'host-selected/alpha-bot', mainSessionId: 'alpha-main', preset: { state: 'ok' as const } },
  { id: 'beta-bot', presetId: 'host-selected/beta-bot', mainSessionId: 'beta-main', preset: { state: 'ok' as const } },
];
async function mount(language: 'en' | 'zh' = 'en', rightSidebar = true) {
  const app = await mountClient([bot(), bot({ id: 'beta-bot', name: 'Beta', description: 'Reviews notes' })], language,
    (remote) => { remote.data.statuses = statuses; }, {}, undefined, rightSidebar);
  apps.push(app);
  await app.unmountPage();
  return app;
}
const navigation = (params: unknown, revision = 1) => () => ({ tab: { navigation: { address: '', params, revision } } });
const isPanel = (options: Record<string, unknown>) => options.key === BOT_PANEL_ID;
type App = Awaited<ReturnType<typeof mountClient>>;
function opener(app: App, slot: 'conversation.session.header.utilities' | 'conversation.input.dock', id: string) {
  const injected = app.core.entries(slot).find(entry => entry.options.id === id)?.inject?.() as { onOpenBot?(botId: string): void } | undefined;
  if (!injected?.onOpenBot) throw new Error(`Missing ${id} Bot opener`);
  return injected.onOpenBot;
}
afterEach(async () => {
  for (const app of apps.splice(0).reverse()) await app.dispose();
  vi.restoreAllMocks();
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
    const title = await app.mountEntry('sidebar.right.pane.tab.title', isPanel, { sessionId: 'elsewhere', useTabInfo: navigation({ botId: 'beta-bot' }) });
    expect(title.container.textContent).toBe('Beta');
    await title.rerender({ sessionId: 'elsewhere', useTabInfo: navigation({ botId: 'gone-bot' }) });
    expect(title.container.textContent).toBe(dictionary['botPanel.title']);
    await title.unmount();
    await app.unloadPlugin();
    expect(app.rightDefinitions.has(BOT_PANEL_ID)).toBe(false);
    expect(app.core.entries('sidebar.right.pane.tab').some(entry => entry.options.key === BOT_PANEL_ID)).toBe(false);
  });

  it('opens the header badge Bot beside the conversation, and keeps the Bots page as the fallback', async () => {
    const app = await mount();
    const open = opener(app, 'conversation.session.header.utilities', 'dsh-bot');
    // No on-screen Session in the right sidebar: the details page is the only place to show the Bot.
    open('beta-bot');
    expect(app.openRightTab).not.toHaveBeenCalled();
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
    await app.setRightSession('alpha-main');
    open('beta-bot');
    expect(app.openRightTab).toHaveBeenCalledExactlyOnceWith(BOT_PANEL_KIND, { params: { botId: 'beta-bot' } });
    expect(app.selectPanel).toHaveBeenCalledOnce();
    // The blank-session identity uses the same opener.
    opener(app, 'conversation.input.dock', 'dsh-bot-empty-identity')('alpha-bot');
    expect(app.openRightTab).toHaveBeenLastCalledWith(BOT_PANEL_KIND, { params: { botId: 'alpha-bot' } });
  });

  it('falls back to the Bots page when the right sidebar is not installed', async () => {
    const app = await mount('en', false);
    opener(app, 'conversation.session.header.utilities', 'dsh-bot')('beta-bot');
    expect(app.selectPanel).toHaveBeenCalledExactlyOnceWith('dsh-bot');
  });

  it.each(['en', 'zh'] as const)('shows another Bot with chat and settings actions, and the current Bot without a redundant open (%s)', async (language) => {
    const dictionary = language === 'zh' ? zh.ui : en.ui;
    const app = await mount(language);
    const panel = await app.mountEntry('sidebar.right.pane.tab', isPanel, { sessionId: 'alpha-main', useTabInfo: navigation({ botId: 'beta-bot' }) });
    const root = panel.container;
    expect(root.querySelector('[data-bot-panel="beta-bot"]')).not.toBeNull();
    expect(root.querySelector('h2')?.textContent).toBe('Beta');
    expect(root.textContent).toContain('Reviews notes');
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(dictionary['botPanel.overview']);
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
});

describe('Bot panel navigation', () => {
  const t = (key: string, params?: Record<string, unknown>) => ((en.ui as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name]));
  const entries: BotCatalogEntry[] = [{ bot: bot(), status: statuses[0] }, { bot: bot({ id: 'beta-bot', name: 'Beta' }), status: statuses[1] }];
  const snapshot = { entries, loaded: true, loading: false, pollIntervalMs: 1000 };
  function render(params: unknown, revision: number, sessionId = 'alpha-main') {
    const props = { sessionId, useTabInfo: navigation(params, revision), useCatalog: (select: (value: typeof snapshot) => unknown) => select(snapshot),
      onOpenSession: vi.fn(), onStart: vi.fn(async () => {}), onOpenSettings: vi.fn(), t } as unknown as BotRightPanelProps;
    return <BotRightPanel {...props} />;
  }
  it('resolves the named Bot, the Session\'s own Bot for a restored tab, and nothing for an unknown Bot', () => {
    expect(panelEntry(entries, 'alpha-main', { botId: 'beta-bot' })?.bot.id).toBe('beta-bot');
    expect(panelEntry(entries, 'beta-main', undefined)?.bot.id).toBe('beta-bot');
    expect(panelEntry(entries, 'alpha-main', { botId: 'gone' })).toBeUndefined();
    expect(panelEntry(entries, 'unrelated', undefined)).toBeUndefined();
  });
  it('opens a requested section and resets the view on every navigation, even to the same Bot', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const selected = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    try {
      await act(async () => root.render(render({ botId: 'beta-bot', section: 'messages' }, 1)));
      expect(selected()).toBe(t('botPanel.messages'));
      await click(button(container, t('botPanel.tasks')));
      expect(selected()).toBe(t('botPanel.tasks'));
      // A refresh without navigation keeps the reader's place.
      await act(async () => root.render(render({ botId: 'beta-bot', section: 'messages' }, 1)));
      expect(selected()).toBe(t('botPanel.tasks'));
      await act(async () => root.render(render({ botId: 'beta-bot', section: 'messages' }, 2)));
      expect(selected()).toBe(t('botPanel.messages'));
      await act(async () => root.render(render({ botId: 'alpha-bot' }, 3)));
      expect(selected()).toBe(t('botPanel.overview'));
      await act(async () => root.render(render({ botId: 'gone-bot' }, 4)));
      expect(container.textContent).toContain(t('botPanel.missing'));
      await act(async () => root.render(render(undefined, 0, 'unrelated')));
      expect(container.textContent).toContain(t('botPanel.empty'));
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});
