import { randomUUID } from 'node:crypto';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  GROUP_ROOT_PRESET,
  groupKey,
  groupCreateSchema,
  groupEditSchema,
  groupMemberEditSchema,
  type GroupMemberEditResult,
  groupSetModelSchema,
  type GroupKey,
  type GroupRecord,
  type GroupMember,
} from '../../shared/groups.js';
import { resourceId } from '../../shared/identity.js';
import { OperationError, digest, need, parse, redactedErrorMetadata } from '../common/operations.js';
import { validateDefaultCwd } from '../home.js';

import { sameBot, terminal } from './model.js';
import type { GroupState } from './state.js';
import type { GroupRoots } from './roots.js';
import { checkSupergroup, supergroupMetadata, validateSupergroupAuthority, type SupergroupAuthority } from './supergroup-admission.js';
export class GroupMembers {
  constructor(
    private state: GroupState,
    private roots: GroupRoots,
  ) {}
  async create(value: unknown, authority?: SupergroupAuthority) {
    const input = parse(groupCreateSchema, value);
    if (input.memberRoles?.some(row => !input.members.some(bot => sameBot(bot, row.bot))) ||
        new Set(input.memberRoles?.map(row => JSON.stringify(row.bot))).size !== (input.memberRoles?.length ?? 0)) throw new OperationError('invalid');
    return this.state.queue.run(async () => {
      this.state.check();
      const id = `group:${digest(input.operationId)}`,
        hash = digest(input);
      if (this.state.table('deletions').get(id)) throw new OperationError('conflict');
      const prior = this.state.table('groups').get(id);
      if (prior) {
        if (prior.createDigest !== hash) throw new OperationError('conflict');
        if (prior.supergroup && !authority || !prior.supergroup && authority) throw new OperationError('approval-denied');
        if (authority) { await validateSupergroupAuthority(this.state, authority, prior); this.state.supergroupAuthorities.set(prior.id, authority); }
        return prior;
      }
      if (authority) {
        await validateSupergroupAuthority(this.state, authority);
        if (input.members.some(key => !authority.readers.some(reader => sameBot(key, reader)))) throw new OperationError('approval-denied');
      }
      this.state.checkMemberLimit(input.members, Boolean(authority));
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
        ...(input.onDemand !== undefined ? { onDemand: input.onDemand } : {}),
        ...(input.memberRoles ? { memberRoles: input.memberRoles } : {}),
        membershipRevision: 1,
        revision: 1,
        archived: false,
        state: 'creating',
        createdAt: at,
        updatedAt: at,
        schemaVersion: 1,
        ...(authority ? { supergroup: supergroupMetadata(authority) } : {}),
      };
      // Durable create intent exists before the native side effect. No implicit retry of an uncertain create.
      await this.state.putGroup(g);
      if (authority) this.state.supergroupAuthorities.set(g.id, authority);
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
      if (g.supergroup) throw new OperationError('approval-denied');
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
  async edit(key: GroupKey, value: unknown, authority?: SupergroupAuthority) {
    const input = parse(groupEditSchema, value);
    if (input.memberRoles?.some(row => !input.members.some(bot => sameBot(bot, row.bot))) ||
        new Set(input.memberRoles?.map(row => JSON.stringify(row.bot))).size !== (input.memberRoles?.length ?? 0)) throw new OperationError('invalid');
    return this.state.queue.run(() => this.saveEdit(key, input, authority) as Promise<GroupRecord>);
  }
  async editMembers(key: GroupKey, value: unknown): Promise<GroupMemberEditResult> {
    const input = parse(groupMemberEditSchema, value);
    return this.state.queue.run(async () => {
      let g = this.state.record(key);
      if (g.state === 'recovery_needed') g = await this.roots.reconcilePendingRename(g);
      return this.saveEdit(key, { ...input, name: g.name, mode: g.mode }, undefined,
        { operationId: input.operationId, requestDigest: digest({ group: key, source: 'members', input }) });
    }) as Promise<GroupMemberEditResult>;
  }
  async getMemberEditResult(key: GroupKey, operationId: string): Promise<GroupMemberEditResult> {
    parse(resourceId, operationId);
    return this.state.queue.run(async () => {
      const g = this.state.record(key);
      if (g.state === 'recovery_needed') await this.roots.reconcilePendingRename(g);
      const row = this.state.table('member_edits').get(this.editId(key, operationId));
      return row ? { operationId, status: row.status, ...(row.result ? { group: row.result } : {}) } : { operationId, status: 'not-found' };
    });
  }
  async editRecipe(key: GroupKey, value: unknown, operationId: string, source: unknown): Promise<GroupMemberEditResult> {
    const input = parse(groupEditSchema, value);
    return this.state.queue.run(() => this.saveEdit(key, input, undefined,
      { operationId, requestDigest: digest({ group: key, source }) })) as Promise<GroupMemberEditResult>;
  }
  private editId(key: GroupKey, operationId: string) { return digest([key.groupId, key.groupCreatedAt, operationId]); }
  private async saveEdit(key: GroupKey, input: ReturnType<typeof groupEditSchema.parse>, authority?: SupergroupAuthority,
    operation?: { operationId: string; requestDigest: string }): Promise<GroupRecord | GroupMemberEditResult> {
      if (input.memberRoles?.some(row => !input.members.some(bot => sameBot(bot, row.bot))) ||
          new Set(input.memberRoles?.map(row => JSON.stringify(row.bot))).size !== (input.memberRoles?.length ?? 0)) throw new OperationError('invalid');
      let g = this.state.record(key);
      if (g.state === 'recovery_needed') g = await this.roots.reconcilePendingRename(g);
      const operationKey = operation && this.editId(key, operation.operationId);
      const prior = operationKey && this.state.table('member_edits').get(operationKey);
      if (prior) {
        if (prior.requestDigest !== operation?.requestDigest) throw new OperationError('conflict');
        return { operationId: prior.operationId, status: prior.status, ...(prior.result ? { group: prior.result } : {}) };
      }
      if ([...this.state.table('member_edits').entries()].some(([, row]) => row.group.groupId === key.groupId &&
          row.group.groupCreatedAt === key.groupCreatedAt && row.status === 'unknown')) throw new OperationError('recovery-needed');
      if (g.supergroup) {
        if (!authority || this.state.supergroupAuthorities.get(g.id) !== authority) throw new OperationError('approval-denied');
        await checkSupergroup(this.state, g);
        if (this.state.turns(g).some(turn => this.state.chains.has(turn.id) || !terminal(turn)) ||
            input.members.some(key => !g.supergroup?.readers.some(reader => sameBot(key, reader)))) throw new OperationError('conflict');
      } else if (authority) throw new OperationError('approval-denied');
      if (
        g.archived ||
        input.expectedRevision !== g.revision ||
        input.expectedMembershipRevision !== g.membershipRevision
      )
        throw new OperationError('conflict');
      if (g.state !== 'ready' || this.state.reasons.has(g.id)) throw new OperationError('recovery-needed');
      if (!normalizeSessionTitle(input.name, Number.MAX_SAFE_INTEGER)) throw new OperationError('invalid');
      if (new Set(input.members.map(bot => bot.botId)).size !== input.members.length) throw new OperationError('invalid');
      const existing = this.state.members(g).filter(member => member.removedAt === undefined);
      const additions = input.members.filter(bot => !existing.some(member => sameBot(member.bot, bot)));
      if (additions.length && input.historyConfirmed !== true) throw new OperationError('approval-denied');
      this.state.checkMemberLimit(input.members, Boolean(g.supergroup),
        this.state.members(g).filter(member => member.removedAt === undefined).map(member => member.bot));
      if (additions.length) await this.state.validateMembers(additions);
      await checkSupergroup(this.state, g);
      const old = this.state.members(g),
        at = Date.now();
      const retainedMemberIds = new Set(old.filter(m => m.removedAt === undefined && input.members.some(b => sameBot(b, m.bot))).map(m => m.id));
      const memberSelections = g.memberModelSelections?.filter(row => retainedMemberIds.has(row.memberId));
      const removedMembers = old.some(m => m.removedAt === undefined && !retainedMemberIds.has(m.id));
      const addedMembers = input.members.some(bot => !old.some(m => m.removedAt === undefined && sameBot(m.bot, bot)));
      const membershipChanged = removedMembers || addedMembers;
      const removedSelections = (memberSelections?.length ?? 0) !== (g.memberModelSelections?.length ?? 0);
      const { memberModelSelections: _selections, ...record } = g;
      // Write intent revision first. A partial multi-table failure makes the group unavailable until reconciled.
      const next = {
        ...record,
        ...(memberSelections?.length ? { memberModelSelections: memberSelections } : {}),
        ...(removedMembers || removedSelections ? { modelRevision: (g.modelRevision ?? 0) + 1 } : {}),
        name: input.name,
        mode: input.mode,
        ...(input.onDemand !== undefined ? { onDemand: input.onDemand } : {}),
        memberRoles: (input.memberRoles ?? g.memberRoles ?? []).filter(row => input.members.some(bot => sameBot(bot, row.bot))),
        revision: g.revision + 1,
        membershipRevision: g.membershipRevision + Number(membershipChanged),
        ...(membershipChanged ? { exportApprovals: [] } : {}),
        updatedAt: at,
        state: 'recovery_needed' as const,
      };
      if (operation && operationKey) await this.state.table('member_edits').put(operationKey, { group: key, ...operation, status: 'unknown' });
      const nameChanged = next.name !== g.name;
      let membersCommitted = false;
      try {
        await this.state.putGroup(next);
        for (const m of old.filter((m) => m.removedAt === undefined && !input.members.some((b) => sameBot(b, m.bot)))) {
          await this.state.table('members').put(m.id, { ...m, enabled: false, removedAt: at });
          for (const t of this.state.turns(g).filter((t) => !terminal(t) || t.state === 'paused'))
            for (const d of this.state.deliveries(t.id).filter((d) => d.memberId === m.id)) {
              this.state.controllers.get(d.id)?.abort('member-removed');
              if (d.state === 'pending')
                await this.state.putDelivery({ ...d, state: 'cancelled', reasonCode: 'member-removed', endedAt: at });
            }
        }
        for (const [order, b] of input.members.entries()) {
          const previous = old.find((m) => m.removedAt === undefined && sameBot(m.bot, b));
          const member: GroupMember = previous
            ? { ...previous, order }
            : { id: `member:${randomUUID()}`, group: key, bot: b, order, joinedAt: at, enabled: true };
          await this.state.table('members').put(member.id, member);
        }
        membersCommitted = true;
        for (const turn of this.state.turns(g)) this.state.wakeTurns.get(turn.id)?.();
        let title = next.name;
        if (nameChanged) {
          await this.state.table('pending_renames').put(g.id, {
            group: key,
            revision: next.revision,
            name: next.name,
            ...(operationKey ? { operationKey } : {}),
          });
          title = await this.roots.rename(next);
        }
        const ready: GroupRecord = { ...next, name: title, state: 'ready' };
        await this.state.putGroup(ready);
        if (nameChanged) await this.state.table('pending_renames').delete(g.id);
        if (operation && operationKey) {
          await this.state.table('member_edits').put(operationKey, { group: key, ...operation, status: 'saved', result: ready });
          return { operationId: operation.operationId, status: 'saved', group: ready };
        }
        return ready;
      } catch (error) {
        this.state.ctx.logger?.warn?.('[dsh-bot] Group edit failed; recovery required', {
          groupId: g.id,
          phase: membersCommitted ? 'rename' : 'persist',
          ...redactedErrorMetadata(error),
        });
        this.state.reasons.set(g.id, 'recovery-needed');
        // A final receipt write can fail after ready committed. Keep every later edit
        // closed, including after restart, without assuming cross-table transactions.
        if (operation) await this.state.putGroup({ ...next, state: 'recovery_needed' }).catch(() => {});
        if (operation) return { operationId: operation.operationId, status: 'unknown' };
        throw new OperationError('recovery-needed');
      }
  }
}
