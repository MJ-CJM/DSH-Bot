import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { bindScopeParent, createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { registerActivityTracking, registerBotPresetActivity } from '../lib/host/activity/tracker.js';
import { DshBotError } from '../lib/host/errors.js';

type Content = Array<{ type: string; text?: string; [key: string]: unknown }>;

// Event payload fixtures, not a Session/Agent runtime. Routing, ownership and
// disposal deliberately exercise the published Cordis and scope APIs.
function message(role: 'user' | 'assistant', content: Content, options: {
  source?: string;
  interrupted?: true;
  replacement?: boolean;
  seq?: number;
  at?: number;
} = {}): SessionEvent {
  const data = role === 'user'
    ? { role, content, source: { kind: options.source ?? 'user' } }
    : { turn: 1, step: 1, message: { role, content }, stream: [],
      ...(options.interrupted ? { interrupted: true } : {}) };
  return {
    type: `${role}/message`, seq: SessionSeq(options.seq ?? 4), time: options.at ?? 200,
    surfaceOp: options.replacement ? { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(1) } : 'append',
    data,
  } as unknown as SessionEvent;
}

async function fixture(title: unknown = 'Conversation title') {
  const ctx = new Context();
  await ctx.plugin(SessionStore).await();
  const recordActivity = vi.fn(async (_input: unknown): Promise<void> => {});
  const snapshot = vi.fn((_session: Session) => ({ values: { title } }));
  // Match production: the service is provided by a sibling plugin, not by the
  // root context that would make it implicitly accessible to every descendant.
  await ctx.plugin({ apply(provider: Context) {
    provider.provide('dshBots', { recordActivity } as unknown as Context['dshBots']);
  } }).await();
  ctx.provide('sessionProjections', { snapshot } as unknown as Context['sessionProjections']);
  const liveAgents = new Map<string, Agent>();
  ctx.provide('agents', { get: (id: string) => liveAgents.get(id) } as unknown as Context['agents']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['dshBots', 'agents', 'sessions'],
    apply(injected: Context) { owner = injected; },
  }).await();
  let next = 0;
  const preset = (botId: string, botCreatedAt = 100) => {
    const key = {};
    const scope = createScope(owner, key);
    registerBotPresetActivity(scope.ctx, botId, botCreatedAt);
    return { key, scope };
  };
  const plainPreset = () => ({ key: {} });
  const agent = (botId = 'alpha', botCreatedAt = 100, options: { parent?: object; managed?: boolean; realSession?: boolean } = {}) => {
    const sessionId = SessionId(`activity-fixture-${++next}`);
    const session = options.realSession ? Session.create(sessionId) : { id: sessionId } as Session;
    const payload = { id: session.id, session, ctx: owner };
    const subject = payload as unknown as Agent;
    let parentBinding = options.parent ? bindScopeParent(subject, options.parent) : undefined;
    const scope = createScope(owner, subject);
    payload.ctx = scope.ctx;
    if (options.realSession) {
      scope.ctx.effect(() => scope.ctx.sessions.enter(session));
      scope.ctx.sessions.announce(session);
    }
    liveAgents.set(session.id, subject);
    scope.ctx.effect(() => () => { liveAgents.delete(session.id); });
    const dispose = options.managed ? () => {} : scope.ctx.effect(() => registerActivityTracking(subject, botId, botCreatedAt, { recordActivity }));
    return {
      subject, session, scope, dispose,
      announce: () => ctx.serial(scopeTarget(subject, subject), 'agent/created', { agent: subject, source: 'startup' }),
      select: (next: object, presetId: string) => {
        if (parentBinding) parentBinding.rebind(next);
        else parentBinding = bindScopeParent(subject, next);
        ctx.emit('agent-preset/selected', session.id, presetId);
      },
      emit: (event: SessionEvent, sourceSession = session) => {
        ctx.emit(scopeTarget(sourceSession, subject), 'session/event', sourceSession, event);
      },
    };
  };
  return { ctx, owner, recordActivity, snapshot, agent, preset, plainPreset, close: () => ctx.fiber.dispose() };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, title?: unknown) {
  const value = await fixture(title);
  try { await run(value); } finally { await value.close(); }
}

