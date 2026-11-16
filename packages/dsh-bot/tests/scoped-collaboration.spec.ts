import { expect, test, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import type { DshBotRegistry } from '../src/host/registry.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { ScopedCollaboration, getScopedCollaborationBinding, protectScopedCollaboration,
  isScopedCollaborationInput, type CollaborationScope } from '../src/host/supergroup/collaboration.js';
import { registerDelegateTool } from '../src/host/delegate/tool.js';

function fixture() {
  const controller = new AbortController();
  const owner = { session: { id: 'main-alpha', header: {} } } as Agent;
  bindings.set(owner, { botId: 'alpha', botCreatedAt: 1 });
  const scope: CollaborationScope = { workId: 'work', operationId: 'operation', origin: owner, messageId: 'human',
    text: 'Exact current user task', owner: { botId: 'alpha', botCreatedAt: 1 },
    readers: [{ botId: 'alpha', botCreatedAt: 1 }, { botId: 'beta', botCreatedAt: 2 }],
    expiresAt: Date.now() + 300000, signal: controller.signal, check: vi.fn(async () => { controller.signal.throwIfAborted(); }) };
  const registry = { config: { supergroup: { enabled: true, maxMembers: 4 }, groupMaxDepth: 1 },
    get: vi.fn(async (id: string) => ({ id, createdAt: id === 'beta' ? 2 : 1, updatedAt: 3, name: id })),
    status: vi.fn(async () => ['alpha', 'beta', 'gamma'].map(id => ({ id, preset: { state: 'ok' }, presetId: `bot-${id}` }))) } as unknown as DshBotRegistry;
  const provider = { inheritsParentContext: false, prepareContinuable() {}, capabilities: { agentPreset: true, depthLimit: true } };
  let child: Agent | undefined;
  let bindingDuringStart: ReturnType<typeof getScopedCollaborationBinding>;
  const dispose = vi.fn(async () => {});
  const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>();
  let toolGuard: ((exec: { agent: Agent; parent?: unknown; name: string }) => string | undefined) | undefined;
  const childContext = { effect: (setup: () => () => void) => setup(),
    on: (event: string, listener: typeof listeners extends Map<string, infer T> ? T : never) => { listeners.set(event, listener); return () => listeners.delete(event); },
    tools: { guard: (callback: NonNullable<typeof toolGuard>) => { toolGuard = callback; return () => { toolGuard = undefined; }; } } };
  const startActivation = vi.fn(async (spec: { childId: string; request: { parent: Agent; agentPreset: string; prompt: unknown[] } }) => {
    child = { ctx: childContext, session: { id: spec.childId, header: { parentSession: spec.request.parent.session.id,
      agentPreset: spec.request.agentPreset } } } as unknown as Agent;
    bindingDuringStart = getScopedCollaborationBinding(child);
    const target = spec.request.agentPreset.slice(4), bot = { botId: target, botCreatedAt: target === 'beta' ? 2 : 1 };
    bindings.set(child, bot); protectScopedCollaboration(child, bot, 'startup');
    const protocol = JSON.parse((spec.request.prompt[0] as { text: string }).text);
    return { childId: spec.childId, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text',
      text: protocol.kind === 'dsh-bot-message-draft' ? 'A standalone question for beta' : 'Checked clean answer' }] }), dispose };
  });
  const projectScoped = vi.fn(async (input: { kind: string; operationId: string; workId: string }) => ({ messageId: `${input.operationId}:${input.kind}`,
    threadId: input.workId, fromSessionId: 'main-alpha', toSessionId: 'main-beta' }));
  const finishScoped = vi.fn(async () => {});
  const messaging = { exclusiveTarget: async (_target: unknown, run: () => Promise<unknown>) => run(), projectScoped, finishScoped };
  const ctx = { subagents: { getProvider: () => provider, startActivation }, get: (name: string) => name === 'dshBotMessaging' ? messaging : undefined } as unknown as Context;
  const hooks = { authorize: vi.fn(async () => scope), reserve: vi.fn(async () => {}), finish: vi.fn(async () => {}) };
  const service = new ScopedCollaboration(ctx, registry, hooks);
  Object.assign(childContext, { get: (name: string) => name === 'dshBotCollaboration' ? service : undefined });
  return { service, hooks, scope, controller, owner, registry, provider, ctx, startActivation, dispose, listeners,
    projectScoped, finishScoped, child: () => child!, binding: () => bindingDuringStart, toolGuard: () => toolGuard! };
}

