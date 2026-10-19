import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import { useEffect, useState } from 'react';
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotCatalog } from '../state.js';
import type { ActivityCatalog } from '../activity-state.js';
import { BotAvatar } from './BotAvatar.js';

export interface SessionBotBadgeInjected {
  hooks: {
    catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>;
    activity: Pick<ActivityCatalog, 'getSnapshot' | 'subscribe'>;
  };
  onMarkRead(id: string): Promise<void>;
  onOpenBot(id: string): void;
}

export type SessionBotBadgeProps =
  Pick<PropsRuntime<'conversation.session.header.utilities'>, 'sessionId' | 'useSessions' | 'usePanelInfo'>
  & PropsLocale<'dsh-bot'>
  & InjectFace<SessionBotBadgeInjected>;

export function SessionBotBadge({ sessionId, useSessions, usePanelInfo, useCatalog, useActivity, onMarkRead, onOpenBot, t }: SessionBotBadgeProps) {
  // The public projection follows blank-session preset selection; the creation
  // header does not. The Host status is the authority for Bot/preset identity.
  const presetId = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset;
    return typeof value === 'string' ? value : undefined;
  });
  const snapshot = useCatalog((value) => value);
  const entry = presetId === undefined ? undefined
    : snapshot.entries.find((item) => item.status?.presetId === presetId);
  const activity = useActivity((value) => value.sessions.find((item) => item.sessionId === sessionId));
  const mainPanel = usePanelInfo((value) => value.activePanelId === null);
  // The public mainView retention source is also how DSH's DocumentTitle
  // identifies the selected session. Header slots may appear in other views.
  const mainSession = useSessions((value) => (value.byId[sessionId]?.retainedBy.mainView ?? 0) > 0);
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const botId = entry?.bot.id;
  useEffect(() => {
    if (!botId || activity?.botId !== botId || !activity.unread || !mainPanel || !mainSession
      || !visible || document.visibilityState === 'hidden') return;
    // Failure retains unread state. A changed activity or visibility transition
    // retries; identical background data deliberately causes no React effect.
    void onMarkRead(sessionId).catch(() => {});
  }, [activity, botId, mainPanel, mainSession, onMarkRead, sessionId, visible]);
  if (!entry) {
    const prefix = snapshot.presetIdPrefix;
    const deleted = snapshot.loaded && !snapshot.loading && !snapshot.error
      && snapshot.entries.every((item) => item.status !== undefined)
      && prefix && presetId?.startsWith(prefix) && presetId.length > prefix.length;
    return deleted ? <span role="status" title={t('badge.deletedHint')} aria-label={t('badge.deletedHint')}
      style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: '0.875rem', padding: '0.25rem 0.5rem' }}>
      {t('badge.deleted')}
    </span> : null;
  }

  const { bot } = entry;
  const label = t('badge.open', { name: bot.name });
  return <button type="button" aria-label={label} title={label} onClick={() => onOpenBot(bot.id)}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.375rem', maxWidth: '14rem',
      padding: '0.25rem 0.5rem', borderRadius: '0.5rem', cursor: 'pointer', font: 'inherit',
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l3)',
    }}>
    <BotAvatar bot={bot} size={24} />
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bot.name}</span>
  </button>;
}
