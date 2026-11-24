import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { sameBot } from '../shared/identity.js';
import { groupExportReviewStatus } from '../shared/group-export-review.js';
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives';
import type { GroupDelivery, GroupMember, GroupModelSelection, GroupSummary, GroupTurn, GroupView } from '../shared/groups.js';
import type { BotRecord } from '../shared/schema.js';

export type GroupDirectoryFilter = 'all' | 'running' | 'unread' | 'archived';
/** An explicit navigation request, including repeat visits to the same question. */
export type GroupActivityFocus = { turnId: string; sequence: number };

/** Count people, not native continuation/message receipts. Missing proof stays unverified. */
export function groupMemoryWriteCounts(deliveries: readonly GroupDelivery[]) {
  const members = new Map<string, 'saved' | 'failed' | 'unverified'>();
  for (const row of deliveries) {
    if (row.joinedDeliveryId || row.reasonCode === 'message-published' || /^group-message:[a-f0-9]{64}$/.test(row.id)) continue;
    members.set(row.memberId, row.memoryWriteStatus ?? members.get(row.memberId) ?? 'unverified');
  }
  return { saved: [...members.values()].filter(status => status === 'saved').length,
    failed: [...members.values()].filter(status => status === 'failed').length,
    unverified: [...members.values()].filter(status => status === 'unverified').length };
}

/** A guest's delivery receipt stays meaningful even when its reply has paged out. */
export function guestQuestionStatus(view: GroupView, turn: GroupTurn, t: PropsLocale<'dsh-bot'>['t']) {
  const guest = turn.guestQuestion;
  if (!guest) return;
  const receipt = view.deliveries.find(row => row.turnId === turn.id && sameBot(row.bot, guest.bot));
  if (guest.via) {
    const via = guest.via;
    const answer = view.deliveries.find(row => row.turnId === turn.id && row.memberId === via.memberId && sameBot(row.bot, via.bot));
    const markerIssue = [receipt?.relayMarker, answer?.relayMarker].find(issue => issue !== undefined);
    const label = (status: 'queued' | 'delivered' | 'answered' | 'replied' | 'notSent' | 'noReply' | 'unconfirmed' | 'unpublished' | 'review' | 'withheld' | 'awaiting' | 'guestReview' | 'guestWithheld' | 'cancelled') =>
      [t(`groups.relay.${status}`, { sender: via.name, guest: guest.name }),
        markerIssue && t(markerIssue === 'unavailable' ? 'groups.relay.markerUnavailable' : 'groups.relay.markerUnconfirmed')].filter(Boolean).join(' · ');
    if (answer?.state === 'completed' && answer.outputMessageId && answer.outputSeq !== undefined) return label('replied');
    if (receipt && groupExportReviewStatus(view.group, turn, receipt) === 'pending') return label('guestReview');
    if (receipt && (receipt.reasonCode === 'export-rejected' || receipt.reasonCode === 'export-blocked' ||
        receipt.staleExportClosedAt !== undefined || groupExportReviewStatus(view.group, turn, receipt) === 'stale')) return label('guestWithheld');
    if (answer && groupExportReviewStatus(view.group, turn, answer) === 'pending') return label('review');
    if (answer && (answer.reasonCode === 'export-rejected' || answer.reasonCode === 'export-blocked' ||
        answer.staleExportClosedAt !== undefined || groupExportReviewStatus(view.group, turn, answer) === 'stale')) return label('withheld');
    if (turn.state === 'cancelled' || receipt?.state === 'cancelled' || answer?.state === 'cancelled') return label('cancelled');
    if (receipt?.answeredAt !== undefined) return label(answer?.state === 'failed' || answer?.state === 'unknown' ||
      answer?.state === 'skipped' || ['partial', 'recovery_needed', 'idle', 'completed'].includes(turn.state) ? 'unpublished' : answer?.acceptedAt !== undefined ? 'answered' : 'awaiting');
    if (receipt?.state === 'failed' || receipt?.state === 'skipped') return label(receipt.acceptedAt !== undefined ? 'noReply' : 'notSent');
    if (receipt?.state === 'unknown' || ['partial', 'recovery_needed', 'idle', 'completed'].includes(turn.state)) return label('unconfirmed');
    return label(receipt?.acceptedAt !== undefined ? 'delivered' : 'queued');
  }
  const label = (status: 'queued' | 'delivered' | 'replied' | 'notSent' | 'noReply' | 'replyUnconfirmed' | 'unconfirmed' | 'review' | 'withheld' | 'cancelled') =>
    t(`groups.guest.${status}`, { name: guest.name });
  if (receipt?.state === 'completed' && receipt.outputMessageId) return label('replied');
  if (receipt?.reasonCode === 'export-approval-required' && groupExportReviewStatus(view.group, turn, receipt) === 'pending') return label('review');
  if (receipt?.reasonCode === 'export-rejected' || receipt?.reasonCode === 'export-blocked' || receipt?.staleExportClosedAt !== undefined ||
      receipt && groupExportReviewStatus(view.group, turn, receipt) === 'stale') return label('withheld');
  const unconfirmed = receipt?.acceptedAt !== undefined ? 'replyUnconfirmed' : 'unconfirmed';
  if (receipt?.state === 'unknown' || turn.state === 'recovery_needed') return label(unconfirmed);
  if (receipt?.state === 'cancelled' || turn.state === 'cancelled') return label('cancelled');
  if (receipt?.state === 'failed' || receipt?.state === 'skipped') return label(receipt.acceptedAt !== undefined ? 'noReply' : 'notSent');
  if (receipt?.state === 'completed' || ['completed', 'idle', 'partial'].includes(turn.state)) return label(unconfirmed);
  return label(receipt?.acceptedAt !== undefined ? 'delivered' : 'queued');
}

