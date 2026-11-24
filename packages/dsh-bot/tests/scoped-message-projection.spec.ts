import { expect, test, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { withIntegrations, alpha, beta } from './integration-support.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { Messaging, messagingDomain } from '../src/host/messaging/service.js';
import { MessageStore } from '../src/host/messaging/store.js';
import { MessagingConfig } from '../src/host/messaging/config.js';
import { teammateTurn } from '../src/host/messaging/safety.js';
import { digest, need } from '../src/host/common/operations.js';
import { Supergroup, supergroupDomain } from '../src/host/supergroup/service.js';
import { projectGroupRelay, recoverGroupRelay, relayMarkerIssue } from '../src/host/groups/relay-receipts.js';
import type { GroupState } from '../src/host/groups/state.js';
import type { GroupDelivery, GroupRecord, GroupTurn } from '../src/shared/groups.js';
import type { Groups } from '../src/host/groups/service.js';
import type { SupergroupWork } from '../src/shared/supergroup.js';
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
    openConversationExact: async (key: typeof alpha) => ({ sessionId: key.botId === 'alpha' ? a.session.id : b.session.id }) });
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
  let workDomain = await f.ctx.storageDomain.open(supergroupDomain);
  f.registry.supergroup = new Supergroup(f.ctx, f.registry, {} as Groups, workDomain);
  async function settle(state: 'prepared' | 'completed' | 'failed' | 'unknown', result: string, diagnostic?: string) {
    const op = { id: input.operationId, digest: 'arguments', target: beta, state,
      ...(state === 'prepared' ? {} : { childId: 'clean-beta', status: state === 'failed' ? 'error' : state,
        resultDigest: digest(result), ...(diagnostic ? { diagnostic, errorCode: 'subagent/empty-output' } : {}) }) };
    const work: SupergroupWork = { id: input.workId, revision: 1, owner: alpha, originSessionId: a.session.id,
      inputMessageId: human.id, inputMessageIds: [human.id], configDigest: 'test', readers: [alpha, beta], createdAt: 1,
      updatedAt: 1, expiresAt: Date.now() + 60000, turnIds: [], state: state === 'prepared' ? 'running' : state === 'failed' ? 'partial' : state,
      collaboration: { requests: 2, operations: [op] }, groupInputs: [], experts: [] };
    await workDomain.table('works').put(work.id, work);
  }
  return { a, b, human, input, followup, flush, displays, controller,
    settle,
    get messaging() { return messaging; }, get store() { return store; },
    async reopen() { release(); await messaging.close();
      await workDomain.close(); workDomain = await f.ctx.storageDomain.open(supergroupDomain);
      f.registry.supergroup = new Supergroup(f.ctx, f.registry, {} as Groups, workDomain);
      store = new MessageStore(await f.ctx.storageDomain.open(messagingDomain), MessagingConfig({}));
      messaging = new Messaging(f.ctx, f.registry, store, undefined, { coldWake: true, interrupt: true, processing: true });
      release = f.ctx.provide('dshBotMessaging', messaging); await messaging.start(); await messaging.settled(); },
    async close() { release(); await messaging.close(); await workDomain.close(); bindings.delete(a); bindings.delete(b); left.scope.dispose(); right.scope.dispose(); } };
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

