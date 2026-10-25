import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { GROUP_ROOT_PRESET, type GroupRecord } from '../../shared/groups.js';
import { OperationError, need } from '../common/operations.js';

import { terminal } from './model.js';
import type { GroupState } from './state.js';
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
              name: GROUP_ROOT_PRESET,
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
  async flush(handle: AgentHandle) {
    if (!(await this.state.ctx.sessions.flush(handle.agent.session))) throw new OperationError('recovery-needed');
  }
  async rename(g: GroupRecord) {
    const h = need(this.state.roots.get(g.id));
    this.state.naming.add(h.agent.id);
    try {
      const result = await this.state.ctx.sessionController.rename({ sessionId: h.agent.id, title: g.name });
      if ('error' in result) throw new OperationError('unavailable');
      this.state.titles.set(h.agent.id, result.title);
      await this.flush(h);
      return result.title;
    } finally {
      this.state.naming.delete(h.agent.id);
    }
  }
  async restore(g: GroupRecord) {
    if (this.state.roots.has(g.id)) return need(this.state.roots.get(g.id));
    if (this.state.ctx.agents.get(g.rootSessionId as SessionId)) {
      this.state.reasons.set(g.id, 'root-owned-elsewhere');
      throw new OperationError('recovery-needed');
    }
    try {
      const h = await this.state.ctx.agents.resume({
        resumeSessionId: g.rootSessionId as SessionId,
        agentOptions: this.state.route(),
        setup: (ctx) => this.setup(ctx),
        signal: this.state.startup.signal,
      });
      if (h.agent.session.header.agentPreset !== GROUP_ROOT_PRESET || h.agent.session.header.parentSession) {
        await h.dispose();
        throw new OperationError('recovery-needed');
      }
      this.state.roots.set(g.id, h);
      await this.rename(g);
      this.state.reasons.delete(g.id);
      return h;
    } catch {
      this.state.reasons.set(
        g.id,
        this.state.ctx.agents.get(g.rootSessionId as SessionId) && !this.state.roots.has(g.id)
          ? 'root-owned-elsewhere'
          : 'root-unavailable',
      );
      throw new OperationError('recovery-needed');
    }
  }
}