test('automatic execution uses exact Host input, not caller private arguments, and retains the native caller contract', async () => {
  const f = fixture();
  const args = { task: 'PRIVATE_PARENT_HISTORY', title: 'PRIVATE_TITLE' };
  const prepared = await f.service.prepare(f.owner, 'beta', 'call-1', args, f.controller.signal);
  const result = await f.service.execute(prepared, args, f.controller.signal);
  expect(result).toMatchObject({ workId: 'work', operationId: 'operation', status: 'completed', result: 'Checked clean answer' });
  const draft = f.startActivation.mock.calls[0]![0], spec = f.startActivation.mock.calls[1]![0];
  expect(draft).toMatchObject({ request: { agentPreset: 'bot-alpha' } });
  expect(JSON.parse((draft.request.prompt[0] as { text: string }).text)).toMatchObject({
    kind: 'dsh-bot-message-draft', userTask: f.scope.text, sender: { id: 'alpha' }, recipient: { id: 'beta' } });
  expect(spec).toMatchObject({ provider: 'spawn', delivery: 'caller', label: 'beta', request: {
    parent: f.owner, agentPreset: 'bot-beta', maxDepth: 1 } });
  expect(JSON.parse((spec.request.prompt[0] as { text: string }).text)).toMatchObject({ kind: 'dsh-bot-message-request',
    question: 'A standalone question for beta', sender: { id: 'alpha' }, recipient: { id: 'beta' } });
  expect(result.actualRequest).toBe('A standalone question for beta');
  expect(result).toMatchObject({ from: f.scope.owner, to: f.scope.readers[1], requestMessageId: 'operation:request', replyMessageId: 'operation:reply' });
  expect(f.projectScoped).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: 'request', content: result.actualRequest }));
  expect(f.projectScoped).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'reply', content: result.result, requestId: result.requestMessageId }));
  expect(JSON.stringify(f.startActivation.mock.calls)).not.toContain('PRIVATE_');
  expect(f.binding()?.scope).toBe(f.scope);
  expect(getScopedCollaborationBinding(f.child())).toBeUndefined();
  expect(f.hooks.finish).toHaveBeenCalledWith(f.scope, result);
  expect(f.dispose).toHaveBeenCalledTimes(2);
  expect(await f.service.execute(prepared, args, f.controller.signal)).toEqual(result);
  const retry = await f.service.prepare(f.owner, 'beta', 'call-1', args, f.controller.signal);
  expect(retry).toBe(prepared);
  expect(f.hooks.authorize).toHaveBeenCalledOnce();
  await expect(f.service.prepare(f.owner, 'beta', 'call-1', { changed: true }, f.controller.signal)).rejects.toThrow('conflict');
  expect(f.startActivation).toHaveBeenCalledTimes(2);
  await f.service.close();
});

test('changed arguments, out-of-pool identities, self routes and context-inheriting providers do not dispatch', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.owner, 'beta', 'call-1', {}, f.controller.signal);
  await expect(f.service.execute(prepared, { changed: true }, f.controller.signal)).rejects.toThrow('conflict');
  await expect(f.service.prepare(f.owner, 'gamma', 'call-2', {}, f.controller.signal)).rejects.toThrow('approval-denied');
  await expect(f.service.prepare(f.owner, 'alpha', 'call-3', {}, f.controller.signal)).rejects.toThrow('route-loop');
  f.provider.inheritsParentContext = true;
  await expect(f.service.prepare(f.owner, 'beta', 'call-4', {}, f.controller.signal)).rejects.toThrow('unavailable');
  expect(f.startActivation).not.toHaveBeenCalled();
  await f.service.close();
});

