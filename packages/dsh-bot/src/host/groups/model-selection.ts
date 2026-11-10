import type { GroupRecord, GroupTurn } from '../../shared/groups.js';
import type { BotRecord } from '../../shared/schema.js';

type Choices = Pick<GroupRecord, 'modelSelection' | 'memberModelSelections'>;
/** Same precedence for ordinary group turns and explicit proactive previews. */
export function groupMemberModel(group: Choices, memberId: string, bot: Pick<BotRecord, 'model'>,
  fallback: NonNullable<BotRecord['model']> | (() => NonNullable<BotRecord['model']>)) {
  const selected = group.memberModelSelections?.find(row => row.memberId === memberId)?.modelSelection
    ?? group.modelSelection ?? bot.model ?? (typeof fallback === 'function' ? fallback() : fallback);
  return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) };
}
export function proactiveMemberModel(review: NonNullable<GroupTurn['proactive']>, memberId: string) {
  return review.memberModels?.find(row => row.memberId === memberId)?.modelSelection
    ?? { provider: review.provider, model: review.model };
}
