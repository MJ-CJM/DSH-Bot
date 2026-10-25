import { describe, it, expect, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { withIntegrations } from './integration-support.js';
import * as identity from '../src/host/bot-context.js';
import { Messaging, messagingDomain } from '../src/host/messaging/service.js';
import { MessageStore } from '../src/host/messaging/store.js';
import { MessagingConfig } from '../src/host/messaging/config.js';
import type { MessageRecord } from '../src/shared/messaging.js';
async function setup(
  f: Parameters<Parameters<typeof withIntegrations>[0]>[0],
  capabilities = { coldWake: true, interrupt: true, processing: true },
) {
  const config = MessagingConfig({ messagingEnabled: true });
  let domain = await f.ctx.storageDomain.open(messagingDomain);
  let store = new MessageStore(domain, config);
  const agents = new Map<string, Agent>(),
    bindings = new Map<Agent, identity.BotBinding>(),
    ids = new Map<string, string>();
  for (const id of ['alpha', 'beta']) {
    const sessionId = SessionId(`s-${id}`),
      session = Session.create(sessionId, undefined, {
        version: 4,
        id: sessionId,
        createdAt: 1,
        isSeeded: false,
        agentPreset: `bot-${id}`,
      });
    session.append('turn/start', { turn: 0 });
    session.append(
      'user/message',
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'human' }],
      }),
      { surfaceOp: 'append' },
    );
    const inbox = {
      nextTurn: [] as ReturnType<typeof createUserMessage>[],
      nextStep: [] as ReturnType<typeof createUserMessage>[],
      remove: vi.fn((id: string) => {
        const index = inbox.nextTurn.findIndex((m) => m.id === id);
        if (index < 0) return false;
        a.session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: index,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        });
        inbox.nextTurn.splice(index, 1);
        return true;
      }),
    };
    const send = vi.fn(
      (input: ReturnType<typeof createUserMessage>, target: 'next-turn' | 'next-step', _wake: boolean) => {
        const q = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
        a.session.append('agent/inbox/spliced', {
          target,
          start: q.length,
          inserted: [input],
        });
        q.push(input);
      },
    );
    const a = {
      id: sessionId,
      session,
      ctx: f.ctx,
      inbox,
      status: 'idle',
      send,
      followup: vi.fn((input: ReturnType<typeof createUserMessage>) => send(input, 'next-turn', true)),
      cancel: vi.fn(),
    } as unknown as Agent;
    agents.set(sessionId, a);
    bindings.set(a, { botId: id, botCreatedAt: 1 });
    ids.set(id, sessionId);
  }
  const spy = vi.spyOn(identity, 'getBotBinding').mockImplementation((a) => bindings.get(a));
  const alpha = agents.get('s-alpha') as Agent,
    beta = agents.get('s-beta') as Agent;
  const flush = vi.fn(async () => true),
    readClose = vi.fn(async () => {}),
    resolve = vi.fn(async (id: string) => {
      const agent = agents.get(id);
      return agent ? { agent } : { error: { code: 'session/not-found' } };
    });
  f.ctx.provide('agents', {
    get: (id: string) => agents.get(id),
  } as unknown as typeof f.ctx.agents);
  f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  f.ctx.provide('sessionPersistence', {
    async open(id: string) {
      return {
        read: async () => ({
          eventState: 'frozen',
          events: agents.get(id)?.session.snapshotEvents(),
        }),
        close: readClose,
      };
    },
  } as unknown as typeof f.ctx.sessionPersistence);
  f.ctx.provide('sessionController', {
    resolveAgent: resolve,
  } as unknown as typeof f.ctx.sessionController);
  Object.assign(f.registry, {
    mainSessions: {
      async find(id: string) {
        const sessionId = ids.get(id);
        return sessionId ? { sessionId } : undefined;
      },
    },
    openConversation: vi.fn(async (id: string) => ({ sessionId: ids.get(id) })),
  });
  const approve = vi.fn(async () => 'specific-native-approval');
  let messaging = new Messaging(f.ctx, f.registry, store, { approve }, capabilities);
  await messaging.start();
  const send = (content = 'question', invocation = 'inv-1', priority: 'normal' | 'interrupt' = 'normal') =>
    messaging.send(alpha, { action: 'send', to: 'beta', mode: 'ask', priority, content }, invocation);
  return {
    get messaging() {
      return messaging;
    },
    get store() {
      return store;
    },
    get domain() {
      return domain;
    },
    alpha,
    beta,
    ids,
    flush,
    readClose,
    resolve,
    approve,
    send,
    async reopen() {
      await messaging.close();
      domain = await f.ctx.storageDomain.open(messagingDomain);
      store = new MessageStore(domain, config);
      messaging = new Messaging(f.ctx, f.registry, store, { approve }, capabilities);
      await messaging.start();
      await messaging.settled();
    },
    async seed(value: MessageRecord) {
      await store.domain.table('messages').put(value.envelope.id, value);
    },
    async close() {
      await messaging.close();
      spy.mockRestore();
    },
  };
}
describe('B03 Host transport fault boundaries with JSON and native Session logs', () => {
  it('expires its own durable pending input on recovery without waking or restoring it', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        await s.messaging.settled();
        const record = s.store.get(receipt.messageId);
        if (!record) throw Error();
        await s.seed({
          ...record,
          envelope: { ...record.envelope, ts: Date.now() - 3000, expiresAt: Date.now() - 1000 },
        });
        await s.reopen();
        expect(s.store.get(receipt.messageId)).toMatchObject({
          delivery: 'expired',
          processing: 'interrupted',
        });
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.beta.send).toHaveBeenCalledTimes(1);
        expect(s.beta.inbox.nextTurn).toHaveLength(0);
      } finally {
        await s.close();
      }
    }));
  it('persists a bounded retry only for a failure proven to precede native send', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        s.resolve.mockResolvedValueOnce({ error: { code: 'gateway/internal' } });
        const receipt = await s.send();
        await s.messaging.settled();
        expect(s.store.get(receipt.messageId)).toMatchObject({ delivery: 'queued', retryCount: 1 });
        expect(s.store.get(receipt.messageId)?.nextAttemptAt).toBeGreaterThan(Date.now());
        expect(s.beta.followup).not.toHaveBeenCalled();
        await s.reopen();
        expect(s.store.get(receipt.messageId)?.retryCount).toBe(1);
        expect(s.beta.followup).not.toHaveBeenCalled();
      } finally {
        await s.close();
      }
    }));
  it('returns durable queued acceptance without waiting for target, mirrors once and deduplicates invocation', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        expect(receipt.status).toBe('queued');
        await s.messaging.settled();
        const r = s.store.get(receipt.messageId);
        expect(r).toMatchObject({
          delivery: 'delivered',
          processing: 'pending',
        });
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.alpha.followup).not.toHaveBeenCalled();
        expect(r?.outgoingRef).toBeDefined();
        expect(s.readClose).toHaveBeenCalled();
        expect(await s.send()).toEqual(receipt);
        await s.messaging.settled();
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.approve).toHaveBeenCalledTimes(1);
        await expect(s.send('changed')).rejects.toMatchObject({
          code: 'dsh-bot/conflict',
        });
      } finally {
        await s.close();
      }
    }));
  it('denied authorization does not persist an intent, cancel or followup', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        s.approve.mockRejectedValueOnce(Error('native denied'));
        await expect(s.send()).rejects.toThrow('native denied');
        expect(s.store.rows()).toHaveLength(0);
        expect(s.beta.followup).not.toHaveBeenCalled();
        expect(s.beta.cancel).not.toHaveBeenCalled();
      } finally {
        await s.close();
      }
    }));
  it('records unknown after send/flush uncertainty, then reconciles persisted pending without a second business send', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        s.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const r = await s.send();
        await s.messaging.settled();
        expect(s.store.get(r.messageId)?.delivery).toBe('unknown');
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        await s.reopen();
        expect(s.store.get(r.messageId)?.delivery).toBe('delivered');
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.beta.send).toHaveBeenCalledTimes(2); // one business input, one authenticated wake
      } finally {
        await s.close();
      }
    }));
  it('does not resurrect native human-canceled pending after restart', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        await s.messaging.settled();
        const input = s.beta.inbox.nextTurn[0];
        expect(input).toBeDefined();
        s.beta.session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        });
        (s.beta.inbox.nextTurn as unknown[]).splice(0);
        await s.reopen();
        expect(s.store.get(receipt.messageId)).toMatchObject({
          delivery: 'canceled',
          processing: 'interrupted',
        });
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.beta.send).toHaveBeenCalledTimes(1);
      } finally {
        await s.close();
      }
    }));
  it('marks a committed user input without a completed turn unknown after a cold recovery', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send(); await s.messaging.settled();
        const row = s.store.get(receipt.messageId); if (!row?.nativeInput) throw Error();
        s.beta.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
        (s.beta.inbox.nextTurn as unknown[]).splice(0);
        s.beta.session.append('user/message', row.nativeInput as unknown as ReturnType<typeof createUserMessage>, { surfaceOp: 'append' });
        await s.reopen(); expect(s.store.get(receipt.messageId)?.processing).toBe('unknown');
        expect(s.beta.followup).toHaveBeenCalledOnce();
      } finally { await s.close(); }
    }));
  it('does not replay claimed work without a committed user message', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        await s.messaging.settled();
        s.beta.session.append('agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
        });
        (s.beta.inbox.nextTurn as unknown[]).splice(0);
        await s.reopen();
        expect(s.store.get(receipt.messageId)?.processing).toBe('unknown');
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.beta.send).toHaveBeenCalledTimes(1);
      } finally {
        await s.close();
      }
    }));
  it('leaves an uncertain pre-flush send without native evidence unknown and never retries it', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        vi.mocked(s.beta.followup).mockImplementationOnce(() => {
          throw Error('send-window');
        });
        const receipt = await s.send();
        await s.messaging.settled();
        expect(s.store.get(receipt.messageId)?.delivery).toBe('unknown');
        await s.reopen();
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
        expect(s.store.get(receipt.messageId)?.delivery).toBe('unknown');
      } finally {
        await s.close();
      }
    }));
  it('recovers a durable intent that has not yet entered native delivery using its exact stored input', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        await s.messaging.settled();
        const record = s.store.get(receipt.messageId);
        if (!record) throw Error();
        // Fault fixture reconstructs the outbox-before-send cut and an empty original target log.
        const clean = Session.create(s.beta.session.id, undefined, s.beta.session.header);
        Object.assign(s.beta, { session: clean });
        (s.beta.inbox.nextTurn as unknown[]).splice(0);
        await s.seed({
          ...record,
          delivery: 'queued',
          processing: 'pending',
          nativeRef: undefined,
        });
        await s.reopen();
        expect(vi.mocked(s.beta.followup).mock.calls[1]?.[0].id).toBe(record.nativeInput?.id);
        expect(s.store.get(receipt.messageId)?.delivery).toBe('delivered');
      } finally {
        await s.close();
      }
    }));
  it('never redirects accepted messages to a replacement main or birthday', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send();
        await s.messaging.settled();
        const r = s.store.get(receipt.messageId);
        if (!r) throw Error();
        await s.seed({ ...r, delivery: 'queued' });
        s.ids.set('beta', 'replacement');
        await s.reopen();
        expect(s.store.get(receipt.messageId)).toMatchObject({
          delivery: 'failed',
          lastErrorCode: 'route-gone',
        });
        expect(s.beta.followup).toHaveBeenCalledTimes(1);
      } finally {
        await s.close();
      }
    }));
  it('falls back to normal when interrupt gate is disabled; verified interrupt issues once before followup', () =>
    withIntegrations(async (f) => {
      const s = await setup(f, {
        processing: true,
        coldWake: false,
        interrupt: false,
      });
      try {
        const receipt = await s.send('interrupt', 'inv', 'interrupt');
        await s.messaging.settled();
        expect(s.beta.cancel).not.toHaveBeenCalled();
        expect(s.store.get(receipt.messageId)?.interrupt).toBe('disabled');
      } finally {
        await s.close();
      }
    }));
  it('records the interrupt issue before native cancellation and never reissues on cold recovery', () =>
    withIntegrations(async (f) => {
      const s = await setup(f);
      try {
        const receipt = await s.send('interrupt', 'inv', 'interrupt');
        await s.messaging.settled();
        expect(s.beta.cancel).toHaveBeenCalledWith(
          { kind: 'hook', reason: `dsh-bot-message:${receipt.messageId}` },
          { keepInbox: true },
        );
        expect(vi.mocked(s.beta.cancel).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(s.beta.followup).mock.invocationCallOrder[0] ?? 0,
        );
        await s.reopen();
        expect(s.beta.cancel).toHaveBeenCalledTimes(1);
      } finally {
        await s.close();
      }
    }));
  it('does not admit model calls until B04 installs a processing and authorization adapter; close clears all owned resources', () =>
    withIntegrations(async (f) => {
      const s = await setup(f, {
        processing: false,
        coldWake: false,
        interrupt: false,
      });
      try {
        await expect(s.send()).rejects.toMatchObject({
          code: 'dsh-bot/unavailable',
        });
        await s.messaging.close();
        expect(s.messaging.lifecycle()).toEqual({
          phase: 'closed',
          tasks: 0,
          timers: 0,
          wakes: 0,
          targets: 0,
          ownedAgentHandles: 0,
        });
        expect(s.beta.cancel).not.toHaveBeenCalled();
      } finally {
        await s.close();
      }
    }));
});