test('self routes and unavailable providers reject before persisting an operation', async () => {
  const f = fixture();
  await expect(f.service.prepare(f.owner, 'alpha', 'self', {}, f.controller.signal)).rejects.toThrow('route-loop');
  expect(f.hooks.authorize).not.toHaveBeenCalled();
  f.provider.inheritsParentContext = true;
  await expect(f.service.prepare(f.owner, 'beta', 'provider', {}, f.controller.signal)).rejects.toThrow('unavailable');
  expect(f.hooks.authorize).not.toHaveBeenCalled();
  expect(f.startActivation).not.toHaveBeenCalled();
  await f.service.close();
});

test('scope rejection after the work receipt records a blocked operation instead of leaving it prepared', async () => {
  const f = fixture();
  await expect(f.service.prepare(f.owner, 'gamma', 'pool-rejected', {}, f.controller.signal)).rejects.toThrow('approval-denied');
  expect(f.hooks.authorize).toHaveBeenCalledOnce();
  expect(f.hooks.finish).toHaveBeenCalledWith(f.scope, expect.objectContaining({ status: 'blocked', childId: '' }));
  expect(f.startActivation).not.toHaveBeenCalled();
  await f.service.close();
});

test('a checked child cannot write a prepared operation for an ancestor route', async () => {
  const f = fixture();
  const initial = f.startActivation.getMockImplementation()!;
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    if (getScopedCollaborationBinding(f.child())?.phase === 'draft') return activation;
    await expect(f.service.prepare(f.child(), 'alpha', 'ancestor-loop', {}, f.controller.signal)).rejects.toThrow('route-loop');
    expect(f.hooks.authorize).toHaveBeenCalledOnce();
    return activation;
  });
  const prepared = await f.service.prepare(f.owner, 'beta', 'root', {}, f.controller.signal);
  expect(await f.service.execute(prepared, {}, f.controller.signal)).toMatchObject({ status: 'completed' });
  expect(f.hooks.finish).toHaveBeenCalledOnce();
  expect(f.hooks.finish).toHaveBeenCalledWith(f.scope, expect.objectContaining({ status: 'completed' }));
  await f.service.close();
});

test('task member budget limits expert chain depth without changing the ordinary group depth setting', async () => {
  const f = fixture();
  f.registry.config.supergroup.maxMembers = 2;
  f.scope.readers = [...f.scope.readers, { botId: 'gamma', botCreatedAt: 1 }];
  const initial = f.startActivation.getMockImplementation()!;
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    if (getScopedCollaborationBinding(f.child())?.phase === 'draft') return activation;
    await expect(f.service.prepare(f.child(), 'gamma', 'over-member-budget', {}, f.controller.signal)).rejects.toThrow('member-limit');
    expect(f.hooks.authorize).toHaveBeenCalledOnce();
    return activation;
  });
  const prepared = await f.service.prepare(f.owner, 'beta', 'root', {}, f.controller.signal);
  expect(prepared.maxDepth).toBe(1);
  expect(await f.service.execute(prepared, {}, f.controller.signal)).toMatchObject({ status: 'completed' });
  expect(f.registry.config.groupMaxDepth).toBe(1);
  expect(f.startActivation).toHaveBeenCalledTimes(2);
  await f.service.close();
});

