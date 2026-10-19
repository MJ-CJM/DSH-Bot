import type { Context } from '@deepseek-ai/cordis';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useState } from 'react';
import { BotsRightTab, type BotsRightTabInjected } from './components/BotsRightTab.js';

export const BOTS_TAB_ID = 'dsh-bot.right-bots';
export const BOTS_TAB_KIND = 'dsh-bot-bots';

interface OpenerInjected {
  hooks: {
    rightSession: ISidebarRight['mounted'];
    requestedTab: ObservableSnapshot<SessionId | undefined>;
  };
  onOpen(): void;
  onArrive(id: SessionId): void;
}

function BotsRightOpener({ sessionId, useRightSession, useRequestedTab, onOpen, onArrive, t }:
  Pick<PropsRuntime<'conversation.session.header.utilities'>, 'sessionId'> & InjectFace<OpenerInjected> & PropsLocale<'dsh-bot'>) {
  const mounted = useRightSession((value) => value);
  const requested = useRequestedTab((value) => value);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    // The public mounted source changes before React commits. At this header's
    // effect the arriving session's sidebar store has been minted by its seat.
    if (requested !== sessionId || mounted !== sessionId) return;
    try { onArrive(sessionId); setFailed(false); }
    catch { setFailed(true); }
  }, [mounted, requested, sessionId, onArrive]);
  if (mounted !== sessionId) return null;
  return <span>
    <Button variant="ghost" size="sm" aria-label={t('rightTab.open')} title={t('rightTab.open')}
      onClick={() => { try { onOpen(); setFailed(false); } catch { setFailed(true); } }}>{t('rightTab.title')}</Button>
    {failed && <span role="alert">{t('rightTab.openError')}</span>}
  </span>;
}

function BotsRightTitle({ t }: PropsLocale<'dsh-bot'>) { return <>{t('rightTab.title')}</>; }

/** Optional child scope keeps the existing Bots surfaces usable in minimal
 * compositions. The standard Client manifest orders the sidebar owner first. */
export function registerBotsRightTab(ctx: Context, actions: BotsRightTabInjected,
  navigate: {
    open(id: string, beforeOpen: (id: SessionId) => void, signal?: AbortSignal): Promise<void>;
    start(id: string, signal: AbortSignal | undefined, beforeOpen: (id: SessionId) => void): Promise<void>;
    startInWorkspace(id: string, workspaceId: string, signal: AbortSignal | undefined, beforeOpen: (id: SessionId) => void): Promise<void>;
  }): void {
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    const t = scope.locale.bind('dsh-bot');
    // Same small observable contract as the existing detail-navigation source;
    // no platform runtime import is needed for this one-shot request.
    let request: SessionId | undefined;
    let requestVersion = 0;
    const listeners = new Set<() => void>();
    const requested = {
      getSnapshot: () => request,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      set(value: SessionId | undefined) {
        requestVersion++;
        request = value;
        for (const listener of listeners) listener();
      },
    };
    let active = true;
    const following = async (navigate: (beforeOpen: (id: SessionId) => void) => Promise<void>) => {
      if (!active) return;
      let ticket: number | undefined;
      try {
        await navigate((id) => {
          if (!active) return;
          requested.set(id);
          ticket = requestVersion;
        });
      } catch (error) {
        if (ticket === requestVersion) requested.set(undefined);
        throw error;
      }
    };
    const open = () => { if (active) scope.sidebarRight.openTab(BOTS_TAB_KIND); };
    scope.effect(() => {
      const release = scope.sidebarRight.mounted.subscribe(() => {
        const target = requested.getSnapshot();
        // A different navigation supersedes this one-shot continuation.
        if (target && scope.sidebarRight.mounted.getSnapshot() !== target) requested.set(undefined);
      });
      return () => { active = false; requested.set(undefined); listeners.clear(); release(); };
    }, 'dsh-bot: right tab navigation lifetime');
    scope.effect(() => scope.sidebarRightTabs.register({
      id: BOTS_TAB_ID, kind: BOTS_TAB_KIND,
      title: () => t('rightTab.title'),
      guide: [{ id: 'bots', order: 40, title: () => t('rightTab.title'), description: () => t('rightTab.description') }],
    }), 'dsh-bot: right tab type');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BOTS_TAB_ID, locale: 'dsh-bot',
      inject: (): BotsRightTabInjected => ({
        ...actions,
        onOpenSession: (id, signal) => following((follow) => navigate.open(id, follow, signal)),
        onStart: (id, signal) => following((follow) => navigate.start(id, signal, follow)),
        onStartInWorkspace: (id, workspaceId, signal) => following((follow) => navigate.startInWorkspace(id, workspaceId, signal, follow)),
      }),
    }, BotsRightTab)), 'dsh-bot: right tab body');
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: BOTS_TAB_ID, locale: 'dsh-bot',
    }, BotsRightTitle)), 'dsh-bot: right tab title');
    // Blank sessions hide the header; the public Hero options seat keeps the
    // same opener and post-commit continuation available before the first turn.
    for (const name of ['conversation.session.header.utilities', 'conversation.hero.options'] as const) {
      scope.effect(() => scope.slots.inject(name, () => scope.slots.register({
        name, id: 'dsh-bot-right-tab', order: 30, locale: 'dsh-bot',
        inject: (): OpenerInjected => ({
          hooks: { rightSession: scope.sidebarRight.mounted, requestedTab: requested }, onOpen: open,
          onArrive: (id) => {
            if (!active || requested.getSnapshot() !== id || scope.sidebarRight.mounted.getSnapshot() !== id) return;
            requested.set(undefined);
            open();
          },
        }),
      }, BotsRightOpener)), 'dsh-bot: right tab opener');
    }
  });
}
