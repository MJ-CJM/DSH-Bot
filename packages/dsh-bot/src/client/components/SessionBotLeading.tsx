import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { BotCatalog } from '../state.js';
import type { ActivityCatalog } from '../activity-state.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/session-row.module.css';
import css from '../styles/session-row.module.css?inline';

export interface SessionBotRowInjected {
  hooks: {
    catalog: Pick<BotCatalog, 'getSnapshot' | 'subscribe'>;
    activity: Pick<ActivityCatalog, 'getSnapshot' | 'subscribe'>;
  };
}

export type SessionBotRowProps = Pick<PropsRuntime<'sidebar.session.row.leading'>, 'sessionId'>
  & PropsLocale<'dsh-bot'> & InjectFace<SessionBotRowInjected>;

function useRowBot({ sessionId, useCatalog, useActivity }: SessionBotRowProps) {
  const catalog = useCatalog((value) => value);
  const activity = useActivity((value) => value);
  // A retained success snapshot remains usable during a routine refresh. Never
  // guess from a preset prefix, a session title, or an unresolved first read.
  if (!catalog.loaded || !activity.loaded) return undefined;
  const botId = activity.sessions.find((row) => row.sessionId === sessionId)?.botId;
  return botId === undefined ? undefined : catalog.entries.find((entry) => entry.bot.id === botId)?.bot;
}

/** Root-scoped decoration: reading the two shared catalogs retains no Session. */
export function SessionBotLeading(props: SessionBotRowProps) {
  const bot = useRowBot(props);
  if (!bot) return null;
  return <>
    <style data-dsh-bot-row-styles>{css}</style>
    {/* Like the native schedule mark, this decoration only shields its area
        from row activation. It performs no action and adds no keyboard stop. */}
    {/* biome-ignore lint/a11y/noStaticElementInteractions: non-action decoration only stops propagation */}
    {/* biome-ignore lint/a11y/useKeyWithClickEvents: no action to expose to the keyboard; the native row owns navigation */}
    <span className={styles.leading} data-bot-session-leading="" data-session-id={props.sessionId}
      onClick={(event) => event.stopPropagation()}>
      <BotAvatar bot={bot} size={16} label={props.t('row.bot', { name: bot.name })} />
    </span>
  </>;
}

/** Also identifies a Bot when the native status dot or schedule owns leading. */
export function SessionBotHover(props: SessionBotRowProps) {
  const bot = useRowBot(props);
  if (!bot) return null;
  return <span data-bot-session-hover="" style={{
    display: 'block', padding: '4px 6px', borderRadius: 4, fontSize: 12, lineHeight: '16px',
    overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
  }}>{props.t('row.bot', { name: bot.name })}</span>;
}
