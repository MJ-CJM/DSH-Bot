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
  async record(owner: BotKey, input: NotifyInput, source: NotificationRecord['source']) {
    if (this.stopping) throw new OperationError('unavailable');
    const value = parse(notifyInputSchema, input);
    await this.assertBot(owner);
    return this.queue.run(async () => {
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
      // Intent is the authoritative ledger. Tombstone first means a partial write
      // can lose a local record but can never authorize a duplicate external send.
      await ledger.put(row.id, { id: row.id, owner, revision: 1, createdAt: at, updatedAt: at, schemaVersion: 1 });
      await this.stores.notifications.table('intents').put(row.id, row);
      };
      if (flowId) await need(flow).dispatch(flowId, save); else await save();
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
  async deliver(id: string, approvedScope?: string, signal?: AbortSignal) {
    const reserved = await this.queue.run(async () => {
      const r = this.get(id);
      if (!['recorded', 'waiting_approval'].includes(r.state)) return { record: r };
      const p = this.policy(r.policyId);
      await this.assertBot(r.owner);
      if (p.revision !== r.policyRevision || p.scopeDigest !== r.scopeDigest || p.targetDigest !== r.targetDigest)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'changed' }) };
      if (!p.enabled) return { record: await this.put({ ...r, state: 'suppressed', reasonCode: 'disabled' }) };
      if (signal?.aborted || this.stopping)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'stopping' }) };
      if (p.channel === 'in-app') return { record: await notificationSend(this.ctx, this.registry, r, p, () => this.policy(r.policyId),
        () => this.put({ ...r, state: 'recorded' }), signal ?? this.lifetime.signal) };
      if (p.authorization.mode === 'ask' && approvedScope !== r.scopeDigest)
        return { record: await this.put({ ...r, state: 'cancelled', reasonCode: 'approval-denied' }) };
      if (!this.port) return { record: await this.put({ ...r, state: 'failed', reasonCode: 'unsupported' }) };
      let target: Awaited<ReturnType<NotificationPort['describe']>>;
      try {
        target = await this.port.describe(need(p.targetRef));
      } catch {
        return { record: await this.put({ ...r, state: 'failed', reasonCode: 'unsupported' }) };
      }
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
      const record = await this.put({ ...r, state: 'sending', reservation: { at, day }, attemptId: randomUUID() });
      return { record, policy: p, port: this.port, portSignal: this.portLifetime.signal };
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
        result = await Promise.race([
          notificationSend(this.ctx, this.registry, reserved.record, reserved.policy,
            () => this.policy(reserved.record.policyId), () => need(reserved.port).send({
            targetRef: need(reserved.policy.targetRef),
            targetDigest: reserved.policy.targetDigest,
            text: reserved.record.text,
            attemptId: need(reserved.record.attemptId),
            signal: AbortSignal.any([
              ...(signal ? [signal] : []),
              this.lifetime.signal,
              need(reserved.portSignal),
              deadline.signal,
            ]),
          }), AbortSignal.any([...(signal ? [signal] : []), this.lifetime.signal, need(reserved.portSignal), deadline.signal])),
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
