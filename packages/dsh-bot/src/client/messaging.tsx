import css from './styles/messages.module.css?inline';
import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface';
import { useState } from 'react';
import { messageSourceSchema, type MessageSource } from '../shared/messaging.js';
import { BotAvatar } from './components/BotAvatar.js';
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
      location: c.start?.location ?? { kind: 'unresolved' }, visibility: 'visible', data: c.state };
  },
};
export function MessageCard({ node, t, onShowStatus }: { node: ChatNode<'dsh-bot-message'>; onShowStatus?(botId: string): void } & PropsLocale<'dsh-bot'>) {
  const [open, setOpen] = useState(false);
  const { source: s, text, time } = node.data;
  const content = messageText(text, s);
  const sent = s.kind === 'dsh-bot-message-sent', peer = sent ? s.to : s.from;
  const display = sent ? s.displaySnapshots.to : s.displaySnapshots.from;
  return <article className={styles.card} data-bot-message={s.messageId} data-message-direction={sent ? 'sent' : 'received'}>
    <style>{css}</style>
    <button type="button" aria-expanded={open} className={styles.summary} onClick={() => setOpen(!open)}>
      <BotAvatar bot={{ id: peer.botId, ...display }} size={28} />
      <span>{t(sent ? 'messages.to' : 'messages.from')} {display.name} ({peer.botId}) · {t(`messages.${s.mode}`)}</span>
      <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleTimeString(t('activity.locale'))}</time>
      {s.priority === 'interrupt' && <span>{t('messages.interrupt')}</span>}
      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
    </button>
    {open && <div className={styles.body}><p>{t('messages.data')}</p><pre>{content}</pre>
      <small>{t('messages.thread')}: {s.threadId}{s.replyTo ? ` · replyTo: ${s.replyTo}` : ''}</small>
      {onShowStatus && <button type="button" onClick={() => onShowStatus(sent ? s.from.botId : s.to.botId)}>{t('messages.status')}</button>}</div>}
  </article>;
}
export function registerMessaging(ctx: Context, onShowStatus?: (botId: string) => void) {
  if (!ctx.get('uiConversation')) return;
  ctx.effect(() => ctx.uiConversation.events.register(messageDefinition), 'dsh-bot: message definition');
  ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'dsh-bot-message', locale: 'dsh-bot',
  }, (props: PropsRuntime<'conversation.chat.node', 'dsh-bot-message'> & PropsLocale<'dsh-bot'>) => <MessageCard {...props} onShowStatus={onShowStatus} />)), 'dsh-bot: message renderer');
}
