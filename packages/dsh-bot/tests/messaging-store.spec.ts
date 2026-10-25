import { describe, it, expect, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { withIntegrations } from './integration-support.js';
import { MessageStore, messagingDomain } from '../src/host/messaging/store.js';
import { MessagingConfig } from '../src/host/messaging/config.js';
import {
  messageInputSchema,
  messagingCodecs,
  nativeMessageSchema,
  type MessageRecord,
} from '../src/shared/messaging.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { botDomain } from '../src/host/stores/domain.js';
import { digest } from '../src/host/common/operations.js';
import { messageEvidence } from '../src/host/messaging/evidence.js';
const from = { botId: 'alpha', botCreatedAt: 1 },
  to = { botId: 'beta', botCreatedAt: 1 };
function row(id = 'm1', patch: Partial<MessageRecord['envelope']> = {}): MessageRecord {
  const envelope = {
    schemaVersion: 1 as const,
    id,
    from,
    to,
    fromSessionId: 's-alpha',
    toSessionId: 's-beta',
    threadId: id,
    correlationId: id,
    origin: { bot: from, sessionId: 's-alpha', userMessageId: 'human-1' },
    hop: 1,
    depth: 1,
    mode: 'ask' as const,
    priority: 'normal' as const,
    ts: 1000,
    expiresAt: 86401000,
    path: [from, to],
    content: 'hello',
    contentDigest: digest('hello'),
    fromDisplay: { name: 'Alpha' },
    toDisplay: { name: 'Beta' },
    authorizationId: 'native-approval',
    ...patch,
  };
  const source = {
    messageId: id,
    threadId: envelope.threadId,
    from: envelope.from,
    to: envelope.to,
    fromSessionId: envelope.fromSessionId,
    toSessionId: envelope.toSessionId,
    hop: envelope.hop,
    mode: envelope.mode,
    priority: envelope.priority,
    displaySnapshots: { from: envelope.fromDisplay, to: envelope.toDisplay },
    ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
  };
  return {
    envelope,
    nativeInput: nativeMessageSchema.parse(
      createUserMessage({
        source: { ...source, kind: 'dsh-bot-message', form: 'relay' },
        content: [{ type: 'text', text: envelope.content ?? '' }],
      }),
    ),
    outgoingInput: nativeMessageSchema.parse(
      createUserMessage({
        source: { ...source, kind: 'dsh-bot-message-sent', form: 'notice' },
        content: [{ type: 'text', text: envelope.content ?? '' }],
      }),
    ),
    invocationKey: `invoke-${id}`,
    invocationDigest: digest([id, envelope.content]),
    revision: 1,
    retryCount: 0,
    delivery: 'queued',
    processing: 'pending',
    response: envelope.mode === 'ask' ? 'waiting' : 'not-required',
  };
}
async function fixture(
  f: Parameters<Parameters<typeof withIntegrations>[0]>[0],
  config: Partial<MessagingConfig> = {},
) {
  let domain = await f.ctx.storageDomain.open(messagingDomain);
  const clock = { at: 1000 };
  let store = new MessageStore(domain, MessagingConfig(config), () => clock.at);
  return {
    get store() {
      return store;
    },
    get domain() {
      return domain;
    },
    clock,
    async reopen() {
      await store.close();
      domain = await f.ctx.storageDomain.open(messagingDomain);
      store = new MessageStore(domain, MessagingConfig(config), () => clock.at);
      await store.reconcile();
    },
    close: () => store.close(),
  };
}
describe('B02 strict messaging contracts', () => {
  it.each([
    { action: 'send', to: 'beta', content: 'x', mode: 'ask', from: 'forged' },
    { action: 'reply', replyTo: 'x', content: 'x', to: 'beta' },
    { action: 'reply', replyTo: 'x', content: 'x', priority: 'interrupt' },
    { action: 'send', to: 'beta', content: ' ', mode: 'notify' },
    { action: 'list', limit: 0 },
  ])('rejects forged or malformed input %j', (input) => {
    expect(() => messagingCodecs.input.decode(input)).toThrow();
  });
  it('round-trips positive inputs and receipts with strict results', () => {
    const input = messageInputSchema.parse({
      action: 'send',
      to: 'beta',
      content: ' x ',
      mode: 'ask',
    });
    expect(messagingCodecs.input.decode(messagingCodecs.input.encode(input))).toEqual(input);
    expect(
      messagingCodecs.receipt.decode({
        messageId: 'm',
        threadId: 'm',
        status: 'queued',
        mode: 'ask',
      }),
    ).toHaveProperty('status', 'queued');
    expect(() =>
      messagingCodecs.receipt.decode({
        messageId: 'm',
        threadId: 'm',
        status: 'delivered',
        mode: 'ask',
      }),
    ).toThrow();
  });
  it('validates limits and cross constraints', () => {
    expect(MessagingConfig({})).toMatchObject({
      messagingEnabled: true,
      messageMaxDepth: 3,
      messageMaxHop: 8,
      messageThreadLimit: 16,
      messagePairRequests: 6,
      messagePairTotal: 12,
    });
    for (const c of [
      { messageMaxDepth: 4, messageMaxHop: 6 },
      { messageThreadLimit: 4 },
      { messagePairRequests: 13 },
      { messagePendingLimit: 2 },
      { messageMaxBytes: 512 },
      { messageDedupeMs: 1000 },
    ])
      expect(() => MessagingConfig(c)).toThrow();
  });
});
describe('B02 real JSON outbox', () => {
  it('counts durable native Inbox pending toward the target backlog after delivered acknowledgment', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messageTargetPendingLimit: 1 });
      try {
        await s.store.accept(row());
        await s.store.update('m1', { delivery: 'delivered', processing: 'pending' });
        await expect(s.store.accept(row('m2'))).rejects.toMatchObject({ code: 'dsh-bot/unavailable' });
      } finally {
        await s.close();
      }
    }));
  it('reserves enough thread capacity for all accepted ask return edges', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messageThreadLimit: 6 });
      try {
        await s.store.accept(row());
        await s.store.update('m1', { delivery: 'delivered', processing: 'claimed' });
        const child = (id: string, target: string) =>
          row(id, {
            threadId: 'm1',
            correlationId: 'm1',
            parentMessageId: 'm1',
            from: to,
            to: { botId: target, botCreatedAt: 1 },
            fromSessionId: 's-beta',
            toSessionId: `s-${target}`,
            hop: 2,
            depth: 2,
            path: [from, to, { botId: target, botCreatedAt: 1 }],
          });
        await s.store.accept(child('child-one', 'gamma'));
        await s.store.accept(child('child-two', 'delta'));
        await expect(s.store.accept(child('over-budget', 'epsilon'))).rejects.toMatchObject({
          code: 'dsh-bot/unavailable',
        });
        for (const id of ['child-one', 'child-two']) {
          await s.store.update(id, { delivery: 'delivered', processing: 'claimed' });
          const ask = s.store.get(id);
          if (!ask) throw Error();
          await s.store.accept(
            row(`reply-${id}`, {
              ...ask.envelope,
              id: `reply-${id}`,
              mode: 'reply',
              replyTo: id,
              parentMessageId: id,
              from: ask.envelope.to,
              to,
              fromSessionId: ask.envelope.toSessionId,
              toSessionId: 's-beta',
              hop: 3,
            }),
          );
          await s.store.update(`reply-${id}`, { delivery: 'delivered', processing: 'claimed' });
        }
        await s.store.accept(
          row('root-return', {
            mode: 'reply',
            replyTo: 'm1',
            parentMessageId: 'reply-child-two',
            threadId: 'm1',
            correlationId: 'm1',
            from: to,
            to: from,
            fromSessionId: 's-beta',
            toSessionId: 's-alpha',
            hop: 4,
          }),
        );
        expect(s.store.rows()).toHaveLength(6);
      } finally {
        await s.close();
      }
    }));
  it('accepts a throttled reply into its reserved durable queue with a bounded retry timestamp', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messagePairRequests: 1, messagePairTotal: 2 });
      try {
        await s.store.accept(row());
        await s.store.update('m1', { delivery: 'delivered', processing: 'claimed' });
        // A pre-existing reservation consumes the other slot without creating a new request.
        const reservation = s.domain.table('limits').get('m1');
        if (!reservation) throw Error();
        await s.domain
          .table('limits')
          .put('orphan', { ...reservation, id: 'orphan', invocationKey: 'orphan-invocation' });
        const r = await s.store.accept(
          row('reply', {
            mode: 'reply',
            replyTo: 'm1',
            parentMessageId: 'm1',
            threadId: 'm1',
            correlationId: 'm1',
            from: to,
            to: from,
            fromSessionId: 's-beta',
            toSessionId: 's-alpha',
            hop: 2,
          }),
        );
        expect(r.nextAttemptAt).toBe(61000);
        await s.reopen();
        expect(s.store.get('reply')?.nextAttemptAt).toBe(61000);
      } finally {
        await s.close();
      }
    }));
  it('serializes concurrent wrappers; invocation retries reuse both native IDs, different payload conflicts; cold reopen preserves all data', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f);
      try {
        const first = row(),
          second = {
            ...row('different'),
            invocationKey: first.invocationKey,
            invocationDigest: first.invocationDigest,
          };
        const other = new MessageStore(s.domain, MessagingConfig({}), () => 1000);
        const result = await Promise.all([s.store.accept(first), other.accept(second)]);
        expect(result[0]).toEqual(result[1]);
        expect(s.store.rows()).toHaveLength(1);
        await expect(
          s.store.accept({ ...second, invocationDigest: digest('changed') }),
        ).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
        const snapshot = s.store.rows();
        await s.reopen();
        expect(s.store.rows()).toEqual(snapshot);
        expect(s.domain.table('threads').get('m1')?.openAsks).toEqual(['m1']);
      } finally {
        await s.close();
      }
    }));
  it('rejects oversize, digest mismatch, loops, depth, hops and invalid reply targets without a reservation', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f);
      try {
        for (const r of [
          row('large', { content: '中'.repeat(3000) }),
          row('digest', { contentDigest: digest('other') }),
          row('cycle', { path: [from, to, from] }),
          row('depth', { depth: 4 }),
          row('hop', { hop: 9 }),
          row('reply', { mode: 'reply', replyTo: 'unknown' }),
        ])
          await expect(s.store.accept(r)).rejects.toBeDefined();
        expect([...s.domain.table('limits').entries()]).toHaveLength(0);
      } finally {
        await s.close();
      }
    }));
  it('persists budgets across restart and clock rollback with birthday-specific pairs', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messagePairRequests: 1 });
      try {
        await s.store.accept(row());
        s.clock.at = 0;
        await s.reopen();
        await expect(s.store.accept(row('m2'))).rejects.toMatchObject({
          code: 'dsh-bot/unavailable',
        });
        const newer = { ...to, botCreatedAt: 2 };
        await s.store.accept(row('new-birthday', { to: newer, path: [from, newer] }));
        expect(s.store.rows()).toHaveLength(2);
      } finally {
        await s.close();
      }
    }));
  it('keeps durable orphan reservations after intent failure, retries same invocation once and never over-issues', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messagePairRequests: 1 });
      try {
        const table = s.domain.table('messages'),
          put = vi.spyOn(table, 'put').mockRejectedValueOnce(new Error('synthetic-intent-write'));
        await expect(s.store.accept(row())).rejects.toThrow('synthetic-intent-write');
        expect([...s.domain.table('limits').entries()]).toHaveLength(1);
        await expect(s.store.accept(row('other'))).rejects.toMatchObject({
          code: 'dsh-bot/unavailable',
        });
        put.mockRestore();
        await s.store.accept(row());
        expect(s.store.rows()).toHaveLength(1);
        expect([...s.domain.table('limits').entries()]).toHaveLength(1);
      } finally {
        await s.close();
      }
    }));
  it('repairs failed derived indexes from authoritative intent without accepting another message', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f);
      try {
        const spy = vi.spyOn(s.domain.table('dedupe'), 'put').mockRejectedValueOnce(Error('index fault'));
        await expect(s.store.accept(row())).rejects.toThrow('index fault');
        spy.mockRestore();
        expect(s.store.rows()).toHaveLength(1);
        await s.reopen();
        expect(s.domain.table('dedupe').get('m1')?.messageId).toBe('m1');
        expect((await s.store.accept(row())).envelope.id).toBe('m1');
      } finally {
        await s.close();
      }
    }));
  it('reserves return budget, rejects a second terminal reply, and preserves fixed session and birthday routing', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, { messageThreadLimit: 6 });
      try {
        await s.store.accept(row());
        await s.store.update('m1', {
          delivery: 'delivered',
          processing: 'claimed',
        });
        const reply = row('reply', {
          mode: 'reply',
          replyTo: 'm1',
          parentMessageId: 'm1',
          threadId: 'm1',
          correlationId: 'm1',
          from: to,
          to: from,
          fromSessionId: 's-beta',
          toSessionId: 's-alpha',
          hop: 2,
        });
        await expect(
          s.store.accept(row('reply', { ...reply.envelope, toSessionId: 's-new' })),
        ).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
        await s.store.accept(reply);
        await expect(
          s.store.accept(row('duplicate', { ...reply.envelope, id: 'duplicate' })),
        ).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
        await expect(s.store.update('m1', { delivery: 'queued' })).rejects.toMatchObject({
          code: 'dsh-bot/conflict',
        });
      } finally {
        await s.close();
      }
    }));
  it('retains open threads, compacts only confirmed closed history and keeps dedupe tombstones beyond retention', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f, {
        messageRetentionMs: 1000,
        messageDedupeMs: 2000,
      });
      try {
        await s.store.accept(row());
        s.clock.at = 5000;
        await s.store.compact();
        expect(s.store.get('m1')?.envelope.content).toBe('hello');
        await s.store.update('m1', {
          delivery: 'delivered',
          processing: 'completed',
          response: 'timed-out',
          nativeRef: { sessionId: 's-beta', messageId: 'native' },
          outgoingRef: { sessionId: 's-alpha', messageId: 'outgoing' },
        });
        await s.store.compact();
        expect(s.store.get('m1')?.envelope.content).toBeUndefined();
        expect(s.store.get('m1')?.nativeInput).toBeUndefined();
        expect(s.domain.table('dedupe').get('m1')).toBeDefined();
        await s.reopen();
        expect((await s.store.accept(row())).envelope.content).toBeUndefined();
      } finally {
        await s.close();
      }
    }));
  it('does not change any pre-existing domain bytes when messaging opens, writes and cold-reopens', () =>
    withIntegrations(async (f) => {
      const old = await f.ctx.storageDomain.open(botDomain);
      const alpha = f.bots.get('alpha');
      if (!alpha) throw Error();
      await old.table('bots').put('alpha', alpha);
      await old.close();
      const snapshot = async function walk(dir: string): Promise<Array<[string, string]>> {
        const result: Array<[string, string]> = [];
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, e.name);
          if (e.isDirectory()) result.push(...(await walk(path)));
          else if (e.isFile()) result.push([path, (await readFile(path)).toString('base64')]);
        }
        return result;
      };
      const before = await snapshot(f.root);
      expect(before.length).toBeGreaterThan(0);
      const s = await fixture(f);
      try {
        await s.store.accept(row());
        await s.reopen();
      } finally {
        await s.close();
      }
      for (const [path, bytes] of before) expect((await readFile(path)).toString('base64')).toBe(bytes);
    }));
  it('refuses admissions while close drains queued writes', () =>
    withIntegrations(async (f) => {
      const s = await fixture(f);
      const accepted = s.store.accept(row());
      const closing = s.close();
      await accepted;
      await closing;
      await expect(s.store.accept(row('m2'))).rejects.toMatchObject({
        code: 'dsh-bot/unavailable',
      });
    }));
});
describe('B03 durable inbox evidence', () => {
  it('distinguishes pending, human cancellation, claimed unknown and completed model evidence', () => {
    const r = row();
    if (!r.nativeInput) throw Error();
    const native = r.nativeInput as unknown as Parameters<Session['append']>[1];
    const session = Session.create(SessionId('s-beta'), undefined, {
      version: 4,
      id: SessionId('s-beta'),
      createdAt: 1,
      isSeeded: false,
    });
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [native as never],
    });
    expect(messageEvidence(r, session.snapshotEvents())).toMatchObject({
      pending: true,
      claimed: false,
      canceled: false,
    });
    session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
      outcome: 'canceled',
    });
    expect(messageEvidence(r, session.snapshotEvents())).toMatchObject({
      pending: false,
      canceled: true,
    });
  });
  it('fails closed on incomplete history instead of assuming absent messages are safe to replay', () => {
    const r = row();
    expect(() =>
      messageEvidence(r, [{ seq: 1, type: 'turn/start', data: { turn: 0 }, time: 1 }] as never),
    ).toThrow('Incomplete');
  });
});