describe('Bot activity tracking through public scoped session events', () => {
  it('uses the captured Host sink when the real Session Agent context cannot inject dshBots', async () => withFixture(async ({
    ctx, owner, recordActivity,
  }) => {
    let loopOwner!: Context;
    await ctx.plugin({ inject: ['sessions'], apply(injected: Context) { loopOwner = injected; } }).await();
    const session = Session.create(SessionId('activity-no-host-injection'));
    const payload = { id: session.id, session, ctx: loopOwner };
    const agent = payload as unknown as Agent;
    const scope = createScope(loopOwner, agent);
    payload.ctx = scope.ctx;
    scope.ctx.effect(() => scope.ctx.sessions.enter(session));
    scope.ctx.sessions.announce(session);
    // Production Agent scopes belong to the loop, not to the Bot preset plugin.
    expect(() => agent.ctx.dshBots).toThrow('without inject');
    const captured = owner.dshBots;
    scope.ctx.effect(() => registerActivityTracking(agent, 'alpha', 100, captured));
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Captured service works' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ sessionId: session.id, text: 'Captured service works' });
  }));

  it('receives actual Session.append completion events from agent.ctx.sessions.enter', async () => withFixture(async ({ agent, recordActivity }) => {
    const tracked = agent('alpha', 100, { realSession: true });
    tracked.session.append('turn/start', { turn: 1 });
    const user = tracked.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Real Session user' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' });
    const assistant = tracked.session.append('assistant/message', {
      turn: 1, step: 1, stream: [], message: createAssistantMessage({
        content: [{ type: 'text', text: 'Real Session answer' }], source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' });
    expect(recordActivity).toHaveBeenCalledTimes(2);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ role: 'user', text: 'Real Session user', at: user.time, seq: user.seq });
    expect(recordActivity.mock.calls[1]?.[0]).toMatchObject({ role: 'assistant', text: 'Real Session answer', at: assistant.time, seq: assistant.seq });
  }));

  it('records only text blocks from complete human and assistant messages with durable metadata', async () => withFixture(async ({
    agent, recordActivity, snapshot,
  }) => {
    const tracked = agent('alpha', 123);
    tracked.emit(message('user', [
      { type: 'text', text: 'Hello' }, { type: 'image', url: 'private-image' }, { type: 'text', text: 'there' },
    ], { seq: 4, at: 900 }));
    tracked.emit(message('assistant', [
      { type: 'reasoning', text: 'Hidden reasoning' }, { type: 'text', text: 'Visible answer' },
      { type: 'tool-call', name: 'tool', arguments: 'private arguments' }, { type: 'text', text: 'Second paragraph' },
    ], { seq: 5, at: 900 }));

    expect(recordActivity.mock.calls.map(([input]) => input)).toEqual([
      { sessionId: tracked.session.id, botId: 'alpha', expectedBotCreatedAt: 123,
        role: 'user', text: 'Hello\nthere', at: 900, seq: 4, title: 'Conversation title' },
      { sessionId: tracked.session.id, botId: 'alpha', expectedBotCreatedAt: 123,
        role: 'assistant', text: 'Visible answer\nSecond paragraph', at: 900, seq: 5, title: 'Conversation title' },
    ]);
    expect(snapshot.mock.calls.map(([session]) => session)).toEqual([tracked.session, tracked.session]);
  }));

  it('routes two Agents independently without duplicating or crossing Bot activity', async () => withFixture(async ({ agent, recordActivity }) => {
    const alpha = agent('alpha', 11);
    const beta = agent('beta', 22);
    alpha.emit(message('user', [{ type: 'text', text: 'Alpha message' }]));
    beta.emit(message('assistant', [{ type: 'text', text: 'Beta answer' }]));
    expect(recordActivity).toHaveBeenCalledTimes(2);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ sessionId: alpha.session.id, botId: 'alpha', expectedBotCreatedAt: 11 });
    expect(recordActivity.mock.calls[1]?.[0]).toMatchObject({ sessionId: beta.session.id, botId: 'beta', expectedBotCreatedAt: 22 });
  }));

  it('rejects an unexpected Session object even if its id and dispatch scope match', async () => withFixture(async ({ agent, recordActivity }) => {
    const tracked = agent();
    tracked.emit(message('user', [{ type: 'text', text: 'Wrong session' }]), { id: tracked.session.id } as Session);
    expect(recordActivity).not.toHaveBeenCalled();
  }));

  it.each(['runtime-context', 'plugin', 'goal'])('ignores synthetic user messages from %s', async (source) => withFixture(async ({ agent, recordActivity }) => {
    agent().emit(message('user', [{ type: 'text', text: 'Injected context' }], { source }));
    expect(recordActivity).not.toHaveBeenCalled();
  }));

  it('waits for a settled message and ignores stream notifications, failed attempts and turn boundaries', async () => withFixture(async ({
    ctx, agent, recordActivity,
  }) => {
    const tracked = agent();
    ctx.emit(scopeTarget(tracked.subject, tracked.subject), 'agent/assistant-stream', { frame: {} } as never);
    for (const type of ['assistant/attempt', 'turn/start', 'turn/end']) {
      tracked.emit({ type, seq: SessionSeq(1), time: 100, data: {} } as unknown as SessionEvent);
    }
    expect(recordActivity).not.toHaveBeenCalled();
    tracked.emit(message('assistant', [{ type: 'text', text: 'Complete answer' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
  }));

  it('does not record an interrupted assistant prefix as a completed message', async () => withFixture(async ({ agent, recordActivity }) => {
    agent().emit(message('assistant', [{ type: 'text', text: 'Partial output' }], { interrupted: true }));
    expect(recordActivity).not.toHaveBeenCalled();
  }));

  it.each(['user', 'assistant'] as const)('ignores %s surface replacements', async (role) => withFixture(async ({ agent, recordActivity }) => {
    agent().emit(message(role, [{ type: 'text', text: 'Compacted replacement' }], { replacement: true }));
    expect(recordActivity).not.toHaveBeenCalled();
  }));

  it('ignores tool-only, image-only, reasoning-only and whitespace-only messages', async () => withFixture(async ({ agent, recordActivity }) => {
    const tracked = agent();
    for (const content of [
      [{ type: 'tool-call', name: 'tool', arguments: 'arguments' }],
      [{ type: 'image', url: 'image' }],
      [{ type: 'reasoning', text: 'reasoning' }],
      [{ type: 'text', text: ' \n\t  ' }],
    ]) tracked.emit(message('assistant', content));
    expect(recordActivity).not.toHaveBeenCalled();
  }));

  it('records image-only and blank human input so the latest role can clear assistant unread state', async () => withFixture(async ({
    agent, recordActivity,
  }) => {
    const tracked = agent();
    tracked.emit(message('user', [{ type: 'image', url: 'not persisted' }], { seq: 10 }));
    tracked.emit(message('user', [{ type: 'text', text: ' \n\t ' }], { seq: 11 }));
    expect(recordActivity).toHaveBeenCalledTimes(2);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ role: 'user', text: '', seq: 10 });
    expect(recordActivity.mock.calls[1]?.[0]).toMatchObject({ role: 'user', text: ' \n\t ', seq: 11 });
    expect(JSON.stringify(recordActivity.mock.calls)).not.toContain('not persisted');
  }));

  it.each([null, 123, { title: 'not a string' }])('omits unavailable or malformed optional title metadata: %j', async (title) => withFixture(async ({
    agent, recordActivity,
  }) => {
    agent().emit(message('user', [{ type: 'text', text: 'Hello' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).not.toHaveProperty('title');
  }, title));

  it('continues recording when the optional projection service throws', async () => withFixture(async ({ agent, recordActivity, snapshot }) => {
    snapshot.mockImplementation(() => { throw new Error('projection unavailable'); });
    agent().emit(message('user', [{ type: 'text', text: 'Hello' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).not.toHaveProperty('title');
  }));

  it('stops observing after explicit registration cleanup and tolerates repeated cleanup', async () => withFixture(async ({ agent, recordActivity }) => {
    const tracked = agent();
    tracked.emit(message('user', [{ type: 'text', text: 'Before cleanup' }]));
    await tracked.dispose();
    await tracked.dispose();
    tracked.emit(message('user', [{ type: 'text', text: 'After cleanup' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
  }));

  it('releases an Agent scope while preserving its sibling observer', async () => withFixture(async ({ agent, recordActivity }) => {
    const first = agent();
    const sibling = agent();
    await first.scope.dispose();
    first.emit(message('assistant', [{ type: 'text', text: 'Disposed' }]));
    sibling.emit(message('assistant', [{ type: 'text', text: 'Still active' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ sessionId: sibling.session.id, text: 'Still active' });
  }));

  it('contains storage failure without logging message content or raw backend diagnostics', async () => withFixture(async ({ agent, recordActivity }) => {
    const tracked = agent();
    const warn = vi.spyOn(tracked.subject.ctx.logger, 'warn').mockImplementation(() => {});
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz';
    recordActivity.mockRejectedValue(new DshBotError('store/unavailable', `Backend failure containing ${secret}`));
    try {
      expect(() => tracked.emit(message('assistant', [{ type: 'text', text: `Private message ${secret}` }]))).not.toThrow();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain('activity');
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain('Private message');
      expect(logged).not.toContain('Backend failure');
    } finally { warn.mockRestore(); }
  }));

  it('contains synchronous sink failure without leaking backend diagnostics to the Session observer', async () => withFixture(async ({
    agent, recordActivity,
  }) => {
    const tracked = agent();
    const warn = vi.spyOn(tracked.subject.ctx.logger, 'warn').mockImplementation(() => {});
    recordActivity.mockImplementation(() => { throw new Error('private backend detail'); });
    try {
      expect(() => tracked.emit(message('user', [{ type: 'text', text: 'Private input' }]))).not.toThrow();
      expect(warn).toHaveBeenCalledExactlyOnceWith('[dsh-bot] activity update unavailable');
    } finally { warn.mockRestore(); }
  }));
});

describe('Bot activity owner follows blank-session preset changes', () => {
  it('requires a preset scope instead of creating an unscoped Bot observer', async () => withFixture(async ({ owner }) => {
    expect(() => registerBotPresetActivity(owner, 'alpha', 100)).toThrow('requires a preset scope');
  }));

  it('starts tracking when a plain session selects a Bot, without another agent/created', async () => withFixture(async ({
    agent, preset, plainPreset, recordActivity,
  }) => {
    const alpha = preset('alpha', 101);
    const tracked = agent('unused', 0, { managed: true, parent: plainPreset().key, realSession: true });
    await tracked.announce();
    tracked.select(alpha.key, 'bot-alpha');
    const event = tracked.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'After selection' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ botId: 'alpha', expectedBotCreatedAt: 101, seq: event.seq });
  }));

  it.each([false, true])('hands A to B over once regardless of observer registration order (reverse=%s)', async (reverse) => withFixture(async ({
    agent, preset, recordActivity,
  }) => {
    const betaFirst = reverse ? preset('beta', 202) : undefined;
    const alpha = preset('alpha', 101);
    const beta = betaFirst ?? preset('beta', 202);
    const tracked = agent('unused', 0, { managed: true, parent: alpha.key });
    await tracked.announce();
    tracked.select(beta.key, 'bot-beta');
    tracked.select(beta.key, 'bot-beta');
    tracked.emit(message('assistant', [{ type: 'text', text: 'Beta answer' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ botId: 'beta', expectedBotCreatedAt: 202 });
    // A's later disposal must not remove B's active observer.
    await alpha.scope.dispose();
    tracked.emit(message('assistant', [{ type: 'text', text: 'Beta still active' }]));
    expect(recordActivity).toHaveBeenCalledTimes(2);
    expect(recordActivity.mock.calls[1]?.[0]).toMatchObject({ botId: 'beta', text: 'Beta still active' });
  }));

  it('stops on Bot to standard and installs one fresh lease when selecting the Bot again', async () => withFixture(async ({
    agent, preset, plainPreset, recordActivity,
  }) => {
    const alpha = preset('alpha');
    const standard = plainPreset();
    const tracked = agent('unused', 0, { managed: true, parent: alpha.key });
    await tracked.announce();
    tracked.select(standard.key, 'standard');
    tracked.emit(message('assistant', [{ type: 'text', text: 'Plain answer' }]));
    expect(recordActivity).not.toHaveBeenCalled();
    tracked.select(alpha.key, 'bot-alpha');
    tracked.emit(message('assistant', [{ type: 'text', text: 'Bot again' }]));
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]?.[0]).toMatchObject({ botId: 'alpha' });
  }));

  it('uses exact generation identity even when two owners share the same stable Bot id', async () => withFixture(async ({
    agent, preset, recordActivity,
  }) => {
    const old = preset('alpha');
    const current = preset('alpha');
    const retained = agent('unused', 0, { managed: true, parent: old.key });
    const switched = agent('unused', 0, { managed: true, parent: old.key });
    await retained.announce();
    await switched.announce();
    switched.select(current.key, 'bot-alpha');
    retained.emit(message('assistant', [{ type: 'text', text: 'Retained generation' }]));
    switched.emit(message('assistant', [{ type: 'text', text: 'Current generation' }]));
    expect(recordActivity).toHaveBeenCalledTimes(2);
    await old.scope.dispose();
    retained.emit(message('assistant', [{ type: 'text', text: 'Disposed old generation' }]));
    switched.emit(message('assistant', [{ type: 'text', text: 'Current remains' }]));
    expect(recordActivity).toHaveBeenCalledTimes(3);
    expect(recordActivity.mock.calls[2]?.[0]).toMatchObject({ sessionId: switched.session.id, text: 'Current remains' });
  }));

  it('cleans Agent-owned leases and ignores selection for a disposed Agent', async () => withFixture(async ({
    ctx, agent, preset, recordActivity,
  }) => {
    const alpha = preset('alpha');
    const tracked = agent('unused', 0, { managed: true, parent: alpha.key });
    await tracked.announce();
    await tracked.scope.dispose();
    ctx.emit('agent-preset/selected', tracked.session.id, 'bot-alpha');
    tracked.emit(message('assistant', [{ type: 'text', text: 'After disposal' }]));
    expect(recordActivity).not.toHaveBeenCalled();
    await alpha.scope.dispose();
  }));
});