test('reads a confirmed answer only for its originating pair and exact request without touching a peer inbox', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const ask = await s.messaging.projectScoped(s.input);
    await s.settle('prepared', '');
    expect(await s.messaging.peerResult(s.a, 'beta')).toEqual({ status: 'pending', requestId: ask.messageId });
    const reply = await s.messaging.projectScoped({ ...s.input, kind: 'reply', from: beta, to: alpha, requestId: ask.messageId, content: 'A shared answer.' });
    expect(await s.messaging.peerResult(s.a, 'beta')).toEqual({ status: 'pending', requestId: ask.messageId });
    await s.settle('completed', 'A shared answer.');
    const expected = { status: 'completed', requestId: ask.messageId, question: s.input.content, content: 'A shared answer.', scoped: true };
    expect(await s.messaging.peerResult(s.a, 'beta')).toEqual(expected);
    expect(await s.messaging.peerResult(s.b, 'alpha', ask.messageId)).toEqual({ status: 'missing' });
    await s.messaging.projectScoped({ ...s.input, operationId: 'second-ask', content: 'Another subject.' });
    expect(await s.messaging.peerResult(s.a, 'beta')).toMatchObject({ status: 'ambiguous' });
    expect(await s.messaging.peerResult(s.a, 'beta', ask.messageId, true)).toEqual(expected);
    await s.reopen();
    expect(await s.messaging.peerResult(s.a, 'beta', ask.messageId)).toEqual(expected);
    await s.store.domain.table('messages').put(reply.messageId, { ...need(s.store.get(reply.messageId)), delivery: 'unknown' });
    expect(await s.messaging.peerResult(s.a, 'beta', ask.messageId)).toEqual({ status: 'unknown', requestId: ask.messageId });
    expect(s.followup).not.toHaveBeenCalled();
  } finally { await s.close(); }
}));

test('fresh result reuse rechecks both managed copies, live policy, grant status and cleanup before returning text', () => withIntegrations(async f => {
  const s = await fixture(f), { flowFixture } = await import('./deepening/managed-flow-fixture.js');
  const ledger = await flowFixture();
  try {
    ledger.current.set('beta', beta.botCreatedAt);
    Object.assign(f.registry, ledger.registry());
    const clean = { readers: [alpha, beta], originTrust: 'candidate' as const, sourceVersions: [], restrictions: [], grants: [] };
    await ledger.flow.inherit(s.input.labelSessionId, clean);
    await ledger.flow.inherit('answer-child', clean);
    const ask = await s.messaging.projectScoped(s.input);
    const answer = await s.messaging.projectScoped({ ...s.input, from: beta, to: alpha, kind: 'reply', labelSessionId: 'answer-child', requestId: ask.messageId, content: 'Approved shared result' });
    await s.settle('completed', 'Approved shared result');
    const lookup = () => s.messaging.peerResult(s.a, 'beta', ask.messageId, true);
    expect(await lookup()).toMatchObject({ status: 'completed', content: 'Approved shared result' });
    const flowId = need(s.store.get(answer.messageId)?.flowId), table = ledger.f.kernel.domain.table('flows');
    const saved = need(table.get(flowId)), envelope = need(saved.envelope);
    const withheld = { status: 'unknown', requestId: ask.messageId };
    for (const patch of [
      { binding: { ...envelope.binding, policyRevision: envelope.binding.policyRevision + 1 } },
      { binding: { ...envelope.binding, epoch: envelope.binding.epoch + 1 } },
      { label: { ...envelope.label, readers: [beta] } },
      { label: { ...envelope.label, restrictions: ['no-egress' as const] } },
      { label: { ...envelope.label, sourceVersions: [crypto.randomUUID()] } },
    ]) {
      await table.put(flowId, { ...saved, envelope: { ...envelope, ...patch } });
      expect(await lookup()).toEqual(withheld);
    }
    await table.put(flowId, { ...saved, grantUse: crypto.randomUUID() }); expect(await lookup()).toEqual(withheld);
    await table.put(flowId, { ...saved, envelope: undefined, redactedAt: Date.now() }); expect(await lookup()).toEqual(withheld);
  } finally { await s.close(); await ledger.close(); }
}));

test('an already visible historical failure card is never returned as a result, including after restart', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const ask = await s.messaging.projectScoped(s.input), diagnostic = 'Recipient produced no answer.';
    await s.messaging.projectScoped({ ...s.input, kind: 'reply', from: beta, to: alpha, requestId: ask.messageId, content: diagnostic });
    const read = () => s.messaging.peerResult(s.a, 'beta', ask.messageId);
    expect(await read()).toEqual({ status: 'unknown', requestId: ask.messageId }); // legacy row, no work proof
    await s.settle('prepared', '');
    expect(await read()).toEqual({ status: 'pending', requestId: ask.messageId });
    await s.settle('failed', '', diagnostic);
    await s.reopen();
    expect(await read()).toEqual({ status: 'closed', requestId: ask.messageId });
    await s.settle('unknown', '');
    expect(await read()).toEqual({ status: 'unknown', requestId: ask.messageId });
    await s.settle('completed', 'different answer');
    expect(await read()).toEqual({ status: 'unknown', requestId: ask.messageId });
    expect(s.displays(s.a)).toHaveLength(2);
    expect(s.followup).not.toHaveBeenCalled();
  } finally { await s.close(); }
}));

