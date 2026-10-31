import type { WorkerBinding } from './worker-tool.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  groupKeySchema,
  groupRecordSchema,
  groupTurnSchema,
  groupDeliverySchema,
  type GroupKey,
  type GroupRecord,
  type GroupDelivery,
  type GroupTurn,
  type GroupSummary,
} from '../../shared/groups.js';
import type { BotKey } from '../../shared/integrations.js';
import type { DshBotRegistry } from '../registry.js';
import { OperationError, Serial, need, parse } from '../common/operations.js';

import type { groupsDomain } from './model.js';
/** A Controller-owned root is borrowed as an Agent reference, never fabricated as an AgentHandle. */
export type GroupRoot = { ownership: 'owned'; agent: Agent; handle: AgentHandle } | { ownership: 'borrowed'; agent: Agent };
/** Shared per-service state: one queue and one set of ownership/cancellation maps. */
export class GroupState {
  public queue = new Serial();
  public workers = new Map<string, WorkerBinding>();
  public offWorkers?: () => void;
  public stopped = false;
  public shutdownPhase = 'running';
  public closing?: Promise<void>;
  public roots = new Map<string, GroupRoot>();
  public reasons = new Map<string, GroupSummary['reason']>();
  private scheduling = new Map<string, { active: number; pending: { limit: number; start: () => void }[] }>();
  public chains = new Map<string, Promise<void>>();
  public controllers = new Map<string, AbortController>();
  public activations = new Map<string, SubagentActivation>();
  public settledInputs = new Set<string>();
  public inputAdmissions = new Map<string, AbortController>();
  public cancelledTurns = new Set<string>();
  public unregister?: () => Promise<void>;
  public offTitle?: () => void;
  public repairing = new Set<string>();
  public naming = new Set<string>();
  public titles = new Map<string, string>();
  public startup = new AbortController();
  constructor(
    public ctx: Context,
    public registry: DshBotRegistry,
    public domain: Domain<typeof groupsDomain>,
    public changed: () => void,
  ) {}
  /** Bounded FIFO admission: any released slot may start the next independent work. */
  schedule(groupId: string, limit: number, run: () => Promise<void>): Promise<void> {
    const lane = this.scheduling.get(groupId) ?? { active: 0, pending: [] };
    this.scheduling.set(groupId, lane);
    const pump = () => {
      while (lane.pending.length && lane.active < need(lane.pending[0]).limit) {
        const job = need(lane.pending.shift());
        lane.active++;
        job.start();
      }
      if (!lane.active && !lane.pending.length) this.scheduling.delete(groupId);
    };
    const completed = new Promise<void>((resolve, reject) => {
      lane.pending.push({ limit, start: () => {
        void Promise.resolve().then(run).then(resolve, reject).finally(() => { lane.active--; pump(); });
      } });
    });
    pump();
    return completed;
  }
  table<K extends 'groups' | 'members' | 'turns' | 'deliveries' | 'read_state'>(key: K) {
    return this.domain.table(key);
  }
  check() {
    if (this.stopped) throw new OperationError('unavailable');
  }
  record(key: GroupKey) {
    this.check();
    const k = parse(groupKeySchema, key);
    const g = this.table('groups').get(k.groupId);
    if (!g) throw new OperationError('not-found');
    if (g.createdAt !== k.groupCreatedAt) throw new OperationError('conflict');
    return g;
  }
  members(g: GroupRecord) {
    return [...this.table('members').entries()]
      .map(([, value]) => value)
      .filter((m) => m.group.groupId === g.id && m.group.groupCreatedAt === g.createdAt)
      .sort((a, b) => a.order - b.order);
  }
  deliveries(turn: string) {
    return [...this.table('deliveries').entries()]
      .map(([, value]) => value)
      .filter((d) => d.turnId === turn)
      .sort((a, b) => a.ordinal - b.ordinal);
  }
  turns(g: GroupRecord) {
    return [...this.table('turns').entries()]
      .map(([, value]) => value)
      .filter((t) => t.group.groupId === g.id && t.group.groupCreatedAt === g.createdAt)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async putGroup(g: GroupRecord) {
    await this.table('groups').put(g.id, parse(groupRecordSchema, g));
    this.changed();
  }
  async putTurn(t: GroupTurn) {
    const next = { ...t, updatedAt: Date.now(), revision: t.revision + 1 };
    await this.table('turns').put(t.id, parse(groupTurnSchema, next));
    this.changed();
    return next;
  }
  async putDelivery(d: GroupDelivery) {
    await this.table('deliveries').put(d.id, parse(groupDeliverySchema, d));
    this.changed();
  }
  route() {
    const route = need(this.ctx.get('agentDefaultModel')).currentSelection();
    if (!route.provider || !route.model) throw new OperationError('unavailable');
    return route;
  }
  async bot(key: BotKey) {
    const b = await this.registry.get(key.botId).catch(() => {
      throw new OperationError('conflict');
    });
    if (b.createdAt !== key.botCreatedAt) throw new OperationError('conflict');
    this.check();
    return b;
  }
  async validateMembers(keys: BotKey[]) {
    if (keys.length > this.registry.config.groupMaxMembers || new Set(keys.map((k) => k.botId)).size !== keys.length)
      throw new OperationError('invalid');
    const statuses = await this.registry.status();
    for (const key of keys) {
      await this.bot(key);
      if (statuses.find((s) => s.id === key.botId)?.preset.state !== 'ok') throw new OperationError('unavailable');
    }
  }
}
