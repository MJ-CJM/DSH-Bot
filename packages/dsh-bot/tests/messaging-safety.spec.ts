import { withoutWakeControls } from '../src/host/messaging/wake.js';
import { describe, it, expect, vi } from 'vitest';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { withIntegrations } from './integration-support.js';
import { MessagingSafety, teammateTurn } from '../src/host/messaging/safety.js';
import { messageInputSchema, messageSourceSchema } from '../src/shared/messaging.js';
import { messageRequestSchema } from '../src/shared/messaging-contract.js';
const source = messageSourceSchema.parse({ kind: 'dsh-bot-message', form: 'relay', messageId: 'm1', threadId: 'm1',
  from: { botId: 'alpha', botCreatedAt: 1 }, to: { botId: 'beta', botCreatedAt: 1 },
  fromSessionId: 's-a', toSessionId: 's-b', hop: 1, mode: 'ask', priority: 'normal',
  displaySnapshots: { from: { name: 'A' }, to: { name: 'B' } } });
const body = vi.fn(async () => ({ ok: true }));
function tool(name: string) { return defineTool({ name, description: 'Safety fixture', parameters: {},
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: body }); }
describe('B04 native runtime safety (Agent/log fixtures)', () => {
  it('rejects wake-only admission even when native next appends runtime context', () => {
    const wake = createUserMessage({ source: { kind: 'dsh-bot-message-wake', form: 'notice', summary: 'wake', messageId: 'm', generation: 'old', toSessionId: 's' }, content: [{ type: 'text', text: 'control' }] });
    const context = { ...wake, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ambient' }] } as unknown as ReturnType<typeof createUserMessage>;
    expect(withoutWakeControls([wake], { kind: 'enter', messages: [wake, context] })).toEqual({ kind: 'reject' });
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'business' }] });
    expect(withoutWakeControls([wake, user], { kind: 'enter', messages: [wake, user, context] })).toEqual({ kind: 'enter', messages: [user, context] });
    expect(withoutWakeControls([], { kind: 'enter', messages: [context] })).toEqual({ kind: 'enter', messages: [context] });
  });
  it('holds mixed input for the entire turn, asks unknown tools, preserves deny/never, and keeps a retained guard after unload', () => withIntegrations(async (f) => {
    const { agent, scope } = f.createAgent(), safety = new MessagingSafety();
    safety.protect(agent); const off = agent.ctx.tools.register(tool('unknown_action'));
    const execute = () => f.ctx.tools.execute({ agent, name: 'unknown_action', arguments: {}, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
    agent.session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'peer' }] }), { surfaceOp: 'append' });
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'mixed human' }] }), { surfaceOp: 'append' });
    expect(teammateTurn(agent)).toBe(true);
    body.mockClear(); let outcome = 'rejected' as 'rejected' | 'allowed-once';
    const answers = vi.fn(async () => outcome); f.ctx.on('approval/request', answers);
    expect((await execute()).isError).toBe(true); expect(body).not.toHaveBeenCalled();
    outcome = 'allowed-once'; expect((await execute()).isError).toBe(false); expect(body).toHaveBeenCalledTimes(1);
    setApprovalPolicy(agent.session, 'never'); expect((await execute()).isError).toBe(true); expect(body).toHaveBeenCalledTimes(1);
    setApprovalPolicy(agent.session, 'ask');
    const deny = agent.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'native denial' }));
    expect((await execute()).isError).toBe(true); deny();
    safety.active = false; expect((await execute()).isError).toBe(true); expect(body).toHaveBeenCalledTimes(1);
    // New independent human turn clears the source barrier, never a mixed input.
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
    agent.session.append('turn/start', { turn: 1 });
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new human' }] }), { surfaceOp: 'append' });
    expect(teammateTurn(agent)).toBe(false); expect((await execute()).isError).toBe(false);
    off(); scope.dispose();
  }));
  it('denies parent-token bot_message dispatches and asks the outer run_code-equivalent unknown transport', () => withIntegrations(async (f) => {
    const { agent, scope } = f.createAgent(), safety = new MessagingSafety(); safety.protect(agent);
    const inner = vi.fn(async () => ({ ok: true }));
    agent.ctx.tools.register({ ...tool('bot_message'), execute: inner });
    agent.ctx.tools.register({ ...tool('transport'), async execute(_args, exec) {
      return f.ctx.tools.execute({ agent, name: 'bot_message', arguments: {}, parent: exec.token,
        rootCallId: exec.rootCallId, callId: ToolCallId('nested'), signal: exec.signal });
    } });
    agent.session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'peer' }] }), { surfaceOp: 'append' });
    const asks = vi.fn(async () => 'allowed-once' as const); f.ctx.on('approval/request', asks);
    const result = await f.ctx.tools.execute({ agent, name: 'transport', arguments: {}, callId: ToolCallId('outer'), signal: new AbortController().signal });
    expect(asks).toHaveBeenCalledOnce(); expect(inner).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('disabled inside run_code'); scope.dispose();
  }));
  it('applies native approval to actual run_code and denies bot_message at its SDK sub-dispatch seam', () => withIntegrations(async (f) => {
    const { agent, scope } = f.createAgent(), safety = new MessagingSafety(); safety.protect(agent);
    const inner = vi.fn(async () => ({ ok: true })); agent.ctx.tools.register({ ...tool('bot_message'), execute: inner });
    const runs = vi.fn(async (spec: { bindings: Array<{ functions: Record<string, (args: unknown) => Promise<unknown>> }> }) => {
      try { await spec.bindings[0]?.functions.bot_message?.({}); return { value: null, logs: [] }; }
      catch (error) { return { error: { kind: 'exception', message: String(error) }, logs: [] }; }
    });
    // Public provider seam fixture: native run_code, SDK dispatch, ToolRuntime and ApprovalService are real.
    f.ctx.provide('ptcRuntime', { language: 'typescript', isolation: 'fixture', programFormat: 'async-function-body',
      resolve: (request: object) => ({ ...request, cwd: f.root, timeoutMs: null }), run: runs, release: async () => {},
    } as unknown as typeof f.ctx.ptcRuntime);
    f.ctx.provide('workingDirectory', { ensure: async () => f.root });
    const present = agent.ctx.tools.presentAs('ptc');
    agent.session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'peer' }] }), { surfaceOp: 'append' });
    let outcome = 'rejected' as 'rejected' | 'allowed-once'; const asks = vi.fn(async () => outcome); f.ctx.on('approval/request', asks);
    const execute = () => f.ctx.tools.execute({ agent, name: 'run_code', arguments: { code: 'await tools.bot_message({})', description: 'PTC guarded fixture' }, callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
    expect((await execute()).isError).toBe(true); expect(runs).not.toHaveBeenCalled();
    outcome = 'allowed-once'; const result = await execute();
    expect(asks).toHaveBeenCalledTimes(2); expect(runs, JSON.stringify(result)).toHaveBeenCalledOnce(); expect(inner).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('disabled inside run_code'); present(); scope.dispose();
  }));
  it('retains the minimal guard when the creating preset plugin fiber is disposed', () => withIntegrations(async (f) => {
    const { agent, scope } = f.createAgent(), safety = new MessagingSafety();
    const preset = f.ctx.plugin({ apply() { safety.protect(agent); } }); await preset.await();
    const action = vi.fn(async () => ({ ok: true })); agent.ctx.tools.register({ ...tool('retained_action'), execute: action });
    agent.session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'pending teammate' }] }), { surfaceOp: 'append' });
    f.ctx.on('approval/request', async () => 'allowed-once');
    await preset.dispose(); safety.close();
    const result = await f.ctx.tools.execute({ agent, name: 'retained_action', arguments: {}, callId: ToolCallId('retained'), signal: new AbortController().signal });
    expect(result.isError).toBe(true); expect(action).not.toHaveBeenCalled(); scope.dispose();
  }));
  it('binds grants to exact native invocations and rejects forged wire fields', () => withIntegrations(async (f) => {
    const { agent, scope } = f.createAgent(), safety = new MessagingSafety();
    const input = messageInputSchema.parse({ action: 'send', to: 'beta', mode: 'ask', content: 'question' });
    if (input.action === 'list') throw Error();
    const target = { botId: 'beta', botCreatedAt: 1 };
    safety.grant(agent, input, target, 'one', [target]);
    await expect(safety.approve(agent, input, target, 'wrong')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    const id = await safety.approve(agent, input, target, 'one'); expect(safety.targets(id)).toEqual([target]);
    await expect(safety.approve(agent, input, target, 'one')).rejects.toThrow();
    for (const key of ['from', 'threadId', 'authorizationId', 'fromSessionId', 'botCreatedAt'])
      expect(messageInputSchema.safeParse({ ...input, [key]: 'forged' }).success).toBe(false);
    expect(messageRequestSchema.safeParse({ action: 'cancel', id: 'm', revision: 1, sessionId: 'forged' }).success).toBe(false);
    const aborted = new AbortController(); aborted.abort();
    safety.grant(agent, input, target, 'aborted', [target], aborted.signal);
    await expect(safety.approve(agent, input, target, 'aborted')).rejects.toThrow();
    safety.grant(agent, input, target, 'unloaded', [target], undefined, () => false);
    await expect(safety.approve(agent, input, target, 'unloaded')).rejects.toThrow();
    scope.dispose();
  }));
});
