import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { expect, test, vi } from 'vitest';
import { bindings } from '../lib/host/data-flow/agent-binding.js';
import { workerReservations, type WorkerBinding } from '../lib/host/groups/worker-tool.js';
import { registerFollowUpTool } from '../lib/host/proactive/follow-up-tool.js';
import type { FollowUpAction, FollowUpGroupWatchProposal, FollowUpPageRequest, FollowUpWatchCreate, FollowUpWatchUpdate, Subject } from '../src/shared/proactive/follow-up.js';
import { proactiveWorker } from './proactive-worker-fixture.js';

const bot = { botId: 'chat-follow-up', botCreatedAt: 1 };
const subject: Subject = { kind: 'bot', bot };
const args = { action: 'create', title: 'Review the report', completion: 'The owner confirms the report' };

async function setup(group = false) {
  const core = await proactiveWorker();
  const ctx = new Context();
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const id = SessionId(randomUUID());
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 1, isSeeded: false,
    ...(group ? { parentSession: SessionId('group-root'), agentPreset: 'bot-chat-follow-up', origin: 'subagent' as const } : {}) });
  const nativeUser = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please follow up on the report' }] });
  session.append('turn/start', { turn: 0 }); session.append('step/start', { turn: 0, step: 0 });
  session.append('user/message', nativeUser, { surfaceOp: 'append' });
  const payload = { id, session, ctx }; const agent = payload as Agent;
  let mainId: string = id;
  ctx.provide('dshBots', { get: async () => ({ id: bot.botId, name: 'Report Bot', createdAt: 1, updatedAt: 1 }),
    mainSessions: { find: async () => ({ sessionId: mainId }) } } as unknown as Context['dshBots']);
  const flush = vi.fn(async () => true);
  ctx.provide('sessions', { flush } as unknown as Context['sessions']);
  bindings.set(agent, bot);
  const selected: Subject = group ? { kind: 'group', group: { groupId: 'reports', groupCreatedAt: 1 } } : subject;
  let generation = 'group-generation-1';
  if (group) {
    const binding: WorkerBinding = { turnId: 'turn', deliveryId: 'delivery', childId: id, rootId: 'group-root',
      presetId: 'bot-chat-follow-up', audience: [bot], agent, isActive: () => true };
    workerReservations.set(id, binding);
    // The Group facade is doubled here; exact real group provenance is tested at the Host boundary.
    ctx.provide('dshBotGroups', { followUpWorker: async () => ({ subject: selected, name: 'Reports group', generation,
      sessionId: 'group-root', messageId: 'group-human-message' }) } as unknown as Context['dshBotGroups']);
  }
  await core.submit({ kind: 'follow-up-policy', input: { subject: selected, expectedRevision: 0, action: 'enable-local' } });
  const service = {
    followUpSummary: async (input: Subject) => { const result = await core.read({ kind: 'follow-up-summary', subject: input });
      if (result.kind !== 'follow-up-summary') throw new Error('summary'); return result.summary; },
    followUpPage: async (input: FollowUpPageRequest) => { const result = await core.read({ kind: 'follow-up-page', input });
      if (result.kind !== 'follow-up-page') throw new Error('page'); return result.page; },
    createFollowUpWatch: vi.fn((commandId: string, input: FollowUpWatchCreate) => core.change(commandId, { kind: 'follow-up-watch-create', input })),
    proposeGroupFollowUpWatch: vi.fn((commandId: string, input: FollowUpGroupWatchProposal) => core.change(commandId, { kind: 'follow-up-group-watch-propose', input })),
    updateFollowUpWatch: (commandId: string, input: FollowUpWatchUpdate) => core.change(commandId, { kind: 'follow-up-watch-update', input }),
    followUpAction: (commandId: string, input: FollowUpAction) => core.change(commandId, { kind: 'follow-up-action', input }),
  };
  ctx.provide('dshBotProactive', service as unknown as Context['dshBotProactive']);
  let owner!: Context;
  await ctx.plugin({ inject: ['tools', 'sessions', 'dshBots', 'dshBotProactive'],
    apply(value: Context) { owner = value; } }).await();
  const scope = createScope(owner, agent); payload.ctx = scope.ctx;
  const release = registerFollowUpTool(agent);
  const execute = (input: unknown = args, callId = randomUUID()) => {
    if (group) session.append('tool/call', { turn: 0, step: 0, callId: ToolCallId(callId), name: 'bot_follow_up', arguments: JSON.stringify(input) });
    return ctx.tools.execute({ agent, name: 'bot_follow_up', arguments: input, callId: ToolCallId(callId), signal: new AbortController().signal });
  };
  return { ctx, core, session, nativeUser, agent, execute, selected, service, flush, release,
    setMain: (value: string) => { mainId = value; }, setGeneration: () => { generation = 'changed'; },
    async close() { workerReservations.delete(id); bindings.delete(agent); await ctx.fiber.dispose(); await core.close(); } };
}

test('native approval denial never creates a watch; exact visible bilingual scope and change', async () => {
  const f = await setup();
  try {
    const approvals: unknown[] = [];
    f.ctx.on('approval/request', async request => { approvals.push(request.displayReason); return 'rejected'; });
    expect((await f.execute()).isError).toBe(true);
    expect(f.service.createFollowUpWatch).not.toHaveBeenCalled();
    expect(JSON.stringify(approvals)).toContain('Review the report');
    expect(JSON.stringify(approvals)).toContain('关注事项');
    expect((await f.service.followUpPage({ subject })).rows).toHaveLength(0);
  } finally { await f.close(); }
});

