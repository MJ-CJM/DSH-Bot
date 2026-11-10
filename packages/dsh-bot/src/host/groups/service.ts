import { getGroupWorkerBinding, installWorkerTools, isLiveGroupWorker } from './worker-tool.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { GROUP_ROOT_PRESET } from '../../shared/groups.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { DshBotRegistry } from '../registry.js';

import type { groupsDomain } from './model.js';
import { GroupState } from './state.js';
import { GroupRoots } from './roots.js';
import { GroupMembers } from './members.js';
import { GroupMessages } from './messages.js';
import { GroupTurnRunner } from './turn-runner.js';
import { GroupTurns } from './turns.js';
import { GroupRecall } from './recall.js';
import { outlets } from '../data-flow/tool-guard.js';
import type { ProactiveGroupCopyRef } from '../data-flow/outlets.js';
import type { GroupDelivery, GroupKey, GroupRecord, GroupTurn } from '../../shared/groups.js';
export { groupsDomain } from './model.js';
export interface GroupFactPage {
  group: GroupKey;
  since: number;
  ids: readonly string[];
  offset: number;
}
/** Public facade: compose domain modules and own their coordinated shutdown. */
export class Groups {
  private state: GroupState;
  private roots: GroupRoots;
  private membership: GroupMembers;
  private messages: GroupMessages;
  private turns: GroupTurns;
  private recallReader: GroupRecall;
  constructor(ctx: Context, registry: DshBotRegistry, domain: Domain<typeof groupsDomain>, changed: () => void) {
    this.state = new GroupState(ctx, registry, domain, changed);
    this.roots = new GroupRoots(this.state);
    this.membership = new GroupMembers(this.state, this.roots);
    this.messages = new GroupMessages(this.state, this.roots);
    const runner = new GroupTurnRunner(this.state, this.roots, this.messages);
    this.state.offWorkers = installWorkerTools(this.state, runner);
    this.turns = new GroupTurns(this.state, this.roots, this.messages, runner);
    this.recallReader = new GroupRecall(this.state);
  }
  lifecycle() {
    return {
      phase: this.state.shutdownPhase,
      ownedRoots: [...this.state.roots.values()].filter(root => root.ownership === 'owned').length,
      workers: this.state.chains.size,
      activations: this.state.activations.size,
    };
  }
  start(...args: Parameters<GroupRoots['start']>) {
    return this.roots.start(...args);
  }
  open(...args: Parameters<GroupRoots['open']>) { return this.roots.open(...args); }
  create(...args: Parameters<GroupMembers['create']>) {
    return this.membership.create(...args);
  }
  edit(...args: Parameters<GroupMembers['edit']>) {
    return this.membership.edit(...args);
  }
  setModel(...args: Parameters<GroupMembers['setModel']>) {
    return this.membership.setModel(...args);
  }
  openAttachment(...args: Parameters<GroupMessages['openAttachment']>) {
    return this.messages.openAttachment(...args);
  }
  markRead(...args: Parameters<GroupMessages['markRead']>) {
    return this.messages.markRead(...args);
  }
  list(...args: Parameters<GroupMessages['list']>) {
    return this.messages.list(...args);
  }
  view(...args: Parameters<GroupMessages['view']>) {
    return this.messages.view(...args);
  }
  recall(...args: Parameters<GroupRecall['query']>) {
    return this.recallReader.query(...args);
  }
  validateRecall(...args: Parameters<GroupRecall['validate']>) {
    return this.recallReader.validate(...args);
  }
  validateRecallReferences(...args: Parameters<GroupRecall['validateReferences']>) {
    return this.recallReader.validateReferences(...args);
  }
  followUpSubject(key: GroupKey) {
    return this.state.queue.run(async () => structuredClone(this.state.record(key)));
  }
  /** Exact human provenance for a currently owned worker; never borrow its Bot's private main. */
  followUpWorker(agent: Agent) {
    return this.state.queue.run(async () => {
      const binding = getGroupWorkerBinding(agent);
      if (!binding || !isLiveGroupWorker(agent) || this.state.workers.get(agent.session.id) !== binding) return;
      const turn = this.state.table('turns').get(binding.turnId);
      const delivery = this.state.table('deliveries').get(binding.deliveryId);
      if (!turn || turn.proactive || turn.ownerFollowUp || !delivery || delivery.turnId !== turn.id ||
          delivery.childSessionId !== agent.session.id || delivery.presetId !== binding.presetId ||
          !['starting', 'running'].includes(delivery.state)) return;
      const group = this.state.record(turn.group);
      if (group.archived || group.rootSessionId !== binding.rootId) return;
      const member = this.state.table('members').get(delivery.memberId);
      if (!member || !member.enabled || member.removedAt !== undefined ||
          member.group.groupId !== group.id || member.group.groupCreatedAt !== group.createdAt ||
          member.bot.botId !== delivery.bot.botId || member.bot.botCreatedAt !== delivery.bot.botCreatedAt) return;
      const bot = await this.state.bot(member.bot).catch(() => undefined);
      if (bot?.updatedAt !== delivery.botRevision || !isLiveGroupWorker(agent)) return;
      const root = this.state.roots.get(group.id)?.agent;
      if (!root || root.session.id !== group.rootSessionId || root.session.header.agentPreset !== GROUP_ROOT_PRESET) return;
      const input = turn.inputSeq === undefined ? undefined : root.session.eventAt(SessionSeq(turn.inputSeq));
      if (input?.type !== 'user/message' || input.data.id !== turn.inputMessageId || input.data.source.kind !== 'user') return;
      const source = input.data.source as { group?: GroupKey; turnId?: string };
      if (source.group?.groupId !== group.id || source.group.groupCreatedAt !== group.createdAt || source.turnId !== turn.id) return;
      return { subject: { kind: 'group' as const, group: turn.group }, name: group.name,
        generation: JSON.stringify([group.revision, group.membershipRevision, group.modelRevision, member.id, bot.updatedAt, turn.id, delivery.id]),
        sessionId: root.session.id, messageId: input.data.id };
    });
  }
  /** Host-only fact snapshots. No root restoration, model request, or transcript read. */
  followUpFacts(key: GroupKey, request: { turnId?: string; page?: GroupFactPage; since?: number } = {}): Promise<{
    group: GroupRecord;
    rows: { turn: GroupTurn; deliveries: GroupDelivery[] }[];
    next?: GroupFactPage;
  }> {
    return this.state.queue.run(async () => {
      const group = this.state.record(key);
      const read = (id: string) => {
        const turn = this.state.table('turns').get(id);
        return turn && !turn.proactive && turn.group.groupId === group.id && turn.group.groupCreatedAt === group.createdAt
          ? [{ turn, deliveries: this.state.deliveries(turn.id).sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)) }] : [];
      };
      if (request.turnId) return structuredClone({ group, rows: read(request.turnId) });
      const since = request.since ?? 0;
      const prior = request.page;
      const page = prior && prior.group.groupId === group.id && prior.group.groupCreatedAt === group.createdAt && prior.since === since
        ? prior
        : { group: key, since, offset: 0, ids: this.state.turns(group).filter(turn => !turn.proactive && (
            ['accepted', 'running'].includes(turn.state) || turn.updatedAt >= since ||
            this.state.deliveries(turn.id).some(row => (row.updatedAt ?? row.endedAt ?? row.startedAt ?? 0) >= since)
          )).map(turn => turn.id).sort((a, b) => a.localeCompare(b)) };
      const offset = page.offset + 16;
      return {
        ...structuredClone({ group, rows: page.ids.slice(page.offset, offset).flatMap(read) }),
        ...(offset < page.ids.length ? { next: { ...page, offset } } : {}),
      };
    });
  }
  send(...args: Parameters<GroupTurns['send']>) {
    return this.turns.send(...args);
  }
  startProactiveReview(...args: Parameters<GroupTurns['startProactiveReview']>) {
    return this.turns.startProactiveReview(...args);
  }
  ownerFollowUpChoice(...args: Parameters<GroupTurns['ownerFollowUpChoice']>) {
    return this.turns.ownerFollowUpChoice(...args);
  }
  startOwnerFollowUp(...args: Parameters<GroupTurns['startOwnerFollowUp']>) {
    return this.turns.startOwnerFollowUp(...args);
  }
  ownerFollowUpUnstarted(...args: Parameters<GroupTurns['ownerFollowUpUnstarted']>) {
    return this.turns.ownerFollowUpUnstarted(...args);
  }
  abandonOwnerFollowUp<T>(key: GroupKey, operationId: string, abandon: () => Promise<T>) {
    return this.turns.abandonOwnerFollowUp(key, operationId, abandon);
  }
  async waitForProactiveReview(turnId: string) {
    await this.state.chains.get(turnId);
  }
  purgeProactiveCopies(assignmentIds: readonly string[]) {
    if (!assignmentIds.length) return Promise.resolve(true);
    return this.state.queue.run(async () => {
      const flow = outlets(this.state.registry);
      if (!flow) return false;
      const selected = new Set(assignmentIds);
      const refs = new Map<string, ProactiveGroupCopyRef>();
      for (const [, turn] of this.state.table('turns').entries()) {
        if (!turn.proactive || !selected.has(turn.proactive.assignmentId)) continue;
        if (this.state.chains.has(turn.id) || !['completed', 'partial', 'cancelled'].includes(turn.state)) return false;
        const group = this.state.table('groups').get(turn.group.groupId);
        if (group?.createdAt !== turn.group.groupCreatedAt) return false;
        refs.set(turn.id, { sessionId: group.rootSessionId, outlet: 'group-input' });
        const deliveries = this.state.deliveries(turn.id);
        if (deliveries.length !== turn.orderedMemberIds.length ||
            deliveries.some((delivery, index) => delivery.memberId !== turn.orderedMemberIds[index])) return false;
        for (const delivery of deliveries) {
          if (['pending', 'starting', 'running', 'unknown'].includes(delivery.state) ||
              this.state.proactiveDrains.get(delivery.id) === false) return false;
          refs.set(delivery.id, { sessionId: group.rootSessionId, outlet: 'group-input' });
          refs.set(`${delivery.id}:result`, { sessionId: delivery.childSessionId, outlet: 'group-result' });
        }
      }
      return flow.purgeProactiveGroupCopies(selected, refs);
    });
  }
  proactiveRequestAllowance(turnId: string) {
    const deliveries = this.state.deliveries(turnId);
    if (deliveries.length !== 1) return;
    const delivery = deliveries[0];
    if (!delivery) return;
    const allowance = this.state.proactiveAllowances.get(delivery.id);
    if (allowance) return { turnId, deliveryId: delivery.id, ...allowance };
  }
  cancelProactiveRepair(assignmentId: string) {
    for (const [, turn] of this.state.table('turns').entries()) {
      if (!turn.proactive?.repair || turn.proactive.assignmentId !== assignmentId || !this.state.chains.has(turn.id)) continue;
      this.state.cancelledTurns.add(turn.id);
      this.state.wakeTurns.get(turn.id)?.();
      for (const delivery of this.state.deliveries(turn.id)) this.state.controllers.get(delivery.id)?.abort('proactive-repair-cancelled');
    }
  }
  async drainProactiveRepair(assignmentId: string): Promise<boolean> {
    const turns = [...this.state.table('turns').entries()].map(([, turn]) => turn)
      .filter(turn => turn.proactive?.repair && turn.proactive.assignmentId === assignmentId);
    this.cancelProactiveRepair(assignmentId);
    await Promise.allSettled(turns.map(turn => this.state.chains.get(turn.id)));
    // Only this Host's observed create/dispose path proves cleanup. Persisted
    // cancelled/unknown states alone cannot prove an agent has stopped.
    return turns.every(turn => {
      const deliveries = this.state.deliveries(turn.id);
      return deliveries.length > 0 && deliveries.every(delivery => this.state.proactiveDrains.get(delivery.id) === true);
    });
  }
  stopProactiveReviews() {
    for (const turnId of this.state.proactiveChecks.keys())
      for (const delivery of this.state.deliveries(turnId))
        this.state.controllers.get(delivery.id)?.abort('proactive-paused');
  }
  cancel(...args: Parameters<GroupTurns['cancel']>) {
    return this.turns.cancel(...args);
  }
  continueTurn(...args: Parameters<GroupTurns['continueTurn']>) { return this.turns.continueTurn(...args); }
  stopMember(...args: Parameters<GroupTurns['stopMember']>) { return this.turns.stopMember(...args); }
  archive(...args: Parameters<GroupTurns['archive']>) {
    return this.turns.archive(...args);
  }
  close() {
    this.state.closing ??= (async () => {
      this.state.stopped = true;
      this.state.shutdownPhase = 'draining-workers';
      this.state.startup.abort();
      for (const c of this.state.controllers.values()) c.abort('host-unloaded');
      for (const wake of this.state.wakeTurns.values()) wake();
      // Pending workers check stopped before starting. Drain all callers before roots and preset.
      const errors: unknown[] = [];
      const attempt = async (fn: () => unknown) => {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      };
      await attempt(() => Promise.all([...this.state.chains.values()]));
      this.state.shutdownPhase = 'draining-queue';
      await attempt(() => this.state.queue.close());
      this.state.offTitle?.();
      this.state.offWorkers?.();
      this.state.closeIndex();
      this.state.workers.clear();
      this.state.proactiveDrains.clear();
      this.state.proactiveAllowances.clear();
      this.state.shutdownPhase = 'disposing-roots';
      for (const a of this.state.activations.values()) await attempt(() => a.dispose());
      for (const h of this.state.roots.values()) {
        await attempt(async () => this.state.ctx.subagents.drainChildren(h.agent, (await this.state.ctx.subagents.listChildren(h.agent.id)).map(c => c.id)));
        await attempt(() => this.roots.flush(h));
        await attempt(() => this.roots.release(h));
      }
      this.state.roots.clear();
      this.state.shutdownPhase = 'unregistering-preset';
      await attempt(() => this.state.unregister?.());
      this.state.shutdownPhase = 'closing-domain';
      await attempt(() => this.state.domain.close());
      this.state.shutdownPhase = errors.length ? 'failed' : 'closed';
      if (errors.length) throw new AggregateError(errors, 'Group shutdown failed');
    })();
    return this.state.closing;
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotGroups: Groups;
  }
}