test('an independently approved ask cannot send a scoped child through legacy delegation', async () => {
  const ctx = new Context(), f = fixture();
  let service: ScopedCollaboration | undefined;
  try {
    await ctx.plugin(SystemPrompt, {}).await();
    await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
    // Deliberately use ask instead of the native child's usual never policy:
    // this exercises the explicit execution guard after an independent approval.
    await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
    ctx.provide('dshBots', f.registry);
    ctx.provide('dshBotMessaging', { projectScoped: f.projectScoped, finishScoped: f.finishScoped,
      exclusiveTarget: async (_target: unknown, run: () => Promise<unknown>) => run() } as unknown as Context['dshBotMessaging']);
    ctx.provide('dshBotAutomationStores', { runs: {} } as Context['dshBotAutomationStores']);
    let ownerContext!: Context;
    let nestedOutcome: Awaited<ReturnType<Context['tools']['execute']>> | undefined;
    let childAgent: Agent | undefined;
    const startActivation = vi.fn(async (spec: SubagentActivationSpec) => {
      const id = spec.childId!;
      const session = Session.create(id, undefined, { version: 4, id, createdAt: Date.now(), isSeeded: false,
        parentSession: spec.request.parent.session.id, agentPreset: spec.request.agentPreset, origin: 'subagent', delegationDepth: 1 });
      const value = { id, session, ctx: ownerContext };
      const child = value as Agent;
      value.ctx = createScope(ownerContext, child).ctx;
      childAgent = child;
      const draft = JSON.parse((spec.request.prompt[0] as { text: string }).text).kind === 'dsh-bot-message-draft';
      const bot = draft ? { botId: 'alpha', botCreatedAt: 1 } : { botId: 'beta', botCreatedAt: 2 };
      bindings.set(child, bot);
      session.append('turn/start', { turn: 0 }); session.append('step/start', { turn: 0, step: 0 });
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: spec.request.prompt }), { surfaceOp: 'append' });
      protectScopedCollaboration(child, bot, 'startup');
      if (draft) return { childId: id, result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'The clean question' }] }), dispose: async () => {} };
      child.ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        return exec.name === 'bot_delegate' ? { kind: 'ask' as const, reason: 'Independent native approval' } : decision;
      });
      registerDelegateTool(child);
      nestedOutcome = await ctx.tools.execute({ agent: child, name: 'bot_delegate', arguments: { targetBotId: 'gamma', task: 'A task question' },
        callId: ToolCallId('independent-ask'), signal: f.controller.signal });
      return { childId: id, result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'A checked reply' }] }), dispose: async () => {} };
    });
    ctx.provide('subagents', { getProvider: () => f.provider, startActivation } as unknown as Context['subagents']);
    await ctx.plugin({ inject: ['tools', 'approval', 'subagents', 'dshBots', 'dshBotAutomationStores'], apply(value: Context) { ownerContext = value; } }).await();
    service = new ScopedCollaboration(ownerContext, f.registry, f.hooks);
    ctx.provide('dshBotCollaboration', service);
    const approvals = vi.fn(async () => 'allowed-once' as const);
    ctx.on('approval/request', approvals);
    const prepared = await service.prepare(f.owner, 'beta', 'outer', {}, f.controller.signal);
    await service.execute(prepared, {}, f.controller.signal);
    expect(approvals).toHaveBeenCalledOnce();
    expect(childAgent!.session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once')).toBe(true);
    expect(nestedOutcome?.isError).toBe(true);
    expect(JSON.stringify(nestedOutcome)).toContain('only checked Bot collaboration');
    expect(startActivation).toHaveBeenCalledTimes(2);
    // The independent approval did not mint another Supergroup operation either.
    expect(f.hooks.authorize).toHaveBeenCalledOnce();
  } finally { await service?.close(); await f.service.close(); await ctx.fiber.dispose(); }
});

