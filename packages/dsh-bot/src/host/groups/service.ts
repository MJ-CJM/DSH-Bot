import { installWorkerTools } from './worker-tool.js';
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
export { groupsDomain } from './model.js';
/** Public facade: compose domain modules and own their coordinated shutdown. */
export class Groups {
  private state: GroupState;
  private roots: GroupRoots;
  private membership: GroupMembers;
  private messages: GroupMessages;
  private turns: GroupTurns;
  constructor(ctx: Context, registry: DshBotRegistry, domain: Domain<typeof groupsDomain>, changed: () => void) {
    this.state = new GroupState(ctx, registry, domain, changed);
    this.roots = new GroupRoots(this.state);
    this.membership = new GroupMembers(this.state, this.roots);
    this.messages = new GroupMessages(this.state, this.roots);
    const runner = new GroupTurnRunner(this.state, this.roots, this.messages);
    this.state.offWorkers = installWorkerTools(this.state, runner);
    this.turns = new GroupTurns(this.state, this.roots, this.messages, runner);
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
  send(...args: Parameters<GroupTurns['send']>) {
    return this.turns.send(...args);
  }
  startProactiveReview(...args: Parameters<GroupTurns['startProactiveReview']>) {
    return this.turns.startProactiveReview(...args);
  }
  async waitForProactiveReview(turnId: string) {
    await this.state.chains.get(turnId);
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
