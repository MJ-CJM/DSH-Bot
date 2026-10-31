/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: The scrollable log must be reachable for keyboard users. */
import { useMemo, useState } from 'react';
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupView } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';
import { BotAvatar } from './BotAvatar.js';
import styles from '../styles/groups.module.css';
type Message = GroupView['messages'][number];
type Turn = GroupView['turns'][number];
/** Compact plaintext context, never a second Markdown rendering surface. */
export function groupMessagePreview(text: string | undefined, limit = 180) {
  return (text ?? '').replace(/```[\s\S]*?```/g, '…').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}])([*_])(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, '$2').replace(/(?:^|\n)\s{0,3}(?:#{1,6}|>|[-*+])\s+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function GroupMessageCard({ message: m, quoted, quotedLoading = false, labels, onReply, onOpenSession, onOpenAttachment, onJump, t }: {
  message: Message; quoted?: Message; quotedLoading?: boolean; onJump?(id: string): void; labels: MarkdownLabels; onReply(message: Message): void;
  onOpenSession(id: string): Promise<void>;
  onOpenAttachment(messageId: string, attachmentId: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const [opening, setOpening] = useState(false), [openError, setOpenError] = useState(false);
  return (
    <div className={styles.message} data-group-message={m.id}>
      <div className={styles.bar}>
        {m.speaker && <BotAvatar bot={{ id: m.speaker.bot.botId, avatar: m.speaker.avatar,
          avatarColor: m.speaker.avatarColor, avatarVariant: m.speaker.avatarVariant }} size={28} label={m.speaker.name} />}
        <strong>{m.speaker?.name ?? t('groups.you')}</strong>
        <time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString()}</time>
        <button type="button" className={styles.replyAction} onClick={() => onReply(m)}>{t('groups.reply')}</button>
      </div>
      {quoted && <blockquote className={styles.quote}><button type="button" onClick={() => onJump?.(quoted.id)}>
        <strong>{quoted.speaker?.name ?? t('groups.you')}</strong> {groupMessagePreview(quoted.text)}</button>
      </blockquote>}
      {m.replyTo && !quoted && <p className={styles.quote}>{t(quotedLoading ? 'groups.quoteLoading' : 'groups.quoteUnavailable')}</p>}
      <MarkdownText text={m.text} labels={labels} />
      {Boolean(m.attachments?.length) && <ul className={styles.attachments} aria-label={t('groups.attachments')}>
        {[...new Map(m.attachments?.map(block => [`${block.type}:${block.attachment.attachmentId}`, block])).entries()].map(([id, block]) => <li key={id}>
          <span>{block.attachment.name ?? t('groups.image')} · {block.attachment.bytes.toLocaleString()} B</span>
          <button type="button" disabled={opening} onClick={() => {
            setOpening(true); setOpenError(false);
            void onOpenAttachment(m.id, block.attachment.attachmentId).catch(() => setOpenError(true)).finally(() => setOpening(false));
          }}>{t('groups.openAttachment', { name: block.attachment.name ?? t('groups.image') })}</button>
        </li>)}
        {m.childSessionId && <li><button type="button" onClick={() => { void onOpenSession(m.childSessionId ?? ''); }}>
          {t('groups.openArtifactSource')}
        </button></li>}
      </ul>}
      {openError && <p role="alert">{t('groups.attachmentUnavailable')}</p>}
      {m.hasNonText && <p>{t('groups.nonText')}</p>}
      {m.stopReason && ['error', 'aborted', 'max-tokens', 'refusal'].includes(m.stopReason) &&
        <p role="status">{t('groups.partial')} · {m.stopReason}</p>}
    </div>
  );
}
/** Messages are always flat and visible. Execution diagnostics have their own collapsed area;
 * expansion remains keyed by immutable turn id and is retained by the parent across polling. */
export function GroupTimeline({ view, messages, lookup, expanded, onExpand, busy, onCancel, onReply, onOpenSession, onOpenAttachment, t }: {
  view: GroupView; messages: Message[]; lookup(id: string): BotRecord | undefined;
  expanded: Record<string, boolean>; onExpand(id: string, open: boolean): void; busy: boolean;
  onCancel(turn: Turn): void; onReply(message: Message): void; onOpenSession(id: string): Promise<void>;
  onOpenAttachment(messageId: string, attachmentId: string): Promise<void>;
} & PropsLocale<'dsh-bot'>) {
  const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel: t('groups.markdownCopy'),
    copiedLabel: t('groups.markdownCopied') }, footnotes: t('groups.markdownFootnotes') }), [t]);
  const byId = new Map(messages.map(message => [message.id, message]));
  const active = view.turns.filter(turn => ['accepted', 'running'].includes(turn.state));
  return <>
    {active.length > 0 && <section className={styles.working} aria-label={t('groups.working')}>
      <strong role="status">{t('groups.working')}</strong>
      {active.map(turn => <div key={turn.id} className={styles.bar} data-group-working={turn.id}>
        <span>{byId.get(turn.inputMessageId)?.text.slice(0, 120) ?? t('groups.working')}</span>
        <button type="button" disabled={busy} onClick={() => onCancel(turn)}>{t('groups.cancelTurn')}</button>
      </div>)}
    </section>}
    <div className={styles.timeline} role="log" tabIndex={0} aria-label={t('groups.timeline')} aria-live="polite">
      {messages.map(message => <GroupMessageCard key={message.id} message={message}
        quoted={message.replyTo ? byId.get(message.replyTo) : undefined} labels={labels} onReply={onReply}
        onOpenSession={onOpenSession} onOpenAttachment={onOpenAttachment} t={t} />)}
    </div>
    {view.turns.length > 0 && <section className={styles.executions} aria-label={t('groups.executionDetails')}>
      <h4>{t('groups.executionDetails')}</h4>
      {view.turns.map(turn => {
        const open = expanded[turn.id] ?? false;
        return <section key={turn.id} className={styles.turn} data-group-turn={turn.id} aria-label={t('groups.turns')}>
          <button type="button" className={styles.turnSummary} aria-expanded={open} onClick={() => onExpand(turn.id, !open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            {t('groups.turnSummary', { count: turn.orderedMemberIds.length, state: t(`groups.${turn.state}`) })}
          </button>
          <div hidden={!open}>
            {view.deliveries.filter(delivery => delivery.turnId === turn.id).map(delivery => <div key={delivery.id} className={styles.delivery}>
              <span>{lookup(delivery.memberId)?.name ?? delivery.bot.botId} · {t(`groups.${delivery.state}`)}{' '}
                {delivery.reasonCode ? t('groups.failureHint') : ''}</span>
              {delivery.contextTruncated && <span>{t('groups.truncated')}</span>}
              {delivery.childSessionId && <button type="button" onClick={() => { void onOpenSession(delivery.childSessionId ?? ''); }}>{t('groups.child')}</button>}
            </div>)}
          </div>
        </section>;
      })}
    </section>}
  </>;
}
