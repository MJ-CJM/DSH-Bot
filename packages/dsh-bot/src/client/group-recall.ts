import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { GROUP_RECALL_LIMIT_MAX, type GroupRecallInput, type GroupRecallItem, type GroupRecallPage, type GroupRecallSource } from '../shared/group-recall.js';
import type { GroupKey } from '../shared/groups.js';
import type { BotRecord } from '../shared/schema.js';
import { type GroupActions, unwrapGroup } from './groups-state.js';

type Translate = PropsLocale<'dsh-bot'>['t'];
type Owner = Pick<BotRecord, 'id' | 'createdAt'>;
const MAX_SOURCE_PAGES = 4;

export interface GroupRecallBinding {
  read(bot: Owner, input: GroupRecallInput): Promise<GroupRecallPage>;
  open(bot: Owner, item: GroupRecallItem, signal: AbortSignal): Promise<void>;
  remember(bot: Owner, item: GroupRecallItem, signal: AbortSignal): Promise<void>;
}

export function createGroupRecallBinding(groups: GroupActions, t: Translate,
  draft: (bot: Owner, prompt: string, signal: AbortSignal) => Promise<void>): GroupRecallBinding {
  const read: GroupRecallBinding['read'] = async (bot, input) => unwrapGroup(await groups.remote().recallForBot(
    { botId: bot.id, botCreatedAt: bot.createdAt }, input,
  ));
  const verify = async (bot: Owner, item: GroupRecallItem, source: GroupRecallSource | undefined, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!source) throw new Error(t('groupRecall.unavailable'));
    const { group, turnId, deliveryId } = item;
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let attempt = 0; attempt < MAX_SOURCE_PAGES; attempt++) {
      const page = await read(bot, { group, turnId, limit: GROUP_RECALL_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
      signal.throwIfAborted();
      const current = page.unavailable ? undefined : page.items.find(row => row.group.groupId === group.groupId && row.group.groupCreatedAt === group.groupCreatedAt
        && row.turnId === turnId && row.deliveryId === deliveryId && row.memberId === item.memberId && row.childSessionId === item.childSessionId);
      if (current) {
        if (current.sources.some(row => row.role === source.role && row.sessionId === source.sessionId
          && row.messageId === source.messageId && row.seq === source.seq)) return source;
        break;
      }
      cursor = page.nextCursor;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    throw new Error(t('groupRecall.unavailable'));
  };
  return {
    read,
    async open(bot, item, signal) {
      const original = item.sources.find(source => source.role === 'question') ?? item.sources[0];
      const { messageId, seq } = await verify(bot, item, original, signal);
      await groups.openRun(item.group, item.turnId, signal, { messageId, seq });
    },
    async remember(bot, item, signal) {
      const answer = await verify(bot, item, item.sources.find(source => source.role === 'answer'), signal);
      await draft(bot, groupRememberDraft(t, item, answer), signal);
    },
  };
}

interface GroupDraftSource {
  group: GroupKey;
  groupName: string;
  turnId: string;
  deliveryId: string;
  sessionId: string;
  messageId: string;
  seq: number;
}

export function groupQuestionDraft(t: Translate, source: GroupDraftSource): string {
  const { groupName, ...identity } = source;
  return t('groupRecall.askDraft', { groupName, reference: JSON.stringify(identity) });
}

function groupRememberDraft(t: Translate, item: GroupRecallItem, answer: GroupRecallSource): string {
  const { group, groupName, turnId, deliveryId } = item;
  const reference = JSON.stringify({ group, turnId, deliveryId, sessionId: answer.sessionId, messageId: answer.messageId, seq: answer.seq });
  return t('groupRecall.rememberDraft', { groupName, reference });
}
