import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import { GROUP_ROOT_PRESET, groupKeySchema, type GroupKey, type GroupRecord } from '../../shared/groups.js';
import { OperationError, parse } from '../common/operations.js';
import { terminal, type GroupDeletion } from './model.js';
import type { GroupRoots } from './roots.js';
import type { GroupState } from './state.js';

/** A restore writes another setup event, so only the original create or a bound
 * historical turn can attest to the root of a group created by an older release. */
function rootEvidence(events: readonly SessionEvent[], group: GroupRecord, turnInputs: ReadonlySet<string>) {
  for (const event of events) {
    if (event.type === 'agent/inbox/spliced') {
      for (const { source } of event.data.inserted) {
        if (source.kind === 'dsh-bot-group-setup' && source.operation === 'create')
          return source.group.groupId === group.id && source.group.groupCreatedAt === group.createdAt && source.operationId === group.operationId;
      }
    }
    if (event.type === 'user/message' && turnInputs.has(event.data.id)) {
      const source = event.data.source;
      if ('group' in source && source.group && typeof source.group === 'object' &&
          'groupId' in source.group && 'groupCreatedAt' in source.group)
        return source.group.groupId === group.id && source.group.groupCreatedAt === group.createdAt;
    }
  }
}

/** The native log and plugin records have different owners and durability boundaries. */
export class GroupDeletionService {
  constructor(private state: GroupState, private roots: GroupRoots,
    private proactiveCopies: (group: GroupRecord, mode: 'check' | 'purge') => Promise<boolean>) {}

  remove(input: GroupKey, revision: number) {
    const key = parse(groupKeySchema, input);
    return this.state.queue.run(async () => {
      this.state.check();
      const records = this.state.table('groups');
      const receipts = this.state.table('deletions');
      const group = records.get(key.groupId);
      const previous = receipts.get(key.groupId);
      if (previous && (previous.group.groupCreatedAt !== key.groupCreatedAt || previous.revision !== revision))
        throw new OperationError('conflict');
      if (!group) {
        if (!previous) throw new OperationError('not-found');
        if (!previous.complete) await this.finish(previous);
        return true;
      }
      if (group.createdAt !== key.groupCreatedAt || group.revision !== revision ||
          previous && previous.rootSessionId !== group.rootSessionId) throw new OperationError('conflict');
      if (group.supergroup) throw new OperationError('unsupported');
      if (this.state.turns(group).some(turn => this.state.chains.has(turn.id) || !terminal(turn) || turn.state === 'paused'))
        throw new OperationError('busy');
      const id = group.rootSessionId as SessionId;
      const hasRoot = await this.checkRoot(group, id);
      const receipt = previous ?? { group: key, revision, rootSessionId: id, complete: false };
      if (!previous) {
        if (!await this.proactiveCopies(group, 'check')) throw new OperationError('recovery-needed');
        await receipts.put(group.id, receipt);
      }
      if (hasRoot) {
        try {
          // Native admission refuses active work and clears an existing sidebar pin.
          await this.state.ctx.workspaceRegistry.archiveSession(id);
        } catch (error) {
          if (!this.state.ctx.workspaceRegistry.archivedSessionIds.includes(id)) await receipts.delete(group.id);
          if (error instanceof Error && error.name === 'WorkspaceActiveSessionError') throw new OperationError('busy');
          throw new OperationError('recovery-needed');
        }
      }
      await this.finish(receipt);
      return true;
    });
  }

  /** Resolve a crash between native archival and the deletion of plugin records. */
  async recover() {
    for (const [id, receipt] of this.state.table('deletions').entries()) {
      if (receipt.complete) continue;
      try {
        const group = this.state.table('groups').get(id);
        if (!group || this.state.ctx.workspaceRegistry.archivedSessionIds.includes(receipt.rootSessionId as SessionId))
          await this.finish(receipt);
        else await this.state.table('deletions').delete(id);
      } catch {
        this.state.reasons.set(id, 'recovery-needed');
        this.state.ctx.logger.warn('[dsh-bot] group deletion pending recovery');
      }
    }
  }