test('clean collaboration uses the shared target queue without waiting for a busy human main chat', async () => {
  const f = fixture();
  const whenIdle = vi.fn(() => new Promise<void>(() => {}));
  const findMain = vi.fn(async () => ({ sessionId: 'busy-main-beta' }));
  Object.assign(f.registry, { mainSessions: { find: findMain } });
  const exclusiveTarget = vi.fn(async (_target: unknown, run: () => Promise<unknown>) => run());
  Object.assign(f.ctx, { get: (name: string) => name === 'agents' ? { get: () => ({ whenIdle }) }
    : name === 'dshBotMessaging' ? { exclusiveTarget, projectScoped: f.projectScoped, finishScoped: f.finishScoped } : undefined });
  const prepared = await f.service.prepare(f.owner, 'beta', 'busy-target', {}, f.controller.signal);
  expect(await f.service.execute(prepared, {}, f.controller.signal)).toMatchObject({ status: 'completed' });
  expect(exclusiveTarget).toHaveBeenCalledTimes(2);
  expect(whenIdle).not.toHaveBeenCalled();
  expect(findMain).not.toHaveBeenCalled();
  await f.service.close();
});

test('three separate works can ask each other through serialized acceptance without holding queues for results', async () => {
  const controller = new AbortController();
  const ids = ['alpha', 'beta', 'gamma'];
  const keys = ids.map((botId, index) => ({ botId, botCreatedAt: index + 1 }));
  const roots = ids.map((id, index) => {
    const agent = { session: { id: `main-${id}`, header: {} } } as Agent;
    bindings.set(agent, keys[index]!);
    return agent;
  });
  const targetTails = new Map<string, Promise<unknown>>();
  const exclusiveTarget = async <T>(target: { botId: string }, execute: () => Promise<T>) => {
    const task = (targetTails.get(target.botId) ?? Promise.resolve()).then(execute);
    targetTails.set(target.botId, task.catch(() => {}));
    return task;
  };
  const registry = { config: { supergroup: { enabled: true, maxMembers: 4 }, groupMaxDepth: 1 },
    get: async (id: string) => ({ id, createdAt: ids.indexOf(id) + 1, updatedAt: 1, name: id }),
    status: async () => ids.map(id => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })) } as unknown as DshBotRegistry;
  let service!: ScopedCollaboration;
  let starts = 0, firstStarts = 0;
  let releaseFirst!: () => void;
  const firstAccepted = new Promise<void>(accept => { releaseFirst = accept; });
  const startActivation = async (spec: SubagentActivationSpec) => {
    starts++;
    const targetId = spec.request.agentPreset!.slice(4), key = keys[ids.indexOf(targetId)]!;
    const parentDepth = spec.request.parent.session.header.delegationDepth ?? 0;
    expect(spec.request.maxDepth).toBe(2);
    expect(parentDepth + 1).toBeLessThanOrEqual(spec.request.maxDepth!);
    const childContext = { effect: (setup: () => () => void) => setup(), on: () => () => {},
      tools: { guard: () => () => {} }, get: (name: string) => name === 'dshBotCollaboration' ? service : undefined };
    const child = { ctx: childContext, session: { id: spec.childId!, header: { parentSession: spec.request.parent.session.id,
      agentPreset: spec.request.agentPreset, delegationDepth: parentDepth + 1 } } } as unknown as Agent;
    bindings.set(child, key);
    protectScopedCollaboration(child, key, 'startup');
    const nativeAbort = new AbortController();
    const aborted = new Promise<never>((_accept, reject) => nativeAbort.signal.addEventListener('abort', () => reject(new Error('Native fixture stopped')), { once: true }));
    const draft = JSON.parse((spec.request.prompt[0] as { text: string }).text).kind === 'dsh-bot-message-draft';
    if (!draft && parentDepth === 0 && ++firstStarts === 3) releaseFirst();
    const work = Promise.resolve().then(async (): Promise<SubagentResult> => {
      if (draft) return { stopReason: 'completed', output: [{ type: 'text', text: 'A clean question from the sender' }] };
      if (parentDepth === 0) {
        await firstAccepted;
        const next = ids[(ids.indexOf(targetId) + 1) % ids.length]!;
        const args = { content: 'A specific question from the clean task' };
        const prepared = await service.prepare(child, next, 'nested', args, controller.signal);
        const value = await service.execute(prepared, args, controller.signal);
        return { stopReason: 'completed', output: [{ type: 'text', text: value.result }] };
      }
      return { stopReason: 'completed', output: [{ type: 'text', text: 'Checked expert answer' }] };
    });
    return { childId: spec.childId!, result: Promise.race([work, aborted]), dispose: async () => { nativeAbort.abort(); } };
  };
  const ctx = { get: (name: string) => name === 'dshBotMessaging' ? { exclusiveTarget, projectScoped: async () => ({ messageId: 'shown' }), finishScoped: async () => {} } : undefined,
    subagents: { startActivation, getProvider: () => ({ inheritsParentContext: false, prepareContinuable() {},
      capabilities: { agentPreset: true, depthLimit: true } }) } } as unknown as Context;
  service = new ScopedCollaboration(ctx, registry, {
    authorize: async (agent, _target, callId) => {
      const origin = getScopedCollaborationBinding(agent)?.scope.origin ?? agent;
      return { workId: `work-${origin.session.id}`, operationId: `${agent.session.id}/${callId}`, origin,
        messageId: `human-${origin.session.id}`, text: 'A current user task', owner: bindings.get(origin)!, readers: keys,
        expiresAt: Date.now() + 300000, signal: controller.signal, check: async () => { controller.signal.throwIfAborted(); } };
    }, reserve: async () => {}, finish: async () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([Promise.all(roots.map(async (owner, index) => {
      const prepared = await service.prepare(owner, ids[(index + 1) % ids.length]!, 'root', {}, controller.signal);
      return service.execute(prepared, {}, controller.signal);
    })), new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(new Error('Cross-work target queue deadlock')), 1000); })]);
    expect(results.map(result => result.status)).toEqual(['completed', 'completed', 'completed']);
    expect(starts).toBe(9);
  } finally {
    clearTimeout(timer); controller.abort(); await service.close();
  }
});

