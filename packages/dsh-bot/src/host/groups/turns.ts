import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { groupSendSchema, type GroupKey, type GroupTurn } from '../../shared/groups.js';
import { OperationError, digest, need, parse } from '../common/operations.js';
import { groupContext, routeMembers } from './routing.js';

import { blocks, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import type { GroupMessages } from './messages.js';
import type { GroupTurnRunner } from './turn-runner.js';
export class GroupTurns {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
    private messages: GroupMessages,
    private runner: GroupTurnRunner,
  ) {}
  async send(key: GroupKey, value: unknown) {
    const input = parse(groupSendSchema, value);
    return this.state.queue.run(async () => {
      const g = this.state.record(key),
        id = `turn:${digest([key, input.operationId])}`,
        hash = digest(input);
      const old = this.state.table('turns').get(id);
      if (old) {
        if (old.requestDigest !== hash) throw new OperationError('conflict');
        return old;
      }
      if (g.archived || g.state !== 'ready' || this.state.reasons.has(g.id))
        throw new OperationError('recovery-needed');
      if (g.membershipRevision !== input.expectedMembershipRevision) throw new OperationError('conflict');
      const root = await this.roots.restore(g);
      const selected = routeMembers(
        g,
        this.state.members(g),
        input.memberIds,
        input.round,
        this.state.registry.config.groupMaxTurns,
      );
      await this.state.validateMembers(selected.map((m) => m.bot));
      const provider = this.state.ctx.subagents.getProvider('spawn');
      if (
        !provider ||
        provider.inheritsParentContext ||
        !provider.capabilities.agentPreset ||
        !provider.capabilities.agentOptions ||
        !provider.capabilities.depthLimit
      )
        throw new OperationError('unsupported');
      const message = createUserMessage({ source: { kind: 'user' }, content: blocks(input.text) });
      const at = Date.now();
      const turn: GroupTurn = {
        id,
        group: key,
        operationId: input.operationId,
        requestDigest: hash,
        inputMessageId: message.id,
        membershipRevision: g.membershipRevision,
        orderedMemberIds: selected.map((m) => m.id),
        mode: g.mode,
        contextThroughSeq: this.messages.messages(g).at(-1)?.seq ?? -1,
        state: 'accepted',
        revision: 1,
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
      };
      // Reject an oversized required question before admitting any native or model side effect.
      groupContext(
        g.name,
        selected[0]?.bot.botId ?? '',
        this.state.members(g).map((m) => m.bot.botId),
        { id: message.id, seq: 0, at, text: input.text, turnId: id },
        [],
        [],
        this.state.registry.config.groupContextMaxBytes,
      );
      await this.state.putTurn(turn);
      try {
        const statuses = await this.state.registry.status();
        for (const [ordinal, m] of selected.entries()) {
          const bot = await this.state.bot(m.bot);
          const status = need(statuses.find((s) => s.id === bot.id));
          await this.state.putDelivery({
            id: `${id}:${ordinal}`,
            turnId: id,
            memberId: m.id,
            ordinal,
            bot: m.bot,
            botRevision: bot.updatedAt,
            presetId: status.presetId,
            contextOutputMessageIds: [],
            contextTruncated: false,
            state: 'pending',
          });
        }
        const event = root.agent.session.append('user/message', message, { surfaceOp: 'append' });
        await this.roots.flush(root);
        const accepted = await this.state.putTurn({ ...turn, inputSeq: Number(event.seq) });
        const previous = this.state.chains.get(g.id) ?? Promise.resolve();
        const running = previous
          .then(() => this.runner.execute(id))
          .catch(async () => {
            await this.state.queue.run(async () => {
              const t = this.state.table('turns').get(id);
              if (t && !terminal(t)) await this.state.putTurn({ ...t, state: 'recovery_needed' });
            });
          });
        this.state.chains.set(g.id, running);
        void running
          .finally(() => {
            if (this.state.chains.get(g.id) === running) this.state.chains.delete(g.id);
          })
          .catch(() => {});
        return accepted;
      } catch {
        await this.state.putTurn({ ...turn, state: 'recovery_needed' });
        throw new OperationError('recovery-needed');
      }
    });
  }
  async cancel(key: GroupKey, turnId: string, revision: number) {
    return this.state.queue.run(async () => {
      const g = this.state.record(key),
        t = this.state.turns(g).find((t) => t.id === turnId);
      if (!t) throw new OperationError('not-found');
      if (t.revision !== revision) throw new OperationError('conflict');
      if (terminal(t)) return t;
      this.state.cancelledTurns.add(t.id);
      for (const d of this.state.deliveries(t.id)) {
        this.state.controllers.get(d.id)?.abort();
        if (d.state === 'pending') await this.state.putDelivery({ ...d, state: 'cancelled' });
      }
      const active = this.state.deliveries(t.id).some((d) => ['starting', 'running'].includes(d.state));
      return this.state.putTurn({ ...t, state: active ? t.state : 'cancelled' });
    });
  }
  async archive(key: GroupKey, revision: number) {
    const next = await this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.revision !== revision) throw new OperationError('conflict');
      const next = { ...g, archived: true, revision: g.revision + 1, updatedAt: Date.now() };
      await this.state.putGroup(next);
      for (const t of this.state.turns(g).filter((t) => !terminal(t))) {
        this.state.cancelledTurns.add(t.id);
        for (const d of this.state.deliveries(t.id)) this.state.controllers.get(d.id)?.abort();
      }
      return next;
    });
    await this.state.chains.get(next.id);
    await this.state.queue.run(async () => {
      const h = this.state.roots.get(next.id);
      if (h) {
        await this.roots.flush(h);
        await h.dispose();
        this.state.roots.delete(next.id);
      }
    });
    return next;
  }
}
