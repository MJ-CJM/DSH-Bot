import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import {
  BOT_PANEL_ID,
  BOT_PANEL_KIND,
  BotPanelTitle,
  BotRightPanel,
  type BotPanelSection,
  type BotRightPanelInjected,
} from './components/BotRightPanel.js';

export interface BotPanelOpener {
  /**
   * Show a Bot's details in the on-screen Session's native right sidebar.
   * @returns false when no right sidebar can show it, so the caller keeps its fallback.
   */
  open(botId: string, section?: BotPanelSection): boolean;
}

/** One page type per pane: opening another Bot navigates the same tab with new parameters. */
export function registerBotPanel(ctx: Context, actions: BotRightPanelInjected): BotPanelOpener {
  let ready = false;
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
  });
  return {
    open(botId, section) {
      const sidebar = ctx.get('sidebarRight');
      // The right sidebar acts on the on-screen Session; without one there is nowhere to show the page.
      if (!ready || !sidebar || sidebar.mounted.getSnapshot() === undefined) return false;
      sidebar.openTab(BOT_PANEL_KIND, { params: section ? { botId, section } : { botId } });
      return true;
    },
  };
}