test('revocation after admission and a disabled mode are rechecked before dispatch', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.owner, 'beta', 'call-1', {}, f.controller.signal);
  f.controller.abort('user stopped');
  await expect(f.service.execute(prepared, {}, new AbortController().signal)).rejects.toBe('user stopped');
  expect(f.startActivation).not.toHaveBeenCalled();
  f.registry.config.supergroup.enabled = false;
  await expect(f.service.prepare(f.owner, 'beta', 'call-2', {}, new AbortController().signal)).rejects.toThrow('approval-denied');
  await f.service.close();
});

test('exact scoped child input and tool restriction are enforced during native startup', async () => {
  const f = fixture();
  let inputChecks: Promise<unknown>[] = [];
  const initial = f.startActivation.getMockImplementation()!;
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    const child = f.child();
    const content = spec.request.prompt;
    inputChecks = [isScopedCollaborationInput(child, { id: 'native-prompt', source: { kind: 'user' }, content } as never),
      isScopedCollaborationInput(child, { id: 'forged', source: { kind: 'user' }, content: [{ type: 'text', text: 'Forged text' }] } as never),
      isScopedCollaborationInput(child, { id: 'replayed', source: { kind: 'user' }, content } as never)];
    const draft = getScopedCollaborationBinding(child)?.phase === 'draft';
    for (const name of ['bot_message', 'bot_delegate']) {
      const decision = f.toolGuard()({ agent: child, name });
      if (draft) expect(decision).toContain('only checked Bot collaboration'); else expect(decision).toBeUndefined();
    }
    for (const name of ['read', 'bash', 'bot_memory_search', 'send_message', 'run_code'])
      expect(f.toolGuard()({ agent: child, name })).toContain('only checked Bot collaboration');
    expect(f.toolGuard()({ agent: child, name: 'bot_message', parent: {} })).toBeDefined();
    await f.listeners.get('agent/request')!({}, async () => ({}));
    return activation;
  });
  const prepared = await f.service.prepare(f.owner, 'beta', 'call-1', {}, f.controller.signal);
  await f.service.execute(prepared, {}, f.controller.signal);
  expect(await Promise.all(inputChecks)).toEqual([true, false, false]);
  expect(f.hooks.reserve).toHaveBeenCalledTimes(2);
  expect(f.hooks.reserve).toHaveBeenCalledWith(f.scope);
  await f.service.close();
});