export function filterGroupDirectory(rows: readonly GroupSummary[], query: string, filter: GroupDirectoryFilter) {
  const candidates = rows.filter(row => filter === 'all'
    || (filter === 'running' && row.running && !row.group.archived)
    || (filter === 'unread' && row.unread && !row.group.archived)
    || (filter === 'archived' && row.group.archived));
  return rankByName(candidates.map(row => ({ row, name: row.group.name })), query.trim())
    .map(({ row }) => row)
    .sort((a, b) => Number(b.running && !b.group.archived) - Number(a.running && !a.group.archived)
      || (b.latest?.at ?? b.group.updatedAt) - (a.latest?.at ?? a.group.updatedAt)
      || a.group.name.localeCompare(b.group.name)
      || a.group.id.localeCompare(b.group.id));
}

export function groupMemberModel(group: GroupView['group'], member: GroupMember, bot?: BotRecord): {
  selection?: GroupModelSelection;
  source: 'groups.modelSourceMember' | 'groups.modelSourceGroup' | 'groups.modelSourceBot' | 'groups.modelSourceDsh';
} {
  const own = group.memberModelSelections?.find(row => row.memberId === member.id)?.modelSelection;
  const selection = own ?? group.modelSelection ?? bot?.model;
  return {
    ...(selection ? { selection } : {}),
    source: own ? 'groups.modelSourceMember' : group.modelSelection ? 'groups.modelSourceGroup' : bot?.model ? 'groups.modelSourceBot' : 'groups.modelSourceDsh',
  };
}

export function latestMemberDelivery(view: GroupView, memberId: string, include?: (row: GroupDelivery) => boolean): GroupDelivery | undefined {
  const turns = new Map(view.turns.map(turn => [turn.id, turn]));
  return view.deliveries.filter(row => row.memberId === memberId && (!include || include(row)))
    .sort((a, b) => (turns.get(b.turnId)?.createdAt ?? b.startedAt ?? 0) - (turns.get(a.turnId)?.createdAt ?? a.startedAt ?? 0)
      || (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.ordinal - a.ordinal)[0];
}

export function recentGroupTurns(view: GroupView, limit = 10) {
  return [...view.turns].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, limit);
}

export function groupTurnQuestion(view: GroupView, turn: GroupTurn) {
  return view.messages.find(message => message.id === turn.inputMessageId)?.text.split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim()).find(Boolean);
}

export function groupTurnParticipants(view: GroupView, turn: GroupTurn, bots: readonly BotRecord[]) {
  const ids = new Set(view.deliveries.filter(row => row.turnId === turn.id).map(row => row.memberId));
  return view.members.filter(member => ids.has(member.id)).map(member => {
    const bot = bots.find(row => row.id === member.bot.botId && row.createdAt === member.bot.botCreatedAt);
    return bot?.name ?? member.bot.botId;
  });
}

export function groupTurnFailure(view: GroupView, turn: GroupTurn) {
  return view.deliveries.find(row => row.turnId === turn.id && row.failure)?.failure
    ?? view.messages.find(message => message.turnId === turn.id && message.failure)?.failure;
}
