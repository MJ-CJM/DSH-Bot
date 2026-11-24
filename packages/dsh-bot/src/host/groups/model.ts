import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { savedTeamRecipeSchema } from '../../shared/team-recipes.js';
import { resourceId } from '../../shared/identity.js';
import {
  groupRecordSchema,
  groupMemberSchema,
  groupTurnSchema,
  groupDeliverySchema,
  groupReadSchema,
  groupKeySchema,
  type GroupKey,
  type GroupTurn,
  type GroupSpeaker,
  type GroupFailure,
} from '../../shared/groups.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-supergroup': { kind: 'dsh-bot-supergroup'; group: GroupKey; turnId: string; workId: string;
      originSessionId: string; originMessageId: string; originSeq: number };
    'dsh-bot-group-setup': { kind: 'dsh-bot-group-setup'; group: GroupKey; operation: 'create' | 'restore' | 'open'; operationId: string };
    'dsh-bot-group-user': { kind: 'dsh-bot-group-user'; group: GroupKey; turnId: string; replyTo?: string; rpcId?: string };
    'dsh-bot-group-proactive': {
      kind: 'dsh-bot-group-proactive'; group: GroupKey; turnId: string; ticketId: string; assignmentId: string;
      repairPhase?: 'plan' | 'implement' | 'review';
      factId?: string; predecessorTurnId?: string;
    };
    'dsh-bot-group-owner-followup': {
      kind: 'dsh-bot-group-owner-followup'; group: GroupKey; turnId: string; cardId: string; predecessorTurnId: string;
      /** Present on the published group input only. Child prompts use the same source kind. */
      groupRootSessionId?: string;
    };
    'dsh-bot-group-followup': { kind: 'dsh-bot-group-followup'; group: GroupKey; turnId: string; deliveryId: string; replyTo: string };
    'dsh-bot-group': {
      kind: 'dsh-bot-group';
      group: GroupKey;
      turnId: string;
      memberId: string;
      speaker: GroupSpeaker;
      childSessionId?: string;
      guestReply?: true;
      relayReply?: true;
      stopReason: string;
      /** Native failure facts for a failed run; older messages omit it. */
      failure?: GroupFailure;
      replyTo?: string;
      causeId?: string;
    };
  }
}
const groupDeletionSchema = z.strictObject({
  group: groupKeySchema, revision: z.number().int().positive(), rootSessionId: z.string().min(1), complete: z.boolean(),
});
export type GroupDeletion = z.infer<typeof groupDeletionSchema>;
export const groupsDomain = defineDomain({
  name: 'dsh_bot_groups',
  version: 1,
  tables: {
    groups: domainTable(groupRecordSchema),
    // Intent precedes multi-table membership writes; unknown intents are never replayed.
    member_edits: domainTable(z.strictObject({
      group: groupKeySchema, operationId: resourceId, requestDigest: z.string().length(64),
      status: z.enum(['saved', 'unknown']), result: groupRecordSchema.optional(),
    })),
    deletions: domainTable(groupDeletionSchema),
    team_recipes: domainTable(savedTeamRecipeSchema),
    members: domainTable(groupMemberSchema),
    turns: domainTable(groupTurnSchema),
    deliveries: domainTable(groupDeliverySchema),
    read_state: domainTable(groupReadSchema),
    supergroup_requests: domainTable(z.strictObject({ group: groupKeySchema, count: z.number().int().nonnegative() })),
  },
});
// Store closure receipts separately so both old and new Hosts can read historical deliveries.
export const groupExportReviewsDomain = defineDomain({
  name: 'dsh_bot_group_export_reviews',
  version: 1,
  tables: {
    closures: domainTable(z.strictObject({ closedAtByDeliveryId: z.record(resourceId, z.number().int().nonnegative()) })),
  },
});
export { sameBot, sameGroupReaders } from '../../shared/identity.js';
export const blocks = (text: string) => [{ type: 'text' as const, text }];
export const textOf = (content: readonly { type: string; text?: unknown }[]) =>
  content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
export const terminal = (turn: GroupTurn) => !['accepted', 'running'].includes(turn.state);
