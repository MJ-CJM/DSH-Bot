import type { GroupKey, OwnerFollowUpChoice } from '../../shared/groups.js';
import { OperationError, digest } from '../common/operations.js';
import { groupMemberModel } from './model-selection.js';
import type { GroupState } from './state.js';

export async function ownerFollowUpChoice(
  state: GroupState, key: GroupKey, predecessorTurnId: string, memberId: string,
): Promise<OwnerFollowUpChoice> {
  const group = state.record(key);
  if (group.archived || group.state !== 'ready' || state.reasons.has(group.id))
    throw new OperationError('recovery-needed');
  const belongsHere = (record: { group: GroupKey }) =>
    record.group.groupId === key.groupId && record.group.groupCreatedAt === key.groupCreatedAt;
  const predecessor = state.table('turns').get(predecessorTurnId);
  const member = state.table('members').get(memberId);
  if (!predecessor || !belongsHere(predecessor) || !['completed', 'idle', 'partial'].includes(predecessor.state) ||
    !member || !belongsHere(member) || !member.enabled || member.removedAt !== undefined)
    throw new OperationError('conflict');
  await state.validateMembers([member.bot]);
  const bot = await state.bot(member.bot);
  const modelSelection = groupMemberModel(group, member.id, bot, () => state.route());
  const current = state.record(key);
  if (current.archived || current.state !== 'ready' || current.membershipRevision !== group.membershipRevision ||
    current.modelRevision !== group.modelRevision || state.table('turns').get(predecessor.id)?.revision !== predecessor.revision)
    throw new OperationError('conflict');
  return {
    predecessorTurnId, predecessorTurnRevision: predecessor.revision, memberId,
    membershipRevision: group.membershipRevision, modelRevision: group.modelRevision ?? 0,
    bot: member.bot, botRevision: bot.updatedAt, modelSelection,
  };
}

export async function verifyOwnerFollowUpChoice(state: GroupState, key: GroupKey, choice: OwnerFollowUpChoice) {
  const { predecessorTurnId, predecessorTurnRevision, memberId, membershipRevision, modelRevision, bot, botRevision, modelSelection } = choice;
  const current = await ownerFollowUpChoice(state, key, predecessorTurnId, memberId);
  if (digest(current) !== digest({ predecessorTurnId, predecessorTurnRevision, memberId, membershipRevision,
    modelRevision, bot, botRevision, modelSelection })) throw new OperationError('conflict');
}
