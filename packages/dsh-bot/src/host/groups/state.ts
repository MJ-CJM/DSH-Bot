import type { WorkerBinding } from './worker-tool.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent';
import type { Domain, DomainChanged } from '@deepseek-ai/dsh-storage-domain';
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
type RecordIndex = { byOwner: Map<string, Set<string>>; ownerById: Map<string, string> };
const groupOwner = (key: GroupKey) => JSON.stringify([key.groupId, key.groupCreatedAt]);

function indexRecord(index: RecordIndex, id: string, owner?: string) {
  const previous = index.ownerById.get(id);
  if (previous === owner) return;
  if (previous !== undefined) {
    const ids = index.byOwner.get(previous);
    ids?.delete(id);
    if (!ids?.size) index.byOwner.delete(previous);
    index.ownerById.delete(id);
  }
  if (owner === undefined) return;
  const ids = index.byOwner.get(owner) ?? new Set<string>();
  ids.add(id);
  index.byOwner.set(owner, ids);
  index.ownerById.set(id, owner);
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Post-commit wake only. Readers recheck the authoritative group snapshots outside this queue. */
    'dsh-bot/group-fact-changed'(group: GroupKey, turnId?: string): void;
  }
}
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
  public wakeTurns = new Map<string, () => void>();
  public cancelledTurns = new Set<string>();
  public unregister?: () => Promise<void>;
  public offTitle?: () => void;
  public repairing = new Set<string>();
  public naming = new Set<string>();
  public titles = new Map<string, string>();
  public startup = new AbortController();
  private deliveryWrites = new Map<string, Promise<void>>();
  private turnIndex: RecordIndex = { byOwner: new Map(), ownerById: new Map() };
  private deliveryIndex: RecordIndex = { byOwner: new Map(), ownerById: new Map() };
  private releaseIndex: () => void;
  constructor(
    public ctx: Context,
    public registry: DshBotRegistry,
    public domain: Domain<typeof groupsDomain>,
    public changed: () => void,
  ) {
    this.releaseIndex = ctx.effect(() => ctx.on('domain/changed', change => this.updateIndex(change)), 'dsh-bot: group record index');
    for (const [id, turn] of this.table('turns').entries()) indexRecord(this.turnIndex, id, groupOwner(turn.group));
    for (const [id, delivery] of this.table('deliveries').entries()) indexRecord(this.deliveryIndex, id, delivery.turnId);
  }
  private updateIndex(change: DomainChanged) {
    if (change.domain !== this.domain.name) return;
    if (change.table === 'turns') {
      const turn = this.table('turns').get(change.key);
      indexRecord(this.turnIndex, change.key, turn && groupOwner(turn.group));
    } else if (change.table === 'deliveries') {
      indexRecord(this.deliveryIndex, change.key, this.table('deliveries').get(change.key)?.turnId);
    }
  }
  closeIndex() {
    this.releaseIndex();
    this.turnIndex.byOwner.clear();
    this.turnIndex.ownerById.clear();
    this.deliveryIndex.byOwner.clear();
    this.deliveryIndex.ownerById.clear();
  }
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
  readonly proactiveChecks = new Map<string, () => Promise<void>>();
  /** Recent in-process cleanup proofs, never reconstructed from delivery status. */
  readonly proactiveDrains = new Map<string, boolean>();
  readonly proactiveAllowances = new Map<string, { inputAllowance: number; outputAllowance: number }>();
  recordProactiveAllowance(deliveryId: string, allowance: { inputAllowance: number; outputAllowance: number }) {
    this.proactiveAllowances.set(deliveryId, allowance);
    while (this.proactiveAllowances.size > 256) {
      const oldest = this.proactiveAllowances.keys().next().value;
      if (oldest !== undefined) this.proactiveAllowances.delete(oldest);
    }
  }
  recordProactiveDrain(deliveryId: string, proved: boolean) {
    this.proactiveDrains.set(deliveryId, proved);
    while (this.proactiveDrains.size > 256) {
      const oldest = this.proactiveDrains.keys().next().value;
      if (oldest !== undefined) this.proactiveDrains.delete(oldest);
    }
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
    const table = this.table('deliveries');
    return Array.from(this.deliveryIndex.byOwner.get(turn) ?? [], id => table.get(id))
      .filter(row => row !== undefined)
      .sort((a, b) => a.ordinal - b.ordinal);
  }
  turns(g: GroupRecord) {
    const table = this.table('turns');
    return Array.from(this.turnIndex.byOwner.get(groupOwner({ groupId: g.id, groupCreatedAt: g.createdAt })) ?? [], id => table.get(id))
      .filter(row => row !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async putGroup(g: GroupRecord) {
    const previous = this.table('groups').get(g.id);
    await this.table('groups').put(g.id, parse(groupRecordSchema, g));
    this.changed();
    if (previous && (previous.archived !== g.archived || previous.membershipRevision !== g.membershipRevision ||
        previous.state !== g.state)) this.factChanged({ groupId: g.id, groupCreatedAt: g.createdAt });
  }
  async putTurn(t: GroupTurn) {
    const table = this.table('turns');
    const previous = table.get(t.id);
    const next = { ...t, updatedAt: Date.now(), revision: Math.max(previous?.revision ?? 0, t.revision) + 1 };
    await table.put(t.id, parse(groupTurnSchema, next));
    this.changed();
    this.factChanged(next.group, next.id);
    return next;
  }
  putDelivery(d: GroupDelivery): Promise<void> {
    const write = (this.deliveryWrites.get(d.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const previous = this.table('deliveries').get(d.id);
      const next = { ...d, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() };
      await this.table('deliveries').put(d.id, parse(groupDeliverySchema, next));
      this.changed();
      const turn = this.table('turns').get(d.turnId);
      if (turn) this.factChanged(turn.group, turn.id);
    });
    this.deliveryWrites.set(d.id, write);
    const release = () => { if (this.deliveryWrites.get(d.id) === write) this.deliveryWrites.delete(d.id); };
    void write.then(release, release);
    return write;
  }
  private factChanged(group: GroupKey, turnId?: string) {
    try { this.ctx.emit('dsh-bot/group-fact-changed', group, turnId); }
    catch { this.ctx.logger.warn('[dsh-bot] committed group change could not wake local follow-up'); }
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
