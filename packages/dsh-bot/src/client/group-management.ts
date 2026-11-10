import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives';
import type { GroupDelivery, GroupMember, GroupModelSelection, GroupSummary, GroupTurn, GroupView } from '../shared/groups.js';
import type { BotRecord } from '../shared/schema.js';

export type GroupDirectoryFilter = 'all' | 'running' | 'unread' | 'archived';
/** An explicit navigation request, including repeat visits to the same question. */
export type GroupActivityFocus = { turnId: string; sequence: number };

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
