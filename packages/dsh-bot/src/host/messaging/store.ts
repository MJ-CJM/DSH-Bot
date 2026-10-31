import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  messageRecordSchema,
  threadSchema,
  reservationSchema,
  dedupeSchema,
  readStateSchema,
  type MessageRecord,
} from '../../shared/messaging.js';
import { digest, OperationError } from '../common/operations.js';
import type { MessagingConfig } from './config.js';
export const messagingDomain = defineDomain({
  name: 'dsh_bot_messaging',
  version: 1,
  tables: {
    messages: domainTable(messageRecordSchema),
    threads: domainTable(threadSchema),
    limits: domainTable(reservationSchema),
    dedupe: domainTable(dedupeSchema),
    read_state: domainTable(readStateSchema),
  },
});
export type MessagingDomain = Domain<typeof messagingDomain>;
const states = new WeakMap<MessagingDomain, { tail: Promise<unknown>; closing: boolean }>();
const terminal = new Set(['canceled', 'expired', 'failed']);
export const keyOf = (key: { botId: string; botCreatedAt: number }) =>
  JSON.stringify([key.botId, key.botCreatedAt]);
export class MessageStore {
  private state;
  private closing?: Promise<void>;
  constructor(
    readonly domain: MessagingDomain,
    readonly config: MessagingConfig,
    private now = Date.now,
  ) {
    let state = states.get(domain);
    if (!state) {
      state = { tail: Promise.resolve(), closing: false };
      states.set(domain, state);
    }
    this.state = state;
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.state.closing) return Promise.reject(new OperationError('unavailable'));
    const p = this.state.tail.then(work);
    this.state.tail = p.catch(() => {});
    return p;
  }
  rows(): MessageRecord[] {
    return [...this.domain.table('messages').entries()].map(([, v]) => structuredClone(v));
  }
  get(id: string) {
    const value = this.domain.table('messages').get(id);
    return value && structuredClone(value);
  }
  byInvocation(invocationKey: string, invocationDigest: string) {
    const r = this.rows().find((r) => r.invocationKey === invocationKey);
    const tomb = [...this.domain.table('dedupe').entries()]
      .map(([, r]) => r)
      .find((r) => r.invocationKey === invocationKey);
    if (
      (r && r.invocationDigest !== invocationDigest) ||
      (tomb && tomb.invocationDigest !== invocationDigest)
    )
      throw new OperationError('conflict');
    if (!r && tomb) throw new OperationError('recovery-needed');
    return r;
  }
  async accept(value: MessageRecord): Promise<MessageRecord> {
    return this.run(async () => {
      const r = messageRecordSchema.parse(value),
        e = r.envelope,
        c = this.config;
      const old = this.byInvocation(r.invocationKey, r.invocationDigest);
      if (old) return old;
      if (this.get(e.id)) throw new OperationError('conflict');
      if (
        !e.content ||
        Buffer.byteLength(e.content) > c.messageMaxBytes ||
        e.contentDigest !== digest(e.content) ||
        !r.nativeInput ||
        !r.outgoingInput
      )
        throw new OperationError('invalid');
      const reservations = [...this.domain.table('limits').entries()].map(([, v]) => v);
      const reserved = reservations.find((v) => v.invocationKey === r.invocationKey);
      if (reserved && reserved.invocationDigest !== r.invocationDigest) throw new OperationError('conflict');
      const at = reservations.reduce((at, r) => Math.max(at, r.at), Math.max(this.now(), e.ts));
      const pair = JSON.stringify([keyOf(e.from), keyOf(e.to)].sort()),
        target = keyOf(e.to);
      const rows = this.rows(),
        thread = rows.filter((r) => r.envelope.threadId === e.threadId);
      if (
        rows.some((row) =>
          [row.nativeInput?.id, row.outgoingInput?.id].some(
            (id) => id && [r.nativeInput?.id, r.outgoingInput?.id].includes(id),
          ),
        )
      )
        throw new OperationError('conflict');
      const orphan = reservations.filter(
        (v) =>
          v.threadId === e.threadId &&
          !rows.some((r) => r.invocationKey === v.invocationKey) &&
          v.invocationKey !== r.invocationKey,
      );
      const replied = new Set(thread.filter((r) => r.envelope.replyTo).map((r) => r.envelope.replyTo));
      const open = thread.filter(
        (r) => r.envelope.mode === 'ask' && !replied.has(r.envelope.id) && r.response !== 'timed-out',
      );
      const parent =
        e.parentMessageId ||
        keyOf(e.origin.bot) !== keyOf(e.from) ||
        e.origin.sessionId !== e.fromSessionId ||
        digest(e.path) !== digest([e.from, e.to])
          ? thread.find((r) => r.envelope.id === e.parentMessageId)
          : undefined;
      if (e.hop > c.messageMaxHop || e.depth > c.messageMaxDepth) throw new OperationError('invalid');
      if (
        parent &&
        (parent.delivery !== 'delivered' ||
          parent.processing === 'pending' ||
          keyOf(parent.envelope.to) !== keyOf(e.from) ||
          parent.envelope.toSessionId !== e.fromSessionId)
      )
        throw new OperationError('invalid');
      if (e.mode === 'reply') {
        const ask = thread.find((r) => r.envelope.id === e.replyTo);
        if (
          ask?.envelope.mode !== 'ask' ||
          !['delivered'].includes(ask.delivery) ||
          ask.processing === 'pending' ||
          keyOf(ask.envelope.to) !== keyOf(e.from) ||
          keyOf(ask.envelope.from) !== keyOf(e.to) ||
          ask.envelope.toSessionId !== e.fromSessionId ||
          ask.envelope.fromSessionId !== e.toSessionId ||
          replied.has(ask.envelope.id) ||
          ask.response === 'timed-out'
        )
          throw new OperationError('conflict');
        if (
          !parent ||
          e.hop !== parent.envelope.hop + 1 ||
          e.depth !== ask.envelope.depth ||
          digest(e.path) !== digest(ask.envelope.path)
        )
          throw new OperationError('invalid');
      } else {
        if (new Set(e.path.map(keyOf)).size !== e.path.length) throw new OperationError('invalid');
        if (parent?.envelope.path.some((visited) => keyOf(visited) === keyOf(e.to)))
          throw new OperationError('invalid');
        if (thread.length) {
          if (
            !parent ||
            e.hop !== parent.envelope.hop + 1 ||
            e.depth !== e.path.length - 1 ||
            digest(e.path) !==
              digest([
                ...parent.envelope.path.slice(
                  0,
                  parent.envelope.path.findIndex((key) => keyOf(key) === keyOf(e.from)) + 1,
                ),
                e.to,
              ])
          )
            throw new OperationError('invalid');
        } else if (
          e.hop !== 1 ||
          e.depth !== 1 ||
          e.correlationId !== e.id ||
          e.threadId !== e.id ||
          e.parentMessageId ||
          keyOf(e.origin.bot) !== keyOf(e.from) ||
          e.origin.sessionId !== e.fromSessionId ||
          digest(e.path) !== digest([e.from, e.to])
        )
          throw new OperationError('invalid');
      }
      if (thread.length) {
        const root = thread[0]?.envelope;
        if (!root || e.correlationId !== root.correlationId || digest(e.origin) !== digest(root.origin))
          throw new OperationError('invalid');
      }
      const afterOpen = open.length + (e.mode === 'ask' ? 1 : e.mode === 'reply' ? -1 : 0);
      if (e.hop + afterOpen > c.messageMaxHop) throw new OperationError('unavailable');
      if (
        thread.length + orphan.length + 1 + afterOpen > c.messageThreadLimit ||
        afterOpen > c.messageOpenAskLimit
      )
        throw new OperationError('unavailable');
      const pending = rows.filter(
        (r) =>
          ['queued', 'delivering', 'unknown'].includes(r.delivery) ||
          (r.delivery === 'delivered' && ['pending', 'claimed', 'unknown'].includes(r.processing)),
      );
      if (
        e.mode !== 'reply' &&
        (pending.length >= c.messagePendingLimit ||
          pending.filter((r) => keyOf(r.envelope.to) === target).length >= c.messageTargetPendingLimit)
      )
        throw new OperationError('unavailable');
      const recent = reservations.filter(
        (v) => v.pair === pair && v.at > at - c.messagePairWindowMs && v.invocationKey !== r.invocationKey,
      );
      const throttled =
        recent.length >= c.messagePairTotal ||
        (e.mode !== 'reply' && recent.filter((v) => v.mode !== 'reply').length >= c.messagePairRequests);
      if (throttled && e.mode !== 'reply') throw new OperationError('unavailable');
      if (
        e.priority === 'interrupt' &&
        (reservations.filter(
          (v) =>
            v.priority === 'interrupt' &&
            v.pair === pair &&
            v.at > at - c.messageInterruptPairWindowMs &&
            v.invocationKey !== r.invocationKey,
        ).length >= c.messageInterruptPairLimit ||
          reservations.filter(
            (v) =>
              v.priority === 'interrupt' &&
              v.target === target &&
              v.at > at - c.messageInterruptTargetWindowMs &&
              v.invocationKey !== r.invocationKey,
          ).length >= c.messageInterruptTargetLimit)
      )
        throw new OperationError('unavailable');
      const nextAttemptAt = throttled ? at + c.messagePairWindowMs : undefined;
      // Reserve before the authoritative intent. An orphan can consume budget after a fault, never grant extra budget.
      await this.domain.table('limits').put(
        reserved?.id ?? e.id,
        reservationSchema.parse({
          id: reserved?.id ?? e.id,
          invocationKey: r.invocationKey,
          invocationDigest: r.invocationDigest,
          pair,
          target,
          threadId: e.threadId,
          mode: e.mode,
          priority: e.priority,
          at: reserved?.at ?? at,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
        }),
      );
      const accepted = messageRecordSchema.parse({
        ...r,
        ...(nextAttemptAt ? { nextAttemptAt } : {}),
      });
      await this.domain.table('messages').put(e.id, accepted);
      // Indexes are rebuildable. Failure cannot roll back the durable intent or cause another native send.
      await this.index(accepted);
      return structuredClone(accepted);
    });
  }
  private async index(r: MessageRecord) {
    await this.domain.table('dedupe').put(
      r.envelope.id,
      dedupeSchema.parse({
        id: r.envelope.id,
        invocationKey: r.invocationKey,
        invocationDigest: r.invocationDigest,
        messageId: r.envelope.id,
        at: r.envelope.ts,
        ...(r.nativeRef ? { nativeRef: r.nativeRef } : {}),
        ...(r.outgoingRef ? { outgoingRef: r.outgoingRef } : {}),
      }),
    );
    const rows = this.rows().filter((v) => v.envelope.threadId === r.envelope.threadId),
      root = rows.find((v) => v.envelope.id === v.envelope.correlationId);
    if (!root) throw new OperationError('recovery-needed');
    const replies = new Set(rows.map((v) => v.envelope.replyTo));
    const old = this.domain.table('threads').get(r.envelope.threadId);
    await this.domain.table('threads').put(
      r.envelope.threadId,
      threadSchema.parse({
        id: r.envelope.threadId,
        rootId: root.envelope.id,
        authorizationId: root.envelope.authorizationId,
        count: rows.length,
        openAsks: rows
          .filter(
            (v) =>
              v.envelope.mode === 'ask' &&
              !replies.has(v.envelope.id) &&
              v.response !== 'timed-out' &&
              !terminal.has(v.delivery),
          )
          .map((v) => v.envelope.id),
        deadline: root.envelope.ts + this.config.messageAskTimeoutMs,
        closed: rows.every(
          (v) =>
            v.response !== 'waiting' &&
            v.response !== 'reply-queued' &&
            v.processing !== 'pending' &&
            v.processing !== 'claimed',
        ),
        revision: (old?.revision ?? 0) + 1,
      }),
    );
  }
  async update(
    id: string,
    patch: Partial<
      Omit<
        MessageRecord,
        'envelope' | 'nativeInput' | 'outgoingInput' | 'invocationKey' | 'invocationDigest' | 'revision'
      >
    >,
    expectedRevision?: number,
  ) {
    return this.run(async () => {
      const old = this.get(id);
      if (!old) throw new OperationError('not-found');
      if (expectedRevision !== undefined && old.revision !== expectedRevision) throw new OperationError('conflict');
      if (
        patch.delivery &&
        old.delivery === 'delivered' &&
        !['delivered', 'canceled', 'expired'].includes(patch.delivery)
      )
        throw new OperationError('conflict');
      if (patch.delivery && terminal.has(old.delivery) && patch.delivery !== old.delivery && !(old.delivery === 'failed' && patch.delivery === 'queued' && expectedRevision !== undefined && !old.nativeRef && ['resolve-unavailable', 'session/writer-held'].includes(old.lastErrorCode ?? '')))
        throw new OperationError('conflict');
      const next = messageRecordSchema.parse({
        ...old,
        ...patch,
        revision: old.revision + 1,
      });
      await this.domain.table('messages').put(id, next);
      await this.index(next);
      return next;
    });
  }
  async reconcile() {
    return this.run(async () => {
      for (const r of this.rows()) await this.index(r);
    });
  }
  async compact() {
    return this.run(async () => {
      const all = this.rows(),
        at = all.reduce((at, r) => Math.max(at, r.envelope.ts), this.now());
      for (const r of all) {
        const open = all.some(
          (v) =>
            v.envelope.threadId === r.envelope.threadId &&
            (v.response === 'waiting' || v.response === 'reply-queued'),
        );
        if (
          open ||
          r.delivery !== 'delivered' ||
          !r.nativeRef ||
          !r.outgoingRef ||
          r.processing !== 'completed' ||
          at - r.envelope.ts < this.config.messageRetentionMs
        )
          continue;
        const { content: _content, ...envelope } = r.envelope;
        const { nativeInput: _input, outgoingInput: _output, ...rest } = r;
        const redacted = messageRecordSchema.parse({
          ...rest,
          envelope,
          retainedAt: at,
          revision: r.revision + 1,
        });
        await this.domain.table('messages').put(r.envelope.id, redacted);
      }
      // Tombstones deliberately remain beyond the minimum: without both logs no safe old-invocation replay exists.
      const reservations = [...this.domain.table('limits').entries()].map(([, r]) => r);
      const newest = reservations.reduce((at, r) => Math.max(at, r.at), 0);
      const window = Math.max(
        this.config.messagePairWindowMs,
        this.config.messageInterruptPairWindowMs,
        this.config.messageInterruptTargetWindowMs,
      );
      for (const reservation of reservations) {
        // Keep the latest accepted clock as a durable high-water mark under clock rollback.
        if (reservation.at < newest && reservation.at <= Math.max(at, newest) - window)
          await this.domain.table('limits').delete(reservation.id);
      }
    });
  }
  close() {
    this.closing ??= (async () => {
      this.state.closing = true;
      await this.state.tail;
      await this.domain.close();
    })();
    return this.closing;
  }
}
