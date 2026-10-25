import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import {
  groupRecordSchema,
  groupMemberSchema,
  groupTurnSchema,
  groupDeliverySchema,
  groupReadSchema,
  type GroupKey,
  type GroupTurn,
  type GroupSpeaker,
} from '../../shared/groups.js';
import type { BotKey } from '../../shared/integrations.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-bot-group': {
      kind: 'dsh-bot-group';
      group: GroupKey;
      turnId: string;
      memberId: string;
      speaker: GroupSpeaker;
      childSessionId: string;
      stopReason: string;
    };
  }
}
export const groupsDomain = defineDomain({
  name: 'dsh_bot_groups',
  version: 1,
  tables: {
    groups: domainTable(groupRecordSchema),
    members: domainTable(groupMemberSchema),
    turns: domainTable(groupTurnSchema),
    deliveries: domainTable(groupDeliverySchema),
    read_state: domainTable(groupReadSchema),
  },
});
export const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;
export const blocks = (text: string) => [{ type: 'text' as const, text }];
export const textOf = (content: readonly { type: string; text?: unknown }[]) =>
  content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
export const terminal = (turn: GroupTurn) => !['accepted', 'running'].includes(turn.state);
