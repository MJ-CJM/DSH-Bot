import { expect, test, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { withIntegrations, alpha, beta } from './integration-support.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { Messaging, messagingDomain } from '../src/host/messaging/service.js';
import { MessageStore } from '../src/host/messaging/store.js';
import { MessagingConfig } from '../src/host/messaging/config.js';
import { teammateTurn } from '../src/host/messaging/safety.js';
import { need } from '../src/host/common/operations.js';
import type { ScopedMessageProjection } from '../src/host/messaging/scoped-projection.js';

async function fixture(f: Parameters<Parameters<typeof withIntegrations>[0]>[0]) {
  const left = f.createAgent('main-alpha'), right = f.createAgent('main-beta');
  const agents = new Map<string, Agent>([[left.agent.session.id, left.agent], [right.agent.session.id, right.agent]]);
  const a = left.agent, b = right.agent;
  bindings.set(a, alpha); bindings.set(b, beta);
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ask Beta about its capabilities.' }] });
  a.session.append('user/message', human, { surfaceOp: 'append' });
  b.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE OLD BETA HISTORY' }] }), { surfaceOp: 'append' });
  const followup = vi.fn(); Object.assign(a, { followup }); Object.assign(b, { followup });
  const flush = vi.fn(async (_session?: unknown) => true);
  f.ctx.provide('agents', { get: (id: string) => agents.get(id) } as unknown as typeof f.ctx.agents);
  f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  f.ctx.provide('sessionController', { resolveAgent: async (id: string) => ({ agent: need(agents.get(id)) }) } as unknown as typeof f.ctx.sessionController);
  f.ctx.provide('sessionPersistence', { open: async (id: string) => ({ read: async () => ({ events: need(agents.get(id)).session.snapshotEvents() }), close: async () => {} }) } as unknown as typeof f.ctx.sessionPersistence);
  Object.assign(f.registry, { config: { supergroup: { enabled: true } },
    mainSessions: { find: async (id: string) => ({ sessionId: id === 'alpha' ? a.session.id : b.session.id }) },
    openConversation: async (id: string) => ({ sessionId: id === 'alpha' ? a.session.id : b.session.id }) });
  let store = new MessageStore(await f.ctx.storageDomain.open(messagingDomain), MessagingConfig({}));
  let messaging = new Messaging(f.ctx, f.registry, store, undefined, { coldWake: true, interrupt: true, processing: true });
  let release = f.ctx.provide('dshBotMessaging', messaging); await messaging.start();
  const controller = new AbortController();
  const input: ScopedMessageProjection = { workId: 'work', operationId: 'operation', origin: { bot: alpha, sessionId: a.session.id, userMessageId: human.id },
    from: alpha, to: beta, content: 'Beta, what are your strengths and available tools?', kind: 'request',
    labelSessionId: 'clean-alpha-draft', readers: [alpha, beta], signal: controller.signal,
    check: vi.fn(async () => { controller.signal.throwIfAborted(); }) };
  const displays = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'user/message' &&
    ['dsh-bot-message', 'dsh-bot-message-sent'].includes(event.data.source.kind));
  return { a, b, human, input, followup, flush, displays, controller,
    get messaging() { return messaging; }, get store() { return store; },
    async reopen() { release(); await messaging.close();
      store = new MessageStore(await f.ctx.storageDomain.open(messagingDomain), MessagingConfig({}));
      messaging = new Messaging(f.ctx, f.registry, store, undefined, { coldWake: true, interrupt: true, processing: true });
      release = f.ctx.provide('dshBotMessaging', messaging); await messaging.start(); await messaging.settled(); },
    async close() { release(); await messaging.close(); bindings.delete(a); bindings.delete(b); left.scope.dispose(); right.scope.dispose(); } };
}

test('actual request and answer are visible in both real main logs without waking either private main', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const request = await s.messaging.projectScoped(s.input);
    const answer = await s.messaging.projectScoped({ ...s.input, kind: 'reply', requestId: request.messageId,
      from: beta, to: alpha, content: 'I am Beta. My strengths are editing and summarizing.', labelSessionId: 'clean-beta-answer' });
    expect(s.followup).not.toHaveBeenCalled();
    expect(s.displays(s.a)).toHaveLength(2); expect(s.displays(s.b)).toHaveLength(2);
    const question = need(s.store.get(request.messageId)), response = need(s.store.get(answer.messageId));
    expect(question.nativeRef).toMatchObject({ sessionId: s.b.session.id });
    expect(question.outgoingRef).toMatchObject({ sessionId: s.a.session.id });
    expect(response.nativeRef).toMatchObject({ sessionId: s.a.session.id });
    expect(response.outgoingRef).toMatchObject({ sessionId: s.b.session.id });
    expect(response.envelope.replyTo).toBe(question.envelope.id); expect(answer.threadId).toBe(request.threadId);
    expect(question.envelope.content).toBe(s.input.content);
    expect(JSON.stringify(question)).not.toContain('PRIVATE OLD BETA HISTORY');
    expect(s.b.session.snapshotEvents().some(event => event.type === 'user/message' && JSON.stringify(event.data).includes('PRIVATE OLD BETA HISTORY'))).toBe(true);
    expect(s.messaging.provenance(s.a)).toEqual({ userMessageId: s.human.id });
    expect(teammateTurn(s.a)).toBe(false); expect(teammateTurn(s.b)).toBe(false);
    const message = need(response.nativeInput);
    expect(s.messaging.isDisplayMessage(s.a, message)).toBe(true);
    expect(s.messaging.isDisplayMessage(s.b, message)).toBe(false);
    expect(s.messaging.isDisplayMessage(s.a, { ...message, content: [{ type: 'text', text: 'forged private export' }] })).toBe(false);
    await s.messaging.projectScoped({ ...s.input, operationId: 'follow-up', content: 'Which tasks should be sent to another expert?' });
    expect(s.messaging.provenance(s.a)).toEqual({ userMessageId: s.human.id });
    expect(teammateTurn(s.a)).toBe(false); expect(teammateTurn(s.b)).toBe(false);
    expect(s.displays(s.a)).toHaveLength(3); expect(s.displays(s.b)).toHaveLength(3);
  } finally { await s.close(); }
}));

