import { groupExportApprovalInputSchema, type GroupKey } from '../../shared/groups.js';
import type { BotKey } from '../../shared/identity.js';
import { OperationError, parse } from '../common/operations.js';
import { autoExportAllowed } from './context-flow.js';
import { sameBot, sameGroupReaders } from './model.js';
import { checkSupergroup, groupReaders } from './supergroup-admission.js';
import type { GroupState } from './state.js';

/** Owner preferences authorize future exact-content checks; they never publish held replies. */
export class GroupExportSettings {
  constructor(private state: GroupState) {}
  get(key: GroupKey, signal?: AbortSignal) {
    return this.state.queue.run(async () => {
      signal?.throwIfAborted();
      const g = this.state.record(key), members = groupReaders(this.state, g);
      const hasPendingRename = Boolean(this.state.table?.('pending_renames').get(g.id));
      let canEnable = !g.archived && g.state === 'ready' && !this.state.reasons.has(g.id) && !hasPendingRename;
      try { await checkSupergroup(this.state, g); } catch { canEnable = false; }
      const readers = [];
      for (const bot of members) {
        try { readers.push({ bot, name: (await this.state.bot(bot)).name }); }
        catch { canEnable = false; readers.push({ bot, name: bot.botId }); }
      }
      signal?.throwIfAborted();
      const current = this.state.record(key);
      if (current.revision !== g.revision || current.membershipRevision !== g.membershipRevision ||
        !sameGroupReaders(members, groupReaders(this.state, current))) throw new OperationError('conflict');
      const eligibleBots = this.state.members(g).filter(m => m.enabled && m.removedAt === undefined &&
        members.some(bot => sameBot(bot, m.bot))).map(m => m.bot);
      return { groupRevision: g.revision, membershipRevision: g.membershipRevision, readers, eligibleBots,
        enabledBots: eligibleBots.filter(bot => autoExportAllowed(this.state, current, bot)), canEnable };
    });
  }
  set(key: GroupKey, bot: BotKey, enabled: boolean, expectedRevision: number, expectedMembershipRevision: number,
    signal?: AbortSignal) {
    const input = parse(groupExportApprovalInputSchema, { bot, enabled, expectedRevision, expectedMembershipRevision });
    return this.state.queue.run(async () => {
      signal?.throwIfAborted();
      const g = this.state.record(key);
      if (g.revision !== input.expectedRevision || g.membershipRevision !== input.expectedMembershipRevision)
        throw new OperationError('conflict');
      const members = groupReaders(this.state, g);
      if (input.enabled) {
        if (g.archived || g.state !== 'ready' || this.state.reasons.has(g.id) || this.state.table?.('pending_renames').get(g.id)) throw new OperationError('recovery-needed');
        if (!this.state.members(g).some(m => m.enabled && m.removedAt === undefined && sameBot(m.bot, input.bot)) ||
          !members.some(member => sameBot(member, input.bot))) throw new OperationError('invalid');
        await checkSupergroup(this.state, g);
        for (const reader of members) await this.state.bot(reader);
      }
      signal?.throwIfAborted();
      const current = this.state.record(key);
      if (current.revision !== input.expectedRevision || current.membershipRevision !== input.expectedMembershipRevision ||
        !sameGroupReaders(members, groupReaders(this.state, current))) throw new OperationError('conflict');
      const approvals = (current.exportApprovals ?? []).filter(row => !sameBot(row.bot, input.bot));
      const at = Date.now();
      const next = { ...current, revision: current.revision + 1, updatedAt: at, exportApprovals: [
        ...approvals, ...(input.enabled ? [{ bot: input.bot, members, membershipRevision: current.membershipRevision, enabledAt: at }] : []),
      ] };
      await this.state.putGroup(next);
      return next;
    });
  }
}