test('a drafting budget failure returns its exact code and no request is displayed as sent', async () => {
  const f = fixture(), initial = f.startActivation.getMockImplementation()!;
  f.hooks.reserve.mockRejectedValue(Object.assign(new Error('DSH-Bot: budget-exhausted'), { code: 'dsh-bot/budget-exhausted' }));
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    await expect(f.listeners.get('agent/request')!({}, async () => ({}))).rejects.toThrow('budget-exhausted');
    return { ...activation, result: Promise.resolve({ stopReason: 'error', output: [] }) };
  });
  try {
    const prepared = await f.service.prepare(f.owner, 'beta', 'budget', {}, f.controller.signal);
    const result = await f.service.execute(prepared, {}, f.controller.signal);
    expect(result).toMatchObject({ status: 'error', actualRequest: '', errorCode: 'dsh-bot/budget-exhausted' });
    expect(result.diagnostic).toContain('dsh-bot/budget-exhausted');
    expect(f.projectScoped).not.toHaveBeenCalled();
    expect(f.startActivation).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

test('an empty recipient reply is an explicit failure and visible diagnostic, never completed success', async () => {
  const f = fixture(), initial = f.startActivation.getMockImplementation()!;
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    return JSON.parse((spec.request.prompt[0] as { text: string }).text).kind === 'dsh-bot-message-draft' ? activation
      : { ...activation, result: Promise.resolve({ stopReason: 'completed', output: [] }) };
  });
  try {
    const prepared = await f.service.prepare(f.owner, 'beta', 'empty', {}, f.controller.signal);
    const result = await f.service.execute(prepared, {}, f.controller.signal);
    expect(result).toMatchObject({ status: 'error', result: '', errorCode: 'subagent/empty-output', actualRequest: 'A standalone question for beta' });
    expect(result.diagnostic).toBeTruthy();
    expect(f.projectScoped).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: 'reply', content: result.diagnostic }));
  } finally { await f.service.close(); }
});


test('missing visible Messaging service rejects before minting work authority or starting a draft', async () => {
  const f = fixture();
  Object.assign(f.ctx, { get: () => undefined });
  try {
    await expect(f.service.prepare(f.owner, 'beta', 'missing-messaging', {}, f.controller.signal)).rejects.toThrow('unavailable');
    expect(f.hooks.authorize).not.toHaveBeenCalled();
    expect(f.startActivation).not.toHaveBeenCalled();
    expect(f.projectScoped).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});


test('final public prompt assembly hides local native tools and preserves other assembly fields', async () => {
  const f = fixture(), initial = f.startActivation.getMockImplementation()!;
  const observed: { phase: string | undefined; names: string[] }[] = [];
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    const source = { sections: [{ name: 'persona', text: 'configured persona' }], contexts: [],
      variables: { provider: 'unchanged-provider' },
      tools: ['bot_manage', 'subagent', 'read', 'bot_message', 'bot_delegate'].map(name => ({ name })) };
    const next = vi.fn(async () => source);
    const assemble = f.listeners.get('system-prompt/assemble') as unknown as
      (assembly: typeof source, context: object, next: () => Promise<typeof source>) => Promise<typeof source>;
    const result = await assemble(source, {}, next);
    const phase = getScopedCollaborationBinding(f.child())?.phase;
    observed.push({ phase, names: result.tools.map(tool => tool.name) });
    expect(next).toHaveBeenCalledOnce();
    expect(result.sections).toBe(source.sections);
    expect(result.contexts).toBe(source.contexts);
    expect(result.variables).toBe(source.variables);
    expect(source.tools.map(tool => tool.name)).toEqual(['bot_manage', 'subagent', 'read', 'bot_message', 'bot_delegate']);
    return activation;
  });
  try {
    const prepared = await f.service.prepare(f.owner, 'beta', 'schema', {}, f.controller.signal);
    await f.service.execute(prepared, {}, f.controller.signal);
    expect(observed).toEqual([{ phase: 'draft', names: [] }, { phase: 'reply', names: ['bot_message', 'bot_delegate'] }]);
  } finally { await f.service.close(); }
});


