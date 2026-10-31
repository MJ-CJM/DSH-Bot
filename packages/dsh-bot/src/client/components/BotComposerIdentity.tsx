import type { SessionBotBadgeProps } from './SessionBotBadge.js';
import { BotAvatar } from './BotAvatar.js';
import { FirstChatHint, type FirstChatActions } from './FirstChatHint.js';

/** The native blank Session has no conversation header. Its public input dock
 * keeps Bot identity and recovery visible beside the unchanged native editor. */
export function BotComposerIdentity(props: SessionBotBadgeProps & FirstChatActions) {
  const blank = props.useSessions(snapshot => snapshot.byId[props.sessionId]?.blank === true);
  const entry = props.useCatalog(snapshot => snapshot.entries.find(row => row.status?.mainSessionId === props.sessionId));
  if (!blank || !entry) return null;
  return <section data-bot-composer-identity={entry.bot.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0', minWidth: 0 }}>
    <button type="button" onClick={() => props.onOpenBot(entry.bot.id)} aria-label={props.t('badge.open', { name: entry.bot.name })}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', border: 0, padding: 0, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'transparent', font: 'inherit', maxWidth: '100%', minWidth: 0 }}>
      <BotAvatar bot={entry.bot} size={24} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.bot.name}</span>
    </button>
    <FirstChatHint {...props} />
  </section>;
}
