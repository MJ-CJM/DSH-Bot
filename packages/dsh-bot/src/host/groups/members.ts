import { randomUUID } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  GROUP_ROOT_PRESET,
  groupKey,
  groupCreateSchema,
  groupEditSchema,
  groupSetModelSchema,
  type GroupKey,
  type GroupRecord,
  type GroupMember,
} from '../../shared/groups.js';
import { OperationError, digest, need, parse } from '../common/operations.js';
import { validateDefaultCwd } from '../home.js';

import { sameBot, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
export class GroupMembers {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
  ) {}
  async create(value: unknown) {
    const input = parse(groupCreateSchema, value);
    return this.state.queue.run(async () => {
      this.state.check();
      const id = `group:${digest(input.operationId)}`,
        hash = digest(input);
      const prior = this.state.table('groups').get(id);
      if (prior) {
        if (prior.createDigest !== hash) throw new OperationError('conflict');
        return prior;
      }
      await this.state.validateMembers(input.members);
      this.state.route();
      if (!normalizeSessionTitle(input.name, Number.MAX_SAFE_INTEGER)) throw new OperationError('invalid');
      const cwd = input.cwd ?? (await this.state.registry.ensureBotsWorkspace()).path;
      if (input.cwd)
        await validateDefaultCwd(cwd).catch(() => {
          throw new OperationError('invalid');
        });
      const at = Date.now();
      const g: GroupRecord = {
        id,
        operationId: input.operationId,
        createDigest: hash,
        name: input.name,
        rootSessionId: `group-root-${randomUUID()}`,
        rootPresetId: GROUP_ROOT_PRESET,
        cwd,
        mode: input.mode,
        membershipRevision: 1,
        revision: 1,
        archived: false,
        state: 'creating',
        createdAt: at,
        updatedAt: at,
        schemaVersion: 1,
      };
      // Durable create intent exists before the native side effect. No implicit retry of an uncertain create.
      await this.state.putGroup(g);
      try {
        for (const [order, key] of input.members.entries()) {
          const m: GroupMember = {
            id: `member:${randomUUID()}`,
            group: groupKey(g),
            bot: key,
            order,
            joinedAt: at,
            enabled: true,
          };
          await this.state.table('members').put(m.id, m);
        }
        const h = await this.state.ctx.agents.create({
          sessionId: g.rootSessionId as SessionId,
          meta: { cwd, agentPreset: GROUP_ROOT_PRESET },
          agentOptions: this.state.route(),
          setup: (ctx) => this.roots.setup(ctx),
          signal: this.state.startup.signal,
        });
        const root = this.roots.own(h);
        this.state.roots.set(g.id, root);
        await this.roots.initialize(g, root, 'create');
        const title = this.state.titles.get(h.agent.id) ?? g.name;
        const ready: GroupRecord = { ...g, name: title, state: 'ready', nextMemberId: this.state.members(g)[0]?.id };
        await this.state.putGroup(ready);
        return ready;
      } catch {
        await this.state.putGroup({ ...g, state: 'recovery_needed' });
        this.state.reasons.set(g.id, 'recovery-needed');
        throw new OperationError('recovery-needed');
      }
    });
  }
  /** A group-local override: never changes the Host default or active worker selections. */
  async setModel(key: GroupKey, value: unknown) {
    const input = parse(groupSetModelSchema, value);
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.archived || input.expectedModelRevision !== (g.modelRevision ?? 0)) throw new OperationError('conflict');
      if (g.state !== 'ready' || this.state.reasons.has(g.id)) throw new OperationError('recovery-needed');
      if (input.memberId) {
        const member = this.state.members(g).find(m => m.id === input.memberId && m.enabled && m.removedAt === undefined);
        if (!member) throw new OperationError('invalid');
        // Membership identity includes the Bot birthday; a recreated Bot cannot inherit an override.
        await this.state.validateMembers([member.bot]);
      }
      const selected = input.modelSelection;
      if (selected) {
        const llm = need(this.state.ctx.get('llm'));
        if (!llm.listProviders().some(provider => provider.id === selected.provider)) throw new OperationError('unavailable');
        try {
          if (!(await llm.listModels(selected.provider)).some(model => model.id === selected.model)) throw new OperationError('invalid');
          // Public exact-route validation also rejects unsupported reasoning efforts.
          await llm.resolveCallConfig({ ...selected,
            reasoningEffort: selected.reasoningEffort === undefined ? undefined : ReasoningEffortId(selected.reasoningEffort) });
        } catch (error) {
          if (error instanceof OperationError) throw error;
          throw new OperationError('unavailable');
        }
      }
      // Route validation awaits provider services; recheck incarnation before committing the selection.
      if (input.memberId && selected) {
        const member = this.state.members(g).find(m => m.id === input.memberId && m.enabled && m.removedAt === undefined);
        if (!member) throw new OperationError('invalid');
        await this.state.validateMembers([member.bot]);
      }
      this.state.check();
      const { modelSelection: _old, memberModelSelections: _members, ...record } = g;
      const memberSelections = input.memberId
        ? [...(g.memberModelSelections ?? []).filter(row => row.memberId !== input.memberId),
          ...(selected ? [{ memberId: input.memberId, modelSelection: selected }] : [])]
        : g.memberModelSelections ?? [];
      const defaultSelection = input.memberId ? g.modelSelection : selected;
      const next: GroupRecord = { ...record, ...(defaultSelection ? { modelSelection: defaultSelection } : {}),
        ...(memberSelections.length ? { memberModelSelections: memberSelections } : {}),
        revision: g.revision + 1, modelRevision: (g.modelRevision ?? 0) + 1, updatedAt: Date.now() };
      await this.state.putGroup(next);
      return next;
    });
  }
  async edit(key: GroupKey, value: unknown) {
    const input = parse(groupEditSchema, value);
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (
        g.archived ||
        input.expectedRevision !== g.revision ||
        input.expectedMembershipRevision !== g.membershipRevision
      )
        throw new OperationError('conflict');
      if (!normalizeSessionTitle(input.name, Number.MAX_SAFE_INTEGER)) throw new OperationError('invalid');
      await this.state.validateMembers(input.members);
      const old = this.state.members(g),
        at = Date.now();
      const retainedMemberIds = new Set(old.filter(m => m.removedAt === undefined && input.members.some(b => sameBot(b, m.bot))).map(m => m.id));
      const memberSelections = g.memberModelSelections?.filter(row => retainedMemberIds.has(row.memberId));
      const removedMembers = old.some(m => m.removedAt === undefined && !retainedMemberIds.has(m.id));
      const removedSelections = (memberSelections?.length ?? 0) !== (g.memberModelSelections?.length ?? 0);
      const { memberModelSelections: _selections, ...record } = g;
      // Write intent revision first. A partial multi-table failure makes the group unavailable until reconciled.
      const next = {
        ...record,
        ...(memberSelections?.length ? { memberModelSelections: memberSelections } : {}),
        ...(removedMembers || removedSelections ? { modelRevision: (g.modelRevision ?? 0) + 1 } : {}),
        name: input.name,
        mode: input.mode,
        revision: g.revision + 1,
        membershipRevision: g.membershipRevision + 1,
        updatedAt: at,
        state: 'recovery_needed' as const,
      };
      await this.state.putGroup(next);
      try {
        for (const m of old.filter((m) => m.removedAt === undefined && !input.members.some((b) => sameBot(b, m.bot)))) {
          await this.state.table('members').put(m.id, { ...m, enabled: false, removedAt: at });
          for (const t of this.state.turns(g).filter((t) => !terminal(t)))
            for (const d of this.state.deliveries(t.id).filter((d) => d.memberId === m.id)) {
              this.state.controllers.get(d.id)?.abort();
              if (d.state === 'pending')
                await this.state.putDelivery({ ...d, state: 'cancelled', reasonCode: 'member-removed' });
            }
        }
        for (const [order, b] of input.members.entries()) {
          const previous = old.find((m) => m.removedAt === undefined && sameBot(m.bot, b));
          const member: GroupMember = previous
            ? { ...previous, order }
            : { id: `member:${randomUUID()}`, group: key, bot: b, order, joinedAt: at, enabled: true };
          await this.state.table('members').put(member.id, member);
        }
        const title = await this.roots.rename(next);
        const ready: GroupRecord = { ...next, name: title, state: 'ready' };
        await this.state.putGroup(ready);
        return ready;
      } catch {
        this.state.reasons.set(g.id, 'recovery-needed');
        throw new OperationError('recovery-needed');
      }
    });
  }
}
