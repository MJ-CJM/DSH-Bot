import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { SessionId } from '@deepseek-ai/dsh-session';
import {
  GROUP_ROOT_PRESET,
  groupKey,
  groupCreateSchema,
  groupEditSchema,
  type GroupKey,
  type GroupRecord,
  type GroupMember,
} from '../../shared/groups.js';
import { OperationError, digest, parse } from '../common/operations.js';
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
      const cwd = input.cwd ?? resolve(this.state.registry.config.dataDir, 'groups', id.slice(6));
      if (input.cwd)
        await validateDefaultCwd(cwd).catch(() => {
          throw new OperationError('invalid');
        });
      else await mkdir(cwd, { recursive: true, mode: 0o700 });
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
        this.state.roots.set(g.id, h);
        const title = await this.roots.rename(g);
        await this.roots.flush(h);
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
      // Write intent revision first. A partial multi-table failure makes the group unavailable until reconciled.
      const next = {
        ...g,
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
