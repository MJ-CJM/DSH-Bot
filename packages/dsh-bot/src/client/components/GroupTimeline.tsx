/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: The scrollable log must be reachable for keyboard users. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupView } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';
type Message = GroupView['messages'][number];
type Turn = GroupView['turns'][number];
function MessageCard({ message: m, t }: { message: Message } & PropsLocale<'dsh-bot'>) {
  return (
    <div className={styles.message} data-group-message={m.id}>
      <div className={styles.bar}>
        {m.speaker && (
          <BotAvatar
            bot={{
              id: m.speaker.bot.botId,
              avatar: m.speaker.avatar,
              avatarColor: m.speaker.avatarColor,
              avatarVariant: m.speaker.avatarVariant,
            }}
            size={32}
            label={m.speaker.name}
          />
        )}
        <strong>{m.speaker?.name ?? t('groups.you')}</strong>
        {m.speaker && (
          <small>
            {m.speaker.bot.botId} · {m.speaker.bot.botCreatedAt}
          </small>
        )}
        <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString()}</time>
      </div>
      <p>{m.text}</p>
      {m.hasNonText && <p>{t('groups.nonText')}</p>}
      {m.stopReason && m.stopReason !== 'completed' && (
        <p role="status">
          {t('groups.partial')} · {m.stopReason}
        </p>
      )}
    </div>
  );
}
/** One bounded, non-sticky log owns messages and their round records. Expansion
 * is keyed by immutable turn ID in the parent, independent of polling snapshots. */
export function GroupTimeline({
  view,
  messages,
  lookup,
  expanded,
  onExpand,
  busy,
  onCancel,
  onOpenSession,
  t,
}: {
  view: GroupView;
  messages: Message[];
  lookup(id: string): BotRecord | undefined;
  expanded: Record<string, boolean>;
  onExpand(id: string, open: boolean): void;
  busy: boolean;
  onCancel(turn: Turn): void;
  onOpenSession(id: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const latest = [...view.turns]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .at(-1)?.id;
  const turnForInput = new Map(view.turns.map((turn) => [turn.inputMessageId, turn]));
  const inputs = new Set(messages.filter((m) => !m.speaker).map((m) => m.id));
  const rounds = (turn: Turn) => {
    const open = expanded[turn.id] ?? turn.id === latest;
    const replies = messages.filter((m) => m.turnId === turn.id && m.speaker);
    return (
      <section key={turn.id} className={styles.turn} data-group-turn={turn.id} aria-label={t('groups.turns')}>
        <button
          type="button"
          className={styles.turnSummary}
          aria-expanded={open}
          onClick={() => onExpand(turn.id, !open)}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          {t('groups.turnSummary', {
            count: turn.orderedMemberIds.length,
            state: t(`groups.${turn.state}`),
          })}
        </button>
        <div hidden={!open}>
          {['accepted', 'running'].includes(turn.state) && (
            <button type="button" disabled={busy} onClick={() => onCancel(turn)}>
              {t('groups.cancelTurn')}
            </button>
          )}
          {view.deliveries
            .filter((d) => d.turnId === turn.id)
            .map((d) => (
              <div key={d.id} className={styles.delivery}>
                <span>
                  {lookup(d.memberId)?.name ?? d.bot.botId} · {t(`groups.${d.state}`)}{' '}
                  {d.reasonCode ? t('groups.failureHint') : ''}
                </span>
                {d.contextTruncated && <span>{t('groups.truncated')}</span>}
                {d.childSessionId && (
                  <button
                    type="button"
                    onClick={() => {
                      void onOpenSession(d.childSessionId ?? '');
                    }}
                  >
                    {t('groups.child')}
                  </button>
                )}
              </div>
            ))}
          {replies.map((m) => (
            <MessageCard key={m.id} message={m} t={t} />
          ))}
        </div>
      </section>
    );
  };
  return (
    <div
      className={styles.timeline}
      role="log"
      tabIndex={0}
      aria-label={t('groups.timeline')}
      aria-live="polite"
    >
      {messages.map((m) => {
        const turn = turnForInput.get(m.id);
        // A paginated page may contain replies whose input is on an earlier page.
        const parent = view.turns.find((turn) => turn.id === m.turnId);
        if (m.speaker && parent) {
          if (inputs.has(parent.inputMessageId)) return null;
          return messages.find((row) => row.turnId === parent.id)?.id === m.id ? rounds(parent) : null;
        }
        return (
          <div key={m.id}>
            <MessageCard message={m} t={t} />
            {turn && rounds(turn)}
          </div>
        );
      })}
      {view.turns.filter((turn) => !messages.some((m) => m.turnId === turn.id)).map(rounds)}
    </div>
  );
}
