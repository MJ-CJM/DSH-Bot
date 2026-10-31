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
  cancel(...args: Parameters<GroupTurns['cancel']>) {
    return this.turns.cancel(...args);
  }
  archive(...args: Parameters<GroupTurns['archive']>) {
    return this.turns.archive(...args);
  }
  close() {
    this.state.closing ??= (async () => {
      this.state.stopped = true;
      this.state.shutdownPhase = 'draining-workers';
      this.state.startup.abort();
      for (const c of this.state.controllers.values()) c.abort();
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
      this.state.shutdownPhase = 'disposing-roots';
      for (const a of this.state.activations.values()) await attempt(() => a.dispose());
      for (const h of this.state.roots.values()) {
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