test('notify sends a visible notice without running the recipient or inventing a reply', async () => {
  const f = fixture();
  try {
    const args = { action: 'send', mode: 'notify', content: 'PRIVATE_PARENT_PROPOSAL' };
    const prepared = await f.service.prepare(f.owner, 'beta', 'notice', args, f.controller.signal);
    expect(prepared.mode).toBe('notify');
    const result = await f.service.execute(prepared, args, f.controller.signal);
    expect(result).toMatchObject({ status: 'completed', deliveryMode: 'notify', actualRequest: 'A standalone question for beta',
      requestMessageId: 'operation:request' });
    expect(result.result).toBeTruthy();
    expect(result).not.toHaveProperty('replyMessageId');
    expect(f.startActivation).toHaveBeenCalledOnce();
    expect(f.startActivation.mock.calls[0]![0].request.agentPreset).toBe('bot-alpha');
    expect(JSON.parse((f.startActivation.mock.calls[0]![0].request.prompt[0] as { text: string }).text)).toMatchObject({
      kind: 'dsh-bot-message-draft', mode: 'notify' });
    expect(f.projectScoped).toHaveBeenCalledOnce();
    expect(f.projectScoped).toHaveBeenCalledWith(expect.objectContaining({ kind: 'request', mode: 'notify', content: result.actualRequest }));
    expect(JSON.stringify(f.startActivation.mock.calls)).not.toContain('PRIVATE_PARENT_PROPOSAL');
    expect(f.hooks.finish).toHaveBeenCalledWith(f.scope, result);
  } finally { await f.service.close(); }
});


test('reply assembly without initialized tools preserves its public shape without crashing', async () => {
  const f = fixture(), initial = f.startActivation.getMockImplementation()!;
  const observed: { phase: string | undefined; same: boolean; tools?: unknown }[] = [];
  f.startActivation.mockImplementation(async spec => {
    const activation = await initial(spec);
    const source = { sections: [], contexts: [], variables: { provider: 'kept' } };
    const assemble = f.listeners.get('system-prompt/assemble') as unknown as
      (assembly: typeof source, context: object, next: () => Promise<typeof source>) => Promise<typeof source & { tools?: unknown }>;
    const result = await assemble(source, {}, async () => source);
    const child = f.child(), phase = getScopedCollaborationBinding(child)?.phase;
    observed.push({ phase, same: result === source, ...(Object.hasOwn(result, 'tools') ? { tools: result.tools } : {}) });
    expect(f.toolGuard()({ agent: child, name: 'bot_manage' })).toBeTruthy();
    expect(f.toolGuard()({ agent: child, name: 'subagent' })).toBeTruthy();
    return activation;
  });
  try {
    const prepared = await f.service.prepare(f.owner, 'beta', 'late-schemas', {}, f.controller.signal);
    await f.service.execute(prepared, {}, f.controller.signal);
    expect(observed).toEqual([{ phase: 'draft', same: false, tools: [] }, { phase: 'reply', same: true }]);
  } finally { await f.service.close(); }
});
