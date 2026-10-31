import { runRootSetup } from './root-guard.js';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { GROUP_ROOT_PRESET, type GroupRecord, type GroupKey } from '../../shared/groups.js';
import { OperationError, need } from '../common/operations.js';

import { terminal } from './model.js';
import type { GroupState, GroupRoot } from './state.js';
export class GroupRoots {
  constructor(private state: GroupState) {}
  async start() {
    const fiber = this.state.ctx.plugin({
      inject: ['agentPresets'],
      async apply(owner: Context) {
        await owner.effect(
          () =>
            owner.agentPresets.register({
              id: GROUP_ROOT_PRESET,
              name: `${zh.ui['groups.presetName']} / ${en.ui['groups.presetName']}`,
              plugins: [{ id: 'group-root-guard', name: 'dsh-bot/group-root-guard' }],
            }),
          'dsh-bot: group root preset',
        );
      },
    });
    this.state.unregister = () => fiber.dispose();
    await fiber.await();
    for (const [, g] of this.state.table('groups').entries()) {
      for (const t of this.state.turns(g)) {
        const unresolved = this.state
          .deliveries(t.id)
          .filter((d) => ['pending', 'starting', 'running'].includes(d.state));
        for (const d of unresolved)
          await this.state.putDelivery({
            ...d,
            state: d.state === 'pending' ? 'cancelled' : 'unknown',
            reasonCode: 'host-restarted',
          });
        if (!terminal(t) || unresolved.some((d) => d.state !== 'pending'))
          await this.state.putTurn({ ...t, state: 'recovery_needed' });
      }
      if (g.state === 'creating') {
        await this.state.putGroup({ ...g, state: 'recovery_needed' });
        this.state.reasons.set(g.id, 'recovery-needed');
      }
      if (!g.archived) await this.restore(g).catch(() => {});
    }
    this.state.offTitle = this.state.ctx.effect(
      () =>
        this.state.ctx.on('session/event', (session, event) => {
          if (
            event.type !== 'session/title' ||
            this.state.stopped ||
            this.state.repairing.has(session.id) ||
            this.state.naming.has(session.id)
          )
            return;
          const g = [...this.state.table('groups').entries()]
            .map(([, value]) => value)
            .find((g) => g.rootSessionId === session.id);
          if (!g || !this.state.roots.has(g.id) || event.data.title === this.state.titles.get(session.id)) return;
          this.state.repairing.add(session.id);
          void this.state.queue
            .run(async () => {
              const current = this.state.table('groups').get(g.id);
              if (current && !this.state.stopped) await this.rename(current);
            })
            .catch(() => {
              this.state.reasons.set(g.id, 'root-unavailable');
            })
            .finally(() => this.state.repairing.delete(session.id));
        }),
      'dsh-bot: group title invariant',
    );
  }
  async setup(ctx: Context) {
    await this.state.ctx.agentPresets.mount(ctx, GROUP_ROOT_PRESET);
  }
  own(handle: AgentHandle): GroupRoot { return { ownership: 'owned', agent: handle.agent, handle }; }
  async release(root: GroupRoot) { if (root.ownership === 'owned') await root.handle.dispose(); }
  async flush(handle: Pick<GroupRoot, 'agent'>) {
    if (!(await this.state.ctx.sessions.flush(handle.agent.session))) throw new OperationError('recovery-needed');
  }
  async rename(g: GroupRecord, check: () => void = () => {}) {
    const h = need(this.state.roots.get(g.id));
    this.state.naming.add(h.agent.id);
    try {
      const result = await this.state.ctx.sessionController.rename({ sessionId: h.agent.id, title: g.name });
      check();
      if ('error' in result) throw new OperationError('unavailable');
      this.state.titles.set(h.agent.id, result.title);
      await this.flush(h);
      return result.title;
    } finally {
      this.state.naming.delete(h.agent.id);
    }
  }
  private valid(g: GroupRecord, agent: Agent) {
    const header = agent.session.header;
    const selected = this.state.ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset');
    return agent.id === g.rootSessionId && agent.session.id === g.rootSessionId && header.cwd === g.cwd &&
      header.agentPreset === GROUP_ROOT_PRESET && !header.parentSession && header.origin !== 'subagent' &&
      !header.isSeeded && (header.delegationDepth ?? 0) === 0 &&
      (selected === undefined || selected === GROUP_ROOT_PRESET);
  }
  /** Register/attach through the public canonical-cwd workspace registry; never move a legacy cwd. */
  async workspace(g: GroupRecord, check: () => void = () => {}) {
    const workspace = await this.state.ctx.workspaceRegistry.create(g.cwd, g.name);
    check();
    await workspace.attachSession(g.rootSessionId as SessionId);
    check();
    if (!workspace.sessionIds.includes(g.rootSessionId as SessionId)) throw new OperationError('recovery-needed');
    return workspace;
  }
  async initialize(g: GroupRecord, root: GroupRoot, operation: 'create' | 'restore' | 'open') {
    const message = createUserMessage({ source: { kind: 'dsh-bot-group-setup', group: { groupId: g.id, groupCreatedAt: g.createdAt }, operation, operationId: g.operationId },
      content: [{ type: 'text', text: `Initialize group workspace: ${operation}` }] });
    const valid = () => {
      const current = this.state.table('groups').get(g.id);
      return !this.state.stopped && current?.createdAt === g.createdAt && this.state.roots.get(g.id) === root &&
        this.state.ctx.agents.get(g.rootSessionId as SessionId) === root.agent && this.valid(current, root.agent);
    };
    const check = () => { if (!valid()) throw new OperationError('recovery-needed'); };
    await runRootSetup(root.agent, message, valid, async () => {
      check(); await this.rename(g, check);
      check(); await this.workspace(g, check);
      check(); await this.flush(root); check();
    });
    // The callback's flush precedes turn/end. Persist the actual completed native lifecycle too.
    check(); await this.flush(root); check();
  }
  async open(key: GroupKey) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.state !== 'ready') throw new OperationError('recovery-needed');
      await this.restore(g);
      const workspace = await this.workspace(g);
      return { sessionId: g.rootSessionId, workspaceId: String(workspace.id) };
    });
  }
  /** Publish only after title persistence succeeds; a borrowed Agent is never ours to dispose. */
  private async publish(g: GroupRecord, root: GroupRoot): Promise<GroupRoot> {
    this.state.roots.set(g.id, root);
    try {
      await this.initialize(g, root, 'restore');
      this.state.reasons.delete(g.id);
      return root;
    } catch {
      let released = root.ownership === 'borrowed';
      if (root.ownership === 'owned') {
        try { await this.release(root); released = true; }
        catch { /* Retain the exact owned handle for another retry or coordinated shutdown. */ }
      }
      if (released && this.state.roots.get(g.id) === root) this.state.roots.delete(g.id);
      this.state.reasons.set(g.id, 'root-unavailable');
      throw new OperationError('recovery-needed');
    }
  }
  async restore(g: GroupRecord): Promise<GroupRoot> {
    const previous = this.state.roots.get(g.id), live = this.state.ctx.agents.get(g.rootSessionId as SessionId);
    if (previous && previous.agent === live && live) {
      if (!this.valid(g, live)) { this.state.reasons.set(g.id, 'root-owned-elsewhere'); throw new OperationError('recovery-needed'); }
      // A failed release can leave an owned handle. Do not erase its failed persistence state.
      return this.state.reasons.has(g.id) ? this.publish(g, previous) : previous;
    }
    if (previous) {
      try { await this.release(previous); }
      catch { this.state.reasons.set(g.id, 'root-unavailable'); throw new OperationError('recovery-needed'); }
      if (this.state.roots.get(g.id) === previous) this.state.roots.delete(g.id);
    }
    if (live) {
      if (!this.valid(g, live)) {
        this.state.reasons.set(g.id, 'root-owned-elsewhere');
        throw new OperationError('recovery-needed');
      }
      return this.publish(g, { ownership: 'borrowed', agent: live });
    }
    let handle: AgentHandle;
    try {
      handle = await this.state.ctx.agents.resume({
        resumeSessionId: g.rootSessionId as SessionId,
        agentOptions: this.state.route(),
        setup: (ctx) => this.setup(ctx),
        signal: this.state.startup.signal,
      });
    } catch {
      const raced = this.state.ctx.agents.get(g.rootSessionId as SessionId);
      if (raced && this.valid(g, raced)) return this.publish(g, { ownership: 'borrowed', agent: raced });
      this.state.reasons.set(g.id, raced ? 'root-owned-elsewhere' : 'root-unavailable');
      throw new OperationError('recovery-needed');
    }
    if (!this.valid(g, handle.agent)) {
      await handle.dispose();
      this.state.reasons.set(g.id, 'root-unavailable');
      throw new OperationError('recovery-needed');
    }
    return this.publish(g, this.own(handle));
  }
}
