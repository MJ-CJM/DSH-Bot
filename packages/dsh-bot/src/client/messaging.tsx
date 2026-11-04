import css from './styles/messages.module.css?inline';
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatGroupTree, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { IconChevronDownOutlineRegular, IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { useId, useState } from 'react';
import { messageSourceSchema, type MessageSource } from '../shared/messaging.js';
import { BotAvatar, avatarColors, defaultAvatarColor } from './components/BotAvatar.js';
import styles from './styles/messages.module.css';
export interface MessageCardData { source: MessageSource; text: string; time: number; seq: number }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'dsh-bot-message': MessageCardData }
}
export function messageText(text: string, source: MessageSource): string {
  const marker = 'Content (JSON string): ';
  const raw = source.kind === 'dsh-bot-message' ? text.slice(text.lastIndexOf(marker) + marker.length) : text.slice(text.lastIndexOf('\n') + 1);
  try { const value: unknown = JSON.parse(raw); return typeof value === 'string' ? value : text; } catch { return text; }
}
/**
 * Native Chat folds nodes without a group-tree position into the step run, which
 * hides them behind a completed Turn's process disclosure. A received message
 * is the Turn's input, like a user message; the sender's own notice stays in its
 * Turn outside the process so the exchange remains visible after completion.
 */
export function messageGroupTree(source: MessageSource): ChatGroupTree {
  return source.kind === 'dsh-bot-message' ? 'input' : 'turn';
}
export const messageDefinition: ConversationNodeDefinition<MessageCardData> = {
  kind: 'dsh-bot-message', target: 'chat',
  match(event) {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event) || !messageSourceSchema.safeParse(event.data.source).success) return null;
    return { id: String(event.data.id), role: 'start', exclusive: true };
  },
  start(_context, match) {
    const e = match.event;
    if (e.type !== 'user/message') throw Error('Message event required');
    return { source: messageSourceSchema.parse(e.data.source), time: e.time, seq: e.seq,
      text: e.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') };
  },
  update: (c) => c.state,
  buildViewNode(c): ChatNode<'dsh-bot-message'> | null {
    if (!c.state) return null;
    return { key: c.key, id: c.id, kind: 'dsh-bot-message', target: 'chat', anchorSeq: c.state.seq,
      location: c.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', groupTree: messageGroupTree(c.state.source), data: c.state };
  },
};
type MessageLabel = 'messages.sentTo' | 'messages.repliedTo' | 'messages.receivedFrom' | 'messages.replyFrom';
export function messageLabel(source: MessageSource): MessageLabel {
  const sent = source.kind === 'dsh-bot-message-sent', reply = source.mode === 'reply';
  return sent ? (reply ? 'messages.repliedTo' : 'messages.sentTo') : (reply ? 'messages.replyFrom' : 'messages.receivedFrom');
}
export interface MessageCardActions {
  /** Open a Bot's details beside the conversation. */
  onOpenBot?(botId: string): void;
  /** Show this conversation's Bot with its delivery and reply status. */
  onShowStatus?(botId: string): void;
}
/** Centered marker for one teammate message; the content stays folded until asked for. */
export function MessageCard({ node, t, onOpenBot, onShowStatus }: { node: ChatNode<'dsh-bot-message'> } & MessageCardActions & PropsLocale<'dsh-bot'>) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { source: s, text, time } = node.data;
  const content = messageText(text, s);
  const sent = s.kind === 'dsh-bot-message-sent', peer = sent ? s.to : s.from;
  const display = sent ? s.displaySnapshots.to : s.displaySnapshots.from;
  const bot = { id: peer.botId, ...display };
  const color = avatarColors[display.avatarColor ?? defaultAvatarColor(peer.botId)].color;
  const name = <><BotAvatar bot={bot} size={18} /><span className={styles.chipName} style={{ color }}>{display.name}</span></>;
  const label = t('badge.open', { name: display.name });
  return <article className={styles.card} data-bot-message={s.messageId} data-message-direction={sent ? 'sent' : 'received'} data-message-mode={s.mode}>
    <style>{css}</style>
    <div className={styles.marker} data-bot-message-marker="">
      <span className={sent ? styles.direction : `${styles.direction} ${styles.received}`} aria-hidden="true"><IconRightUpOutlineRegular size={14} /></span>
      <span>{t(messageLabel(s))}</span>
      {onOpenBot
        ? <button type="button" className={styles.chip} data-bot-chip={peer.botId} aria-label={label} title={label} onClick={() => onOpenBot(peer.botId)}>{name}</button>
        : <span className={styles.chip} data-bot-chip={peer.botId}>{name}</span>}
      {s.mode !== 'reply' && <span className={styles.meta}>{t(`messages.${s.mode}`)}</span>}
      {s.priority === 'interrupt' && <span className={styles.meta}>{t('messages.interrupt')}</span>}
      <time className={styles.meta} dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString(t('activity.locale'), { hour: '2-digit', minute: '2-digit' })}</time>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen(!open)}>
        <span>{t(open ? 'messages.hideContent' : 'messages.showContent')}</span>
        <IconChevronDownOutlineRegular size={14} className={open ? styles.chevronOpen : undefined} />
      </button>
    </div>
    {open && <div id={bodyId} className={styles.body}>
      <p className={styles.content}>{content}</p>
      <p className={styles.caption}>{t('messages.data')}</p>
      <p className={styles.caption} title={`${s.threadId}${s.replyTo ? ` · replyTo: ${s.replyTo}` : ''}`} data-message-thread={s.threadId}>
        {t('messages.thread')}: {s.threadId.slice(0, 8)}{s.replyTo ? ` · replyTo: ${s.replyTo.slice(0, 8)}` : ''}
      </p>
      {onShowStatus && <button type="button" className={styles.link} onClick={() => onShowStatus(sent ? s.from.botId : s.to.botId)}>{t('messages.status')}</button>}
    </div>}
  </article>;
}
export function registerMessaging(ctx: Context, actions: MessageCardActions = {}) {
  ctx.inject(['uiConversation'], (scope) => {
    // Optional registry/slot support must never prevent the Bots workspace from booting.
    if (typeof scope.uiConversation.events?.register !== 'function') return;
    scope.effect(() => scope.slots.inject('conversation.chat.node', () => {
      try {
        // Claim messages only while a renderer is installed. Cordis rolls back
        // either registration if setup fails and owns both on slot/plugin unload.
        return scope.effect(function* () {
          yield scope.slots.register({
            name: 'conversation.chat.node', key: 'dsh-bot-message', locale: 'dsh-bot',
          }, (props: PropsRuntime<'conversation.chat.node', 'dsh-bot-message'> & PropsLocale<'dsh-bot'>) => <MessageCard {...props} {...actions} />);
          yield scope.uiConversation.events.register(messageDefinition);
        }, 'dsh-bot: message card');
      } catch {
        console.warn('DSH-Bot: message card unavailable; retaining native rendering');
        return () => {};
      }
    }), 'dsh-bot: message renderer');
  });
}
