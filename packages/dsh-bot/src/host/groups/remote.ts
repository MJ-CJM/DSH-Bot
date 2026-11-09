import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { GROUPS_REMOTE } from '../../shared/groups-contract.js';
import type { GroupKey } from '../../shared/groups.js';
import type { Groups } from './service.js';
import { botKeySchema, type BotKey } from '../../shared/identity.js';
import { groupRecallInputSchema, type GroupRecallInput } from '../../shared/group-recall.js';
export const GROUPS_HOST = {
  package: 'dsh-bot/groups',
  face: 'host',
  schemas: [],
  get invocations() {
    return GROUPS_REMOTE.descriptors;
  },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
export class GroupsRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private groups: Groups,
  ) {
    super(ctx, 'dshBotGroupsRemote', { namespace: 'dshBot.groups' });
  }
  @Remote async recallForBot(bot: BotKey, input: GroupRecallInput) {
    const invocation = this.ctx.invocation;
    if (invocation?.peer.principal.kind !== 'owner') throw new Error('Owner access required');
    return this.groups.recall(botKeySchema.parse(bot), groupRecallInputSchema.parse(input), invocation.signal);
  }
  @Remote async open(group: GroupKey) { return this.groups.open(group); }
  @Remote async openAttachment(group: GroupKey, messageId: string, attachmentId: string) {
    return this.groups.openAttachment(group, messageId, attachmentId);
  }
  @Remote async markRead(group: GroupKey, throughSeq: number, expectedRevision: number) {
    return this.groups.markRead(group, throughSeq, expectedRevision);
  }
  @Remote async list() {
    return this.groups.list();
  }
  @Remote async create(input: unknown) {
    return this.groups.create(input);
  }
  @Remote async edit(group: GroupKey, input: unknown) {
    return this.groups.edit(group, input);
  }
  @Remote async setModel(group: GroupKey, input: unknown) {
    return this.groups.setModel(group, input);
  }
  @Remote async view(group: GroupKey, page: unknown) {
    return this.groups.view(group, page);
  }
  @Remote async send(group: GroupKey, input: unknown) {
    return this.groups.send(group, input);
  }
  @Remote async cancel(group: GroupKey, turnId: string, expectedRevision: number) {
    return this.groups.cancel(group, turnId, expectedRevision);
  }
  @Remote async continueTurn(group: GroupKey, turnId: string, expectedRevision: number) { return this.groups.continueTurn(group, turnId, expectedRevision); }
  @Remote async stopMember(group: GroupKey, turnId: string, memberId: string, expectedRevision: number) { return this.groups.stopMember(group, turnId, memberId, expectedRevision); }
  @Remote async archive(group: GroupKey, expectedRevision: number) {
    return this.groups.archive(group, expectedRevision);
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotGroupsRemote: GroupsRemote;
  }
}