test('group handoff markers follow native receipts in both mains and cannot become reusable answers after restart', () => withIntegrations(async f => {
  const s = await fixture(f);
  const group = { id: 'group:one', createdAt: 1, rootSessionId: 'group-root', state: 'ready', membershipRevision: 1 };
  const via = { bot: alpha, memberId: 'member:a', name: 'Alpha' };
  const turn = { id: 'relay', group: { groupId: group.id, groupCreatedAt: group.createdAt }, operationId: 'relay:operation',
    membershipRevision: 1, inputMessageId: 'group-question', guestQuestion: { bot: beta, name: 'Beta', via } };
  const recipient = { bot: beta, ordinal: 0, state: 'completed', acceptedAt: undefined as number | undefined, answeredAt: undefined as number | undefined };
  const sender = { bot: alpha, ordinal: 1, state: 'completed', memberId: via.memberId, acceptedAt: undefined as number | undefined };
  const state = { ctx: f.ctx, registry: f.registry, startup: s.controller, record: () => group, members: () => [{ id: via.memberId, bot: alpha, enabled: true }],
    bot: async () => {}, table: (name: string) => ({ get: (key: string) => name === 'turns' ? turn : key === 'relay:0' ? recipient : sender }) };
  const marker = (kind: 'request' | 'reply') => projectGroupRelay(state as unknown as GroupState,
    group as GroupRecord, turn as GroupTurn, kind, s.controller.signal);
  try {
    f.registry.config.supergroup.enabled = false;
    await expect(marker('request')).rejects.toThrow();
    expect(s.displays(s.b)).toHaveLength(0);
    recipient.acceptedAt = Date.now();
    const spy = vi.spyOn(s.messaging, 'projectScoped');
    expect(relayMarkerIssue(state as unknown as GroupState, turn as GroupTurn, recipient as GroupDelivery)).toBe('unconfirmed');
    await recoverGroupRelay(state as unknown as GroupState, group as GroupRecord, turn as GroupTurn);
    expect(spy.mock.calls[0]?.[0].labelSessionId).toMatch(/^[a-zA-Z0-9_-]+$/);
    await marker('request');
    expect(relayMarkerIssue(state as unknown as GroupState, turn as GroupTurn, recipient as GroupDelivery)).toBeUndefined();
    expect(relayMarkerIssue({ ...state, ctx: { get: () => undefined } } as unknown as GroupState, turn as GroupTurn, recipient as GroupDelivery)).toBe('unavailable');
    recipient.answeredAt = 6;
    await expect(marker('reply')).rejects.toThrow();
    sender.acceptedAt = 7;
    await marker('reply');
    const entries = () => s.displays(s.b).flatMap(e => e.type === 'user/message' ? [e.data] : []);
    expect(entries().map(e => e.source)).toMatchObject([{ kind: 'dsh-bot-message', groupRelayReceipt: true, mode: 'ask', from: alpha, to: beta },
      { kind: 'dsh-bot-message-sent', groupRelayReceipt: true, mode: 'reply', from: beta, to: alpha }]);
    expect(entries().map(e => e.content[0])).toMatchObject([{ text: expect.stringContaining('Group question received.') },
      { text: expect.stringContaining('Group question answered.') }]);
    expect(s.displays(s.a)).toHaveLength(2);
    await s.reopen(); await marker('request'); await marker('reply');
    expect(s.displays(s.b)).toHaveLength(2); expect(s.displays(s.a)).toHaveLength(2);
    expect(s.followup).not.toHaveBeenCalled();
    expect(await s.messaging.peerResultForHumanInput(s.a, beta.botId)).toEqual({ status: 'missing' });
  } finally { await s.close(); }
}));
