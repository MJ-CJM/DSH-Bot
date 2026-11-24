import { useLayoutEffect, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { GroupMessage, GroupView } from '../../shared/groups.js';
import { isLongGroupReply } from '../group-reply-preview.js';
import type { RoundReplyFolds } from '../group-reply-folds.js';
import styles from '../styles/groups.module.css';

const noSubscription = () => () => {};
function publishedReply(message: GroupMessage) {
  return message.authorKind === 'bot' || (!message.authorKind && Boolean(message.speaker));
}

export function useGroupReplyFold(round: RoundReplyFolds | undefined, message: GroupMessage, autoFold: boolean) {
  const defaultOpen = !autoFold || !isLongGroupReply(message);
  const published = publishedReply(message);
  const { id, seq } = message;
  useLayoutEffect(() => {
    if (published) round?.observe(id, seq, defaultOpen);
  }, [round, published, id, seq, defaultOpen]);
  const expanded = useSyncExternalStore(round?.subscribe ?? noSubscription, () => round?.expanded(id, seq, defaultOpen, published) ?? true);
  return round ? { expanded, toggle: () => round.toggle(id, seq, defaultOpen, published) } : undefined;
}

export function GroupReplyTools({ round, turnId, messages, deliveries, autoFold, t }: {
  round: RoundReplyFolds; autoFold: boolean; turnId: string; messages: readonly GroupMessage[]; deliveries: GroupView['deliveries'];
} & PropsLocale<'dsh-bot'>) {
  useLayoutEffect(() => {
    // Also include published replies outside the host's currently mounted chat rows.
    for (const message of messages) {
      if (message.turnId === turnId && publishedReply(message)) round.observe(message.id, message.seq, !autoFold || !isLongGroupReply(message));
    }
  }, [round, turnId, messages, autoFold]);
  useSyncExternalStore(round.subscribe, round.getRevision);
  let allOpen = true, through = -1;
  for (const [id, reply] of round.replies) {
    if (!round.expanded(id, reply.seq, reply.defaultOpen, true)) allOpen = false;
    through = Math.max(through, reply.seq);
  }
  const publishedIds = new Set(round.replies.keys());
  // The view pages message bodies, but includes committed output receipts for all turns.
  for (const row of deliveries) {
    if (row.turnId === turnId && row.outputMessageId && row.outputSeq !== undefined) {
      publishedIds.add(row.outputMessageId);
      through = Math.max(through, row.outputSeq);
    }
  }
  if (publishedIds.size < 2 || !round.replies.size) return null;
  return <div className={styles.roundReplyTools} data-group-reply-tools={turnId}>
    <span>{t('groups.replies.count', { count: publishedIds.size })}</span>
    <button type="button" onClick={() => round.setAll(!allOpen, through)}>
      {t(allOpen ? 'groups.replies.collapseAll' : 'groups.replies.expandAll')}
    </button>
  </div>;
}
