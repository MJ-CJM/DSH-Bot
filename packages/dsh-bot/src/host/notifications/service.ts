import { notificationAdmission, notificationSend } from './data-flow.js';
import { outlets } from '../data-flow/tool-guard.js';
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { BotKey, NotificationRecord, NotifyInput } from '../../shared/integrations.js';
import {
  notificationSchema,
  notifyInputSchema,
  policyInputSchema,
  policySchema,
  sameBot,
  receiptSchema,
} from '../../shared/integrations.js';
import type { DshBotRegistry } from '../registry.js';
import { digest, need, OperationError, parse, Serial } from '../common/operations.js';
import {proactiveCopyScopeSchema,type ProactiveCopyScope} from '../../shared/proactive/governance.js';
import type { IntegrationStores } from '../common/integration-stores.js';
export interface NotificationPort {
  /** Safe display identity. Adapter must recheck this digest immediately before sending. */
  describe(targetRef: string): Promise<{ targetDigest: string; label: string }>;
  send(request: {
    targetRef: string;
    targetDigest: string;
    text: string;
    attemptId: string;
    signal: AbortSignal;
  }): Promise<{ state: 'accepted'; platformMessageId?: string } | { state: 'failed' | 'unknown' }>;
}
export { localTime, quietAt } from './time.js';
import { localTime, quietAt } from './time.js';
export interface NotificationOptions {
  dailyLimit: number;
  cooldownSec: number;
  retentionDays: number;
  maxRecords: number;
  sendTimeoutMs: number;
}
export class Notifications {
  readonly queue = new Serial();
  private stopping = false;
  private lifetime = new AbortController();
  private portLifetime = new AbortController();
  private sends = new Set<Promise<NotificationRecord>>();
  constructor(
    private ctx: Context,
    private stores: IntegrationStores,
    private registry: DshBotRegistry,
    readonly options: NotificationOptions,
    private changed: () => void,
    private port?: NotificationPort,
    private now: () => number = Date.now,
  ) {}
  attachPort(port: NotificationPort, owner: Context = this.ctx): () => void {
    return owner.effect(() => {
      if (this.port || this.stopping) throw new OperationError('conflict');
      this.portLifetime = new AbortController();
      this.port = port;
      this.changed();
      return () => {
        if (this.port === port) {
          this.portLifetime.abort();
          this.port = undefined;
          this.changed();
        }
      };
    }, 'dsh-bot: notification adapter');
  }
  supported() {
    return this.port !== undefined;
  }
  policies() {
    return [...this.stores.notifications.table('policies').entries()].map(([, r]) => structuredClone(r));
  }
  list() {
    return [...this.stores.notifications.table('intents').entries()]
      .map(([, r]) => structuredClone(r))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  policy(id: string) {
    const p = this.stores.notifications.table('policies').get(id);
    if (!p) throw new OperationError('not-found');
    return structuredClone(p);
  }
  private async assertBot(owner: BotKey) {
    const bot = await this.registry.get(owner.botId);
    if (bot.createdAt !== owner.botCreatedAt) throw new OperationError('conflict');
  }
  async recover() {
    await this.queue.run(async () => {
      for (const r of this.list())
        if (r.state === 'sending' || r.state === 'waiting_approval') {
          await this.put({
            ...r,
            state: r.state === 'sending' ? 'unknown' : 'cancelled',
            reasonCode: 'recovery-needed',
          });
        }
    });
  }
  async savePolicy(input: unknown, expected: number, confirmed: boolean) {
    if (this.stopping) throw new OperationError('unavailable');
    const value = parse(policyInputSchema, input);
    await this.assertBot(value.owner);
    if (value.authorization.mode === 'preapproved' && !confirmed) throw new OperationError('approval-denied');
    const target =
      value.channel === 'im'
        ? await this.port?.describe(need(value.targetRef))
        : { targetDigest: 'in-app', label: 'in-app' };
    // Unsupported IM can be saved disabled for later explicit configuration.
    if (!target && value.enabled) throw new OperationError('unsupported');
    return this.queue.run(async () => {
      const table = this.stores.notifications.table('policies'),
        old = table.get(value.id);
      if ((old?.revision ?? 0) !== expected || (old && !sameBot(old.owner, value.owner)))
        throw new OperationError('conflict');
      const at = this.now();
      const targetDigest = target?.targetDigest ?? 'unsupported';
      const row = parse(policySchema, {
        ...value,
        revision: expected + 1,
        targetDigest,
        scopeDigest: digest([value, targetDigest]),
        ...(value.authorization.mode === 'preapproved' ? { approvedAt: at } : {}),
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
        schemaVersion: 1,
      });
      await table.put(row.id, row);
      this.changed();
      return row;
    });
  }
  async record(owner: BotKey, input: NotifyInput, source: NotificationRecord['source'], signal?: AbortSignal) {
    if (this.stopping) throw new OperationError('unavailable');
    const value = parse(notifyInputSchema, input);
    await this.assertBot(owner);
    return this.queue.run(async () => {
      signal?.throwIfAborted();
      const existing = this.stores.notifications.table('intents').get(value.operationId);
      if (existing) {
        if (
          !sameBot(existing.owner, owner) ||
          existing.policyId !== value.policyId ||
          existing.text !== value.text ||
          digest(existing.source) !== digest(source)
        )
          throw new OperationError('conflict');
        return structuredClone(existing);
      }
      const p = this.policy(value.policyId);
      if (!sameBot(p.owner, owner)) throw new OperationError('not-found');
      if (source.kind === 'proactive-review' && (p.channel !== 'im' || !p.enabled || !outlets(this.registry)))
        throw new OperationError('unsupported');
      if (source.kind === 'proactive') {
        const at = this.now();
        const day = localTime(at, p.timezone).day;
        const prior = this.list().filter(row => row.policyId === p.id && row.source.kind === 'proactive');
        if (!p.enabled || p.channel !== 'in-app' || quietAt(at, p) ||
            prior.filter(row => localTime(row.createdAt, p.timezone).day === day).length >= p.dailyLimit ||
            prior.some(row => row.createdAt > at || row.createdAt + p.cooldownSec * 1000 > at))
          throw new OperationError('approval-denied');
      }
      // Keep a durable dedup ledger even after visible content retention expires.
      const ledger = this.stores.notifications.table('read_state');
      if (ledger.get(value.operationId)) throw new OperationError('recovery-needed');
      await this.prune();
      if (this.list().length >= this.options.maxRecords) throw new OperationError('unavailable');
      const at = this.now();
      const row = parse(notificationSchema, {
        id: value.operationId,
        operationId: value.operationId,
        owner,
        policyId: p.id,
        policyRevision: p.revision,
        scopeDigest: p.scopeDigest,
        targetDigest: p.targetDigest,
        text: value.text,
        source,
        state: 'recorded',
        revision: 1,
        createdAt: at,
        updatedAt: at,
        schemaVersion: 1,
      });
      const flow = outlets(this.registry), flowId = await notificationAdmission(this.registry, owner, row);
      if (flowId) row.flowId = flowId;
      const save = async () => {
      signal?.throwIfAborted();
      // Intent is the authoritative ledger. Tombstone first means a partial write
      // can lose a local record but can never authorize a duplicate external send.
      await ledger.put(row.id, { id: row.id, owner, revision: 1, createdAt: at, updatedAt: at, schemaVersion: 1 });
      await this.stores.notifications.table('intents').put(row.id, row);
      };
      if (flowId) await need(flow).dispatch(flowId, save, signal); else await save();
      this.changed();
      return row;
    });
  }
  async waiting(id: string) {
    return this.queue.run(async () => {
      const r = this.get(id);
      return r.state === 'recorded' ? this.put({ ...r, state: 'waiting_approval' }) : r;
    });
  }
  get(id: string) {
    const r = this.stores.notifications.table('intents').get(id);
    if (!r) throw new OperationError('not-found');
    return structuredClone(r);
  }
  async reject(id: string, reasonCode: 'approval-denied' | 'changed' = 'approval-denied') {
    return this.queue.run(async () => {
      const r = this.get(id);
      return ['recorded', 'waiting_approval'].includes(r.state)
        ? this.put({ ...r, state: 'cancelled', reasonCode })
        : r;
    });
  }
  async markRead(id: string, expected: number) {
    return this.queue.run(async () => {
      const r = this.get(id);
      if (r.revision !== expected) throw new OperationError('conflict');
      return this.put({ ...r, readAt: this.now() });
    });
  }
  private async put(row: NotificationRecord) {
    const value = parse(notificationSchema, {
      ...row,
      revision: row.revision + 1,
      updatedAt: Math.max(this.now(), row.updatedAt),
    });
    await this.stores.notifications.table('intents').put(value.id, value);
    this.changed();
    return value;
  }
  private reviewDigest(row: NotificationRecord, label: string) {
    return digest([row.operationId, row.owner, row.policyId, row.policyRevision, row.scopeDigest,
      row.targetDigest, label, row.text, row.source]);
  }
  async previewReviewed(id: string) {
    const row = this.get(id), policy = this.policy(row.policyId), port = this.port;
    if (this.stopping || row.source.kind !== 'proactive-review' || !port || !policy.enabled ||
        policy.channel !== 'im' || policy.revision !== row.policyRevision ||
        policy.scopeDigest !== row.scopeDigest || policy.targetDigest !== row.targetDigest)
      throw new OperationError('unsupported');
    const target = await port.describe(need(policy.targetRef));
    if (this.port !== port || target.targetDigest !== policy.targetDigest)
      throw new OperationError('conflict');
    return {
      id: row.id, state: row.state, text: row.text, targetRef: need(policy.targetRef),
      label: target.label, digest: this.reviewDigest(row, target.label),
    };
  }
  deliver(id: string, approvedScope?: string, signal?: AbortSignal) {
    return this.deliverInternal(id, approvedScope, signal);
  }
  deliverReviewed(id: string, reviewedDigest: string, signal: AbortSignal, check: () => Promise<void>) {
    return this.deliverInternal(id, undefined, signal, { digest: reviewedDigest, check });
  }
  private async deliverInternal(id: string, approvedScope?: string, signal?: AbortSignal,
    review?: { digest: string; check: () => Promise<void> }) {
    const reserved = await this.queue.run(async () => {
      const r = this.get(id);
      if (!['recorded', 'waiting_approval'].includes(r.state)) return { record: r };
      const reviewed = r.source.kind === 'proactive-review';
      if (reviewed !== !!review) throw new OperationError('approval-denied');
      const p = this.policy(r.policyId);
      await this.assertBot(r.owner);
      if (p.revision !== r.policyRevision || p.scopeDigest !== r.scopeDigest || p.targetDigest !== r.targetDigest)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'changed' }) };
      if (!p.enabled) return { record: await this.put({ ...r, state: 'suppressed', reasonCode: 'disabled' }) };
      if (signal?.aborted || this.stopping)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'stopping' }) };
      if (r.source.kind === 'proactive' && p.channel !== 'in-app')
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'unsupported' }) };
      if (p.channel === 'in-app') return { record: await notificationSend(this.ctx, this.registry, r, p, () => this.policy(r.policyId),
        () => this.put({ ...r, state: 'recorded' }), signal ?? this.lifetime.signal) };
      if (!reviewed && p.authorization.mode === 'ask' && approvedScope !== r.scopeDigest)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'approval-denied' }) };
      const port = this.port;
      if (!port) return { record: await this.put({ ...r, state: 'failed', reasonCode: 'unsupported' }) };
      const portSignal = this.portLifetime.signal;
      let target: Awaited<ReturnType<NotificationPort['describe']>>;
      try {
        target = await port.describe(need(p.targetRef));
      } catch {
        return { record: await this.put({ ...r, state: 'failed', reasonCode: 'unsupported' }) };
      }
      if (review && this.reviewDigest(r, target.label) !== review.digest)
        throw new OperationError('conflict');
      if (target.targetDigest !== p.targetDigest)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'changed' }) };
      const at = this.now(),
        day = localTime(at, p.timezone).day;
      const reservations = this.list().filter((row) => sameBot(row.owner, r.owner) && row.reservation);
      const latest = reservations.reduce((max, row) => Math.max(max, row.reservation?.at ?? 0), 0);
      let reason: NotificationRecord['reasonCode'];
      if (quietAt(at, p)) reason = 'quiet-hours';
      else if (
        p.dailyLimit === 0 ||
        reservations.filter((row) => localTime(row.reservation?.at ?? 0, p.timezone).day === day).length >=
          p.dailyLimit ||
        at < latest
      )
        reason = 'daily-limit';
      else if (latest > 0 && at - latest < p.cooldownSec * 1000) reason = 'cooldown';
      if (reason) return { record: await this.put({ ...r, state: 'suppressed', reasonCode: reason }) };
      await review?.check();
      signal?.throwIfAborted();
      if (this.port !== port || portSignal.aborted) throw new OperationError('conflict');
      const record = await this.put({ ...r, state: 'sending', reservation: { at, day }, attemptId: randomUUID(),
        ...(review ? { reviewedDigest: review.digest } : {}) });
      return { record, policy: p, port, portSignal };
    });
    if (!reserved.policy) return reserved.record;
    const task = (async () => {
      let result: Awaited<ReturnType<NotificationPort['send']>>;
      if (this.stopping || reserved.portSignal?.aborted || signal?.aborted) {
        return this.queue.run(async () => this.put({ ...this.get(id), state: 'cancelled', reasonCode: 'stopping' }));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new AbortController();
      try {
        const dispatchSignal = AbortSignal.any([
          ...(signal ? [signal] : []), this.lifetime.signal, need(reserved.portSignal), deadline.signal,
        ]);
        const send = async () => {
          const port = need(reserved.port), targetRef = need(reserved.policy.targetRef);
          if (review) {
            await review.check();
            const target = await port.describe(targetRef);
            if (target.targetDigest !== reserved.policy.targetDigest ||
                this.reviewDigest(reserved.record, target.label) !== review.digest)
              throw new OperationError('conflict');
          }
          dispatchSignal.throwIfAborted();
          const current = this.policy(reserved.record.policyId);
          if (!current.enabled || current.revision !== reserved.record.policyRevision ||
              current.targetDigest !== reserved.record.targetDigest || current.scopeDigest !== reserved.record.scopeDigest)
            throw new OperationError('conflict');
          return port.send({ targetRef, targetDigest: reserved.policy.targetDigest, text: reserved.record.text,
            attemptId: need(reserved.record.attemptId), signal: dispatchSignal });
        };
        result = await Promise.race([
          notificationSend(this.ctx, this.registry, reserved.record, reserved.policy,
            () => this.policy(reserved.record.policyId), send, dispatchSignal, !!review),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              deadline.abort();
              reject(new OperationError('recovery-needed'));
            }, this.options.sendTimeoutMs);
          }),
        ]);
      } catch {
        result = { state: 'unknown' };
      } finally {
        if (timer) clearTimeout(timer);
      }
      return this.queue.run(async () => {
        const r = this.get(id);
        const record = await this.put({
          ...r,
          state: result.state,
          ...(result.state === 'accepted' && result.platformMessageId
            ? { platformMessageId: result.platformMessageId }
            : {}),
          ...(result.state === 'failed'
            ? { reasonCode: 'transport-failed' }
            : result.state === 'unknown'
              ? { reasonCode: 'recovery-needed' }
              : {}),
        });
        const receipt = parse(receiptSchema, {
          id: need(r.attemptId),
          intentId: r.id,
          attemptId: r.attemptId,
          channel: 'im',
          state: record.state,
          ...(record.state === 'accepted' ? { acceptedAt: this.now() } : {}),
          ...(record.platformMessageId ? { platformMessageId: record.platformMessageId } : {}),
          revision: 1,
          createdAt: this.now(),
          updatedAt: this.now(),
          schemaVersion: 1,
        });
        await this.stores.notifications.table('receipts').put(receipt.id, receipt);
        return record;
      });
    })();
    this.sends.add(task);
    try {
      return await task;
    } finally {
      this.sends.delete(task);
    }
  }
  private async prune() {
    const threshold = this.now() - this.options.retentionDays * 86400000;
    const rows = this.list().sort((a, b) => a.createdAt - b.createdAt);
    let count = rows.length;
    for (const r of rows) {
      if (
        ['sending', 'waiting_approval'].includes(r.state) ||
        (r.reservation && localTime(r.reservation.at, 'UTC').day >= localTime(this.now() - 86400000, 'UTC').day)
      )
        continue;
      if (r.createdAt < threshold || count >= this.options.maxRecords) {
        await this.stores.notifications.table('intents').delete(r.id);
        count--;
      }
    }
  }
  async forgetCleanup(epoch: number) {
    await Promise.allSettled([...this.sends]);
    await this.queue.run(async () => {
      const flow = outlets(this.registry);
      for (const row of this.list()) {
        const copy = row.flowId && flow?.get(row.flowId);
        if (copy && copy.envelope?.binding.epoch === epoch) continue;
        await this.stores.notifications.table('intents').delete(row.id);
      }
      this.changed();
    });
  }
  private proactiveCopies(input:ProactiveCopyScope) {
    const scope=proactiveCopyScopeSchema.parse(input),assignments=new Set(scope.assignmentIds),operations=new Set(scope.notificationOperationIds);
    return this.list().filter(row=>['proactive','proactive-review'].includes(row.source.kind)&&(operations.has(row.operationId)||assignments.has(row.source.id)));
  }
  proactiveCopyStatus(scope:ProactiveCopyScope) {
    const rows=this.proactiveCopies(scope),flow=outlets(this.registry);
    const refs=[...rows.map(row=>({operationId:row.operationId,flowId:row.flowId,sessionId:row.source.sessionId})),...(flow?.proactiveNotificationCopyRefs(scope.notificationOperationIds)??[])];
    return {blockedOperationIds:[...new Set([...rows.filter(row=>row.state==='sending'||row.state==='unknown').map(row=>row.operationId),...(flow?.notificationCopyStatus(refs)??[])])]};
  }
  /** Source-specific redaction leaves dedup, attempt state and attention charges
   * intact. It cannot erase uncertain external sends or any ordinary notices. */
  async purgeProactiveCopies(scope:ProactiveCopyScope) {
    return this.queue.run(async()=>{
      const rows=this.proactiveCopies(scope),status=this.proactiveCopyStatus(scope);
      if(status.blockedOperationIds.length)return {...status,purged:0,flowCopies:0};
      const flow=outlets(this.registry),refs=[...rows.map(row=>({operationId:row.operationId,flowId:row.flowId,sessionId:row.source.sessionId})),...(flow?.proactiveNotificationCopyRefs(scope.notificationOperationIds)??[])];
      const flows=await flow?.purgeNotificationCopies(refs);
      if(flows?.blockedOperationIds.length)return {blockedOperationIds:flows.blockedOperationIds,purged:0,flowCopies:0};
      let purged=0;
      for(const row of rows){
        if(row.redactedAt!==undefined)continue;
        await this.put({...row,text:'[redacted]',bodyDigest:digest({text:row.text,source:row.source}),redactedAt:this.now(),...(row.state==='waiting_approval'?{state:'cancelled' as const}:{} )});purged++;
      }
      return {purged,flowCopies:flows?.purged??0,blockedOperationIds:[]};
    });
  }
  async close() {
    this.stopping = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.sends]);
    await this.queue.close();
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotNotifications: Notifications;
  }
}