  private async checkRoot(group: GroupRecord, id: SessionId) {
    const { ctx } = this.state;
    if (Array.from(this.state.table('groups').entries()).some(([other, record]) => other !== group.id && record.rootSessionId === id))
      throw new OperationError('recovery-needed');
    const owned = this.state.roots.get(group.id);
    const live = ctx.agents.get(id);
    if (owned && owned.agent !== live) throw new OperationError('recovery-needed');
    const session = live?.session ?? ctx.sessions.get(id);
    const persistence = ctx.get('sessionPersistence');
    if (!session && !persistence) throw new OperationError('recovery-needed');
    const header = session?.header ?? (await persistence?.stat(id))?.header;
    if (!header) return false; // Definitely missing. Only the plugin's stranded group is removed.
    if (header.id !== id || header.agentPreset !== GROUP_ROOT_PRESET || header.cwd !== group.cwd ||
        header.createdAt < group.createdAt || header.isSeeded || header.parentSession || header.origin === 'subagent' ||
        (header.delegationDepth ?? 0) !== 0) throw new OperationError('recovery-needed');
    let selected: unknown;
    if (session) selected = ctx.get('sessionProjections')?.stateOf(session, 'agentPreset');
    else {
      const projected = await ctx.sessionController.projections({ sessionId: id }, this.state.startup.signal);
      if (projected?.kind !== 'sequenced') throw new OperationError('recovery-needed');
      selected = projected.values.agentPreset;
    }
    if (selected !== undefined && selected !== GROUP_ROOT_PRESET) throw new OperationError('recovery-needed');
    const inputs = new Set(this.state.turns(group).map(turn => turn.inputMessageId));
    let proof: boolean | undefined;
    if (session) proof = rootEvidence(session.snapshotEvents(), group, inputs);
    else if (persistence) {
      const handle = await persistence.open(id, 'read', { signal: this.state.startup.signal });
      try {
        for (let offset = 0; proof === undefined;) {
          const { events } = await handle.read(offset, 64, { signal: this.state.startup.signal });
          proof = rootEvidence(events, group, inputs);
          if (events.length < 64) break;
          offset += events.length;
        }
      } finally { await handle.close(); }
    }
    if (!proof) throw new OperationError('recovery-needed');
    if (owned) await this.roots.flush(owned);
    return true;
  }

  private async finish(receipt: GroupDeletion) {
    const key = receipt.group;
    const id = key.groupId;
    const groups = this.state.table('groups');
    const group = groups.get(id);
    if (group && (group.createdAt !== key.groupCreatedAt || group.revision !== receipt.revision ||
        group.rootSessionId !== receipt.rootSessionId || group.supergroup)) throw new OperationError('conflict');
    // The assignment purge uses the still-authoritative turn/delivery references. Clean
    // only their exact copies before removing those references, including on a retry.
    if (group && !await this.proactiveCopies(group, 'purge')) throw new OperationError('recovery-needed');
    const root = this.state.roots.get(id);
    if (root) {
      if (root.agent.id !== receipt.rootSessionId) throw new OperationError('recovery-needed');
      await this.roots.release(root);
      this.state.roots.delete(id);
    }
    // Remove the authoritative group before collecting dependents. A durable receipt
    // prevents create retries from recreating the same group during or after cleanup.
    await groups.delete(id);
    this.state.reasons.delete(id);
    this.state.titles.delete(receipt.rootSessionId);
    this.state.changed();
    this.state.factChanged(key);
    const belongs = (owner: GroupKey) => owner.groupId === id && owner.groupCreatedAt === key.groupCreatedAt;
    for (const [turnId, turn] of this.state.table('turns').entries()) {
      if (!belongs(turn.group)) continue;
      for (const delivery of this.state.deliveries(turnId)) await this.state.table('deliveries').delete(delivery.id);
      await this.state.table('turns').delete(turnId);
    }
    for (const [memberId, member] of this.state.table('members').entries()) {
      if (belongs(member.group)) await this.state.table('members').delete(memberId);
    }
    const read = this.state.table('read_state').get(id);
    if (read && belongs(read.group)) await this.state.table('read_state').delete(id);
    const pendingRename = this.state.table('pending_renames').get(id);
    if (pendingRename && belongs(pendingRename.group)) await this.state.table('pending_renames').delete(id);
    await this.state.exportReviews?.table('closures').delete(JSON.stringify([id, key.groupCreatedAt]));
    await this.state.table('deletions').put(id, { ...receipt, complete: true });
  }
}
