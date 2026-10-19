import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotCatalog } from '../state.js';
import { BotAvatar } from './BotAvatar.js';

export interface SessionBotBadgeInjected {
  hooks: { catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'> };
  onOpenBot(id: string): void;
}

export type SessionBotBadgeProps =
  Pick<PropsRuntime<'conversation.session.header.utilities'>, 'sessionId' | 'useSessions'>
  & PropsLocale<'dsh-bot'>
  & InjectFace<SessionBotBadgeInjected>;

export function SessionBotBadge({ sessionId, useSessions, useCatalog, onOpenBot, t }: SessionBotBadgeProps) {
  // The public projection follows blank-session preset selection; the creation
  // header does not. The Host status is the authority for Bot/preset identity.
  const presetId = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset;
    return typeof value === 'string' ? value : undefined;
  });
  const snapshot = useCatalog((value) => value);
  const entry = presetId === undefined ? undefined
    : snapshot.entries.find((item) => item.status?.presetId === presetId);
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