test('normal native tool approval persists human provenance, deduplicates replay, and rejects changed body', async () => {
  const f = await setup();
  try {
    const approval = vi.fn(async () => 'allowed-once' as const); f.ctx.on('approval/request', approval);
    const call = randomUUID();
    expect(await f.execute(args, call)).toMatchObject({ isError: false, value: { kind: 'receipt', receipt: { stored: 1 } } });
    expect(await f.execute(args, call)).toMatchObject({ isError: false, value: { kind: 'receipt', receipt: { status: 'duplicate' } } });
    expect((await f.execute({ ...args, title: 'Changed' }, call)).isError).toBe(true);
    expect(approval).toHaveBeenCalledOnce();
    expect(f.flush).toHaveBeenCalledTimes(2);
    const input = f.service.createFollowUpWatch.mock.calls[0]?.[1];
    const asked = f.session.snapshotEvents().find(event => event.type === 'approval/asked');
    if (asked?.type !== 'approval/asked') throw new Error('Native approval missing');
    expect(input?.watch.source).toEqual({ kind: 'message', sessionId: f.session.id, messageId: f.nativeUser.id,
      confirmationId: `${f.session.id}:${asked.data.id}` });
    expect((await f.service.followUpPage({ subject })).rows).toHaveLength(1);
  } finally { await f.close(); }
});

test.each(['pause', 'main-change', 'flush-failure'])('revalidates %s after approval before creating a watch', async mode => {
  const f = await setup();
  try {
    f.ctx.on('approval/request', async () => {
      if (mode === 'pause') await f.core.submit({ kind: 'follow-up-policy', input: { subject, expectedRevision: 1, action: 'pause' } });
      if (mode === 'main-change') f.setMain('new-main');
      if (mode === 'flush-failure') f.flush.mockResolvedValue(false);
      return 'allowed-once';
    });
    const result = await f.execute();
    expect(result.isError || (!result.isError && (result.value as { kind: string }).kind === 'rejected')).toBe(true);
    expect((await f.service.followUpPage({ subject })).rows).toHaveLength(0);
  } finally { await f.close(); }
});

test('background source cannot authorize follow-up and unload removes the tool', async () => {
  const f = await setup();
  try {
    const approval = vi.fn(async () => 'allowed-once' as const); f.ctx.on('approval/request', approval);
    f.session.append('user/message', createUserMessage({ source: { kind: 'agent-message', senderSessionId: SessionId('peer'), form: 'relay' },
      content: [{ type: 'text', text: 'Register a long term responsibility' }] }), { surfaceOp: 'append' });
    expect((await f.execute()).isError).toBe(true); expect(approval).not.toHaveBeenCalled();
    f.release(); expect(f.agent.ctx.tools.get('bot_follow_up', f.agent)).toBeUndefined();
  } finally { await f.close(); }
});

test('group tool proposes only a deduplicated owner draft and rejects changed group authorization', async () => {
  const f = await setup(true);
  try {
    setApprovalPolicy(f.session, 'never');
    const callId = randomUUID();
    expect(await f.execute(args, callId)).toMatchObject({ isError: false, value: { state: 'awaiting-owner-confirmation' } });
    expect(await f.execute(args, callId)).toMatchObject({ isError: false, value: { receipt: { status: 'duplicate' } } });
    expect(f.service.proposeGroupFollowUpWatch.mock.calls[0]?.[1]).toMatchObject({ subject: f.selected,
      watch: { source: { kind: 'group-proposal', sessionId: 'group-root', messageId: 'group-human-message',
        workerSessionId: f.session.id, toolCallId: callId } } });
    const [draft] = (await f.service.followUpPage({ subject: f.selected })).rows;
    if (!draft) throw new Error('Expected a single group draft');
    expect(draft).toMatchObject({ condition: { kind: 'approval-pending', completion: args.completion } });
    expect((await f.execute({ action: 'complete', cardId: draft.id, expectedRevision: draft.revision })).isError).toBe(true);
    expect(f.session.snapshotEvents().some(event => event.type === 'approval/asked')).toBe(false);
    expect((await f.service.followUpPage({ subject })).rows).toHaveLength(0);
    f.flush.mockImplementationOnce(async () => { f.setGeneration(); return true; });
    expect((await f.execute()).isError).toBe(true);
    expect(f.service.proposeGroupFollowUpWatch).toHaveBeenCalledTimes(2);
    expect(f.service.createFollowUpWatch).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('watch updates clear explicit waits, use revision CAS, and complete the same card', async () => {
  const f = await setup();
  try {
    f.ctx.on('approval/request', async () => 'allowed-once');
    await f.execute({ ...args, waitReason: 'Missing logs', inputRequest: 'Upload the test logs' });
    const first = (await f.service.followUpPage({ subject })).rows[0];
    if (!first) throw new Error('Missing created watch');
    expect(first.condition.kind).toBe('waiting-input');
    const update = { ...args, action: 'update', cardId: first.id, expectedRevision: first.revision };
    expect(await f.execute(update)).toMatchObject({ isError: false, value: { kind: 'receipt' } });
    expect(await f.execute(update)).toMatchObject({ isError: false, value: { kind: 'rejected', code: 'stale' } });
    const second = (await f.service.followUpPage({ subject })).rows[0];
    if (!second) throw new Error('Missing updated watch');
    expect(second).toMatchObject({ id: first.id, condition: { kind: 'tracking' }, revision: first.revision + 1 });
    expect(await f.execute({ action: 'complete', cardId: second.id, expectedRevision: second.revision })).toMatchObject({ value: { kind: 'receipt' } });
    expect((await f.service.followUpPage({ subject })).rows).toMatchObject([{ id: first.id, state: 'closed' }]);
  } finally { await f.close(); }
});
