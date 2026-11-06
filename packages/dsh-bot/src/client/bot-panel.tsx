import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import {
  BOT_PANEL_ID,
  BOT_PANEL_KIND,
  BotPanelTitle,
  BotPreview,
  BotRightPanel,
  type BotPanelSection,
  type BotPreviewInjected,
  type BotPreviewState,
  type BotRightPanelInjected,
} from './components/BotRightPanel.js';

export interface BotPanelOpener {
  /**
   * Show a compact native preview without resizing the conversation.
   * @returns false when the preview cannot be shown, so the caller keeps its fallback.
   */
  open(botId: string, section?: BotPanelSection): boolean;
}

/** One page type per pane: opening another Bot navigates the same tab with new parameters. */
export function registerBotPanel(ctx: Context, actions: BotRightPanelInjected): BotPanelOpener {
  let ready = false;
  let previewReady = false;
  let preview: BotPreviewState | undefined;
  let revision = 0;
  const listeners = new Set<() => void>();
  const source = {
    getSnapshot: () => preview,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const update = (value?: BotPreviewState) => {
    preview = value;
    for (const listener of listeners) listener();
  };
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => {
    const release = ctx.slots.register({
      name: 'shell.overlay', id: 'dsh-bot-preview', locale: 'dsh-bot',
      inject: (): BotPreviewInjected => ({
        ...actions,
        hooks: { ...actions.hooks, preview: source },
        onClose: () => update(),
        onOpenSettings: id => { update(); actions.onOpenSettings(id); },
        onOpenSession: async id => {
          const current = preview;
          await actions.onOpenSession(id);
          if (preview === current) update();
        },
        onStart: async id => {
          const current = preview;
          await actions.onStart(id);
          if (preview === current) update();
        },
        onOpenInSidebar: section => {
          const sidebar = ctx.get('sidebarRight');
          if (!preview || !ready || sidebar?.mounted.getSnapshot() !== preview.sessionId) return;
          sidebar.openTab(BOT_PANEL_KIND, { params: { botId: preview.botId, section } });
          update();
        },
      }),
    }, BotPreview);
    previewReady = true;
    return () => { previewReady = false; update(); release(); };
  }), 'dsh-bot: compact Bot preview');
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const t = scope.locale.bind('dsh-bot');
    scope.effect(() => {
      const release = scope.sidebarRightTabs.register({ id: BOT_PANEL_ID, kind: BOT_PANEL_KIND, title: () => t('botPanel.title') });
      ready = true;
      return () => { ready = false; release(); };
    }, 'dsh-bot: bot panel type');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BOT_PANEL_ID, locale: 'dsh-bot', inject: (): BotRightPanelInjected => actions,
    }, BotRightPanel)), 'dsh-bot: bot panel body');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: BOT_PANEL_ID, locale: 'dsh-bot', inject: () => ({ hooks: actions.hooks }),
    }, BotPanelTitle)), 'dsh-bot: bot panel title');
    scope.effect(() => scope.sidebarRight.mounted.subscribe(() => {
      if (preview && scope.sidebarRight.mounted.getSnapshot() !== preview.sessionId) update();
    }), 'dsh-bot: close preview on conversation change');
    scope.effect(() => () => update(), 'dsh-bot: release preview');
  });
  return {
    open(botId, section) {
      const sidebar = ctx.get('sidebarRight');
      const sessionId = sidebar?.mounted.getSnapshot();
      if (!ready || !previewReady || sessionId === undefined) return false;
      update({ botId, sessionId, section, revision: ++revision });
      return true;
    },
  };
}