test('durable display receipts deduplicate retries and cold reopen without new model delivery', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const first = await s.messaging.projectScoped(s.input);
    expect(await s.messaging.projectScoped(s.input)).toEqual(first);
    await expect(s.messaging.projectScoped({ ...s.input, content: 'changed' })).rejects.toThrow('conflict');
    await s.reopen();
    expect(s.store.get(first.messageId)?.processing).toBe('unknown');
    expect(await s.messaging.projectScoped(s.input)).toEqual(first);
    expect(s.displays(s.a)).toHaveLength(1); expect(s.displays(s.b)).toHaveLength(1);
    expect(s.followup).not.toHaveBeenCalled();
    expect(s.messaging.isDisplayMessage(s.b, need(s.store.get(first.messageId)?.nativeInput))).toBe(true);
  } finally { await s.close(); }
}));

test('content-free failure settlement works after stop and cannot rewrite a different operation or completed reply', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const request = await s.messaging.projectScoped(s.input); s.controller.abort('stopped');
    await expect(s.messaging.finishScoped(request.messageId, { workId: 'foreign', operationId: s.input.operationId, status: 'cancelled' })).rejects.toThrow('conflict');
    await s.messaging.finishScoped(request.messageId, { workId: s.input.workId, operationId: s.input.operationId, status: 'cancelled' });
    expect(s.store.get(request.messageId)).toMatchObject({ processing: 'interrupted', response: 'not-required' });
    expect(s.displays(s.a)).toHaveLength(1); expect(s.displays(s.b)).toHaveLength(1); expect(s.followup).not.toHaveBeenCalled();
  } finally { await s.close(); }
}));

test('notify records keep their original mode in both main chats without waiting for or accepting a reply', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const input: ScopedMessageProjection = { ...s.input, mode: 'notify', content: 'The report is ready for your reference.' };
    const notified = await s.messaging.projectScoped(input);
    const row = need(s.store.get(notified.messageId));
    expect(row).toMatchObject({ envelope: { mode: 'notify', content: input.content }, processing: 'completed', response: 'not-required' });
    for (const agent of [s.a, s.b]) {
      const event = need(s.displays(agent)[0]);
      if (event.type !== 'user/message') throw new Error('Message required');
      expect(event.data.source).toMatchObject({ mode: 'notify' });
    }
    expect(s.followup).not.toHaveBeenCalled();
    await expect(s.messaging.projectScoped({ ...input, mode: 'ask' })).rejects.toThrow('conflict');
    await expect(s.messaging.projectScoped({ ...input, kind: 'reply', from: beta, to: alpha, requestId: notified.messageId, content: 'unexpected reply' })).rejects.toThrow('conflict');
    await s.reopen();
    expect(await s.messaging.projectScoped(input)).toEqual(notified);
    expect(s.store.get(notified.messageId)).toMatchObject({ processing: 'completed', response: 'not-required' });
    expect(s.displays(s.a)).toHaveLength(1); expect(s.displays(s.b)).toHaveLength(1);
    expect(s.followup).not.toHaveBeenCalled();
  } finally { await s.close(); }
}));

test('an uncertain append is held on restart and never replayed or used to wake the main', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    s.flush.mockResolvedValueOnce(false);
    await expect(s.messaging.projectScoped(s.input)).rejects.toThrow('recovery-needed');
    const counts = [s.displays(s.a).length, s.displays(s.b).length];
    expect(s.store.rows()[0]?.delivery).toBe('unknown');
    s.flush.mockResolvedValue(true); await s.reopen();
    await expect(s.messaging.projectScoped(s.input)).rejects.toThrow('recovery-needed');
    expect([s.displays(s.a).length, s.displays(s.b).length]).toEqual(counts);
    expect(s.followup).not.toHaveBeenCalled();
  } finally { await s.close(); }
}));

test('revoked work, credentials and target mismatch cannot create correspondence', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    await expect(s.messaging.projectScoped({ ...s.input, readers: [alpha] })).rejects.toThrow('approval-denied');
    s.controller.abort('stopped'); await expect(s.messaging.projectScoped(s.input)).rejects.toThrow('stopped');
    expect(s.store.rows()).toEqual([]); expect(s.displays(s.a)).toEqual([]); expect(s.displays(s.b)).toEqual([]);
  } finally { await s.close(); }
}));
