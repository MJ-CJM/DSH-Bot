/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: The scrollable log must be reachable for keyboard users. */
import { useMemo, useState } from 'react';
import { ImageLightbox, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupAttachment, GroupMember, GroupView } from '../../shared/groups.js';
import { groupExportReviewStatus } from '../../shared/group-export-review.js';
import type { BotRecord } from '../../shared/schema.js';
import { BotAvatar } from './BotAvatar.js';
import { groupFailureCode, groupStopText } from '../group-failure.js';
import { groupMemoryWriteCounts } from '../group-management.js';
import styles from '../styles/groups.module.css';
import type { GroupActions } from '../groups-state.js';
import { exportStatusKey, turnExportStatus } from './GroupExportReview.js';
import { GroupExportQueueLink } from './GroupExportQueue.js';
type Message = GroupView['messages'][number];
type Turn = GroupView['turns'][number];
/** Compact plaintext context, never a second Markdown rendering surface. */
export function groupMessagePreview(text: string | undefined, limit = 180) {
  return (text ?? '').replace(/```[\s\S]*?```/g, '…').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}])([*_])(\S(?:.*?\S)?)\1(?![\p{L}\p{N}])/gu, '$2').replace(/(?:^|\n)\s{0,3}(?:#{1,6}|>|[-*+])\s+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
/** Membership is an authoritative fact, not a fabricated chat message. Host
 * GroupMembers.create uses one timestamp for the group and its initial roster;
 * edit preserves that timestamp for retained members. This bounded projection
 * only anchors later admissions within the available Host message window. */
export function memberJoinsForMessage(view: GroupView, message: Message, position: 'before' | 'after'): GroupMember[] {
  const messages = [...view.messages].sort((a, b) => a.seq - b.seq);
  if (!messages.some(row => row.id === message.id)) return [];
  return view.members.filter(member => {
    if (member.joinedAt <= view.group.createdAt) return false;
    // A paged-out earlier admission must not move into the current window.
    if (view.hasEarlier && member.joinedAt < (messages[0]?.at ?? 0)) return false;
    const anchor = messages.find(row => row.at >= member.joinedAt) ?? messages.at(-1);
    return anchor?.id === message.id && (member.joinedAt <= anchor.at ? position === 'before' : position === 'after');
  }).sort((a, b) => a.joinedAt - b.joinedAt || a.order - b.order);
}
export function GroupMemberJoins({ view, message, bots, position, t }: {
  view: GroupView; message: Message; bots: readonly BotRecord[]; position: 'before' | 'after';
} & PropsLocale<'dsh-bot'>) {
  return <>{memberJoinsForMessage(view, message, position).map(member => {
    const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
    const speaker = view.messages.find(row => row.speaker?.bot.botId === member.bot.botId && row.speaker.bot.botCreatedAt === member.bot.botCreatedAt)?.speaker;
    const name = bot?.name ?? speaker?.name ?? member.bot.botId;
    return <div className={styles.memberJoin} key={member.id} data-group-member-joined={member.id}>
      <BotAvatar size={18} bot={bot ?? { id: member.bot.botId, avatar: speaker?.avatar, avatarColor: speaker?.avatarColor, avatarVariant: speaker?.avatarVariant }} />
      <span>{t('groups.memberJoined', { name })}</span><time dateTime={new Date(member.joinedAt).toISOString()}>{new Date(member.joinedAt).toLocaleTimeString(t('activity.locale'), { hour: '2-digit', minute: '2-digit' })}</time>
    </div>;
  })}</>;
}
export function GroupMessageCard({ message: m, quoted, quotedLoading = false, sourceLabel, labels, onReply, onOpenSession, onOpenAttachment, onPreviewAttachment, onJump, t }: {
  message: Message; quoted?: Message; quotedLoading?: boolean; onJump?(id: string): void; labels: MarkdownLabels; onReply(message: Message): void;
  sourceLabel?: string;
  onOpenSession(id: string): Promise<void>;
  onOpenAttachment(messageId: string, attachmentId: string): Promise<void>;
  onPreviewAttachment?(messageId: string, attachment: GroupAttachment['attachment']): Promise<string>;
} & PropsLocale<'dsh-bot'>) {
  const [opening, setOpening] = useState(false), [openError, setOpenError] = useState(false);
  const [preview, setPreview] = useState<{ src: string; alt: string }>();
  // The checked worker bridge marks an expert tool request separately from
  // ordinary discussion. Never infer execution records from JSON-shaped text.
  const expertRequest = m.authorKind === 'bot' && m.stopReason === 'expert-request' && m.causeId?.startsWith('expert-request:');
  const proactiveSource = sourceLabel ?? t('proactive.groupSource');
  return (
    <div className={`${styles.message} ${m.authorKind === 'user' ? styles.userMessage : styles.botMessage}`} data-group-message={m.id} data-group-author={m.authorKind}>
      <div className={`${styles.bar} ${styles.messageHeader}`}>
        {m.speaker && <BotAvatar bot={{ id: m.speaker.bot.botId, avatar: m.speaker.avatar,
          avatarColor: m.speaker.avatarColor, avatarVariant: m.speaker.avatarVariant }} size={28} label={m.speaker.name} />}
        <strong className={styles.messageAuthor} title={m.speaker?.name}>{m.speaker?.name ?? (m.authorKind === 'proactive' ? proactiveSource : t('groups.you'))}</strong>
        <time dateTime={new Date(m.at).toISOString()} title={new Date(m.at).toLocaleString(t('activity.locale'))}>{new Date(m.at).toLocaleTimeString(t('activity.locale'), { hour: '2-digit', minute: '2-digit' })}</time>
        <button type="button" className={styles.replyAction} onClick={() => onReply(m)}>{t('groups.reply')}</button>
      </div>
      <div className={styles.messageContent}>
      {quoted && <blockquote className={styles.quote}><button type="button" onClick={() => onJump?.(quoted.id)}>
        <strong>{quoted.speaker?.name ?? (quoted.authorKind === 'proactive' ? proactiveSource : t('groups.you'))}</strong> {groupMessagePreview(quoted.text)}</button>
      </blockquote>}
      {m.replyTo && !quoted && <p className={styles.quote}>{t(quotedLoading ? 'groups.quoteLoading' : 'groups.quoteUnavailable')}</p>}
      {expertRequest ? <details className={styles.executionMeta} data-group-expert-request={m.id}>
        <summary>{t('groups.expertRequest')}</summary><pre><code>{m.text}</code></pre>
      </details> : <MarkdownText text={m.text} labels={labels} />}
      {Boolean(m.attachments?.length) && <ul className={styles.attachments} aria-label={t('groups.attachments')}>
        {[...new Map(m.attachments?.map(block => [`${block.type}:${block.attachment.attachmentId}`, block])).entries()].map(([id, block]) => <li key={id}>
          <span>{block.attachment.name ?? t('groups.image')} · {block.attachment.bytes.toLocaleString()} B</span>
          <button type="button" disabled={opening} onClick={() => {
            setOpening(true); setOpenError(false);
            const action = block.type === 'image' && onPreviewAttachment
              ? onPreviewAttachment(m.id, block.attachment).then(src => { if (src) setPreview({ src, alt: block.attachment.name ?? t('groups.image') }); })
              : onOpenAttachment(m.id, block.attachment.attachmentId);
            void action.catch(() => setOpenError(true)).finally(() => setOpening(false));
          }}>{t('groups.openAttachment', { name: block.attachment.name ?? t('groups.image') })}</button>
        </li>)}
        {m.childSessionId && <li><button type="button" onClick={() => { void onOpenSession(m.childSessionId ?? ''); }}>
          {t('groups.openArtifactSource')}
        </button></li>}
      </ul>}
      {openError && <p role="alert">{t('groups.attachmentUnavailable')}</p>}
      {m.hasNonText && <p>{t('groups.nonText')}</p>}
      {m.stopReason && ['error', 'aborted', 'max-tokens', 'refusal'].includes(m.stopReason) &&
        <p role="status" className={styles.stopStatus} data-group-stop={m.stopReason}>
          {t('groups.partial')} · {groupStopText(m.stopReason, m.failure, t)}
          {m.failure && groupFailureCode(m.failure) && <span className={styles.failureCode}>{groupFailureCode(m.failure)}</span>}
          {m.failure?.requestId && <span>{t('groups.failureRequestId')} <code className={styles.failureRequestId}>{m.failure.requestId}</code></span>}
        </p>}
      </div>
      {preview && <ImageLightbox src={preview.src} alt={preview.alt}
        labels={{ dialog: t('groups.imagePreview'), close: t('actions.close') }} onClose={() => setPreview(undefined)} />}
    </div>
  );
}
/** Messages are always flat and visible. Execution diagnostics have their own collapsed area;
 * expansion remains keyed by immutable turn id and is retained by the parent across polling. */
export function GroupTimeline({ view, messages, lookup, expanded, onExpand, busy, onCancel, onReply, onOpenSession, onOpenAttachment, onPreviewAttachment, actions, t }: {
  actions?: GroupActions;
  view: GroupView; messages: Message[]; lookup(id: string): BotRecord | undefined;
  expanded: Record<string, boolean>; onExpand(id: string, open: boolean): void; busy: boolean;
  onCancel(turn: Turn): void; onReply(message: Message): void; onOpenSession(id: string): Promise<void>;
  onOpenAttachment(messageId: string, attachmentId: string): Promise<void>;
  onPreviewAttachment?(messageId: string, attachment: GroupAttachment['attachment']): Promise<string>;
} & PropsLocale<'dsh-bot'>) {
  const labels = useMemo<MarkdownLabels>(() => ({ code: { copyLabel: t('groups.markdownCopy'),
    copiedLabel: t('groups.markdownCopied') }, footnotes: t('groups.markdownFootnotes') }), [t]);
  const byId = new Map(messages.map(message => [message.id, message]));
  const memberBots = view.members.flatMap(member => { const bot = lookup(member.id); return bot ? [bot] : []; });
  const sourceLabel = view.group.supergroup ? t('groups.collaborationSource') : undefined;
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
      {messages.map(message => <div key={message.id}>
        <GroupMemberJoins view={view} message={message} bots={memberBots} position="before" t={t} />
        <GroupMessageCard message={message} sourceLabel={sourceLabel}
        quoted={message.replyTo ? byId.get(message.replyTo) : undefined} labels={labels} onReply={onReply}
        onOpenSession={onOpenSession} onOpenAttachment={onOpenAttachment} onPreviewAttachment={onPreviewAttachment} t={t} />
        <GroupMemberJoins view={view} message={message} bots={memberBots} position="after" t={t} />
      </div>)}
    </div>
    {view.turns.length > 0 && <section className={styles.executions} aria-label={t('groups.executionDetails')}>
      <h4>{t('groups.executionDetails')}</h4>
      {view.turns.map(turn => {
        const open = expanded[turn.id] ?? false;
        const deliveries = view.deliveries.filter(delivery => delivery.turnId === turn.id);
        const exportState = turnExportStatus(view.group, turn, deliveries);
        return <section key={turn.id} className={styles.turn} data-group-turn={turn.id} aria-label={t('groups.turns')}>
          <button type="button" className={styles.turnSummary} aria-expanded={open} onClick={() => onExpand(turn.id, !open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            {t('groups.turnSummary', { count: turn.orderedMemberIds.length, state: t(exportState ?? `groups.${turn.state}`) })}
          </button>
          {turn.memoryStatusOnly && <p role="status">{t('groups.memoryStatus.summary', groupMemoryWriteCounts(deliveries))}</p>}
          <div hidden={!open}>
            {deliveries.map(delivery => {
              const exportStatus = exportStatusKey(view.group, turn, delivery);
              const review = groupExportReviewStatus(view.group, turn, delivery);
              return <div key={delivery.id} className={styles.delivery}>
              <span>{lookup(delivery.memberId)?.name ?? delivery.bot.botId} · {t(exportStatus ?? `groups.${delivery.state}`)}{' '}
                {delivery.reasonCode && !exportStatus ? t('groups.failureHint') : ''}</span>
              {turn.memoryStatusOnly && <span>{t(`groups.memoryStatus.${delivery.memoryWriteStatus ?? 'unverified'}`)}</span>}
              {delivery.failure?.requestId && <span>{t('groups.failureRequestId')} <code className={styles.failureRequestId}>{delivery.failure.requestId}</code></span>}
              {actions && review === 'pending' && <GroupExportQueueLink view={view} actions={actions} t={t} />}
              {delivery.contextTruncated && <span>{t('groups.truncated')}</span>}
              {delivery.childSessionId && <button type="button" onClick={() => { void onOpenSession(delivery.childSessionId ?? ''); }}>{t('groups.child')}</button>}
            </div>})}
            {actions && exportState === 'groups.export.expiredStatus' && <GroupExportQueueLink view={view} actions={actions} stale t={t} />}
          </div>
        </section>;
      })}
    </section>}
  </>;
}
