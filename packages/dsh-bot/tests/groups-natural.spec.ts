import { executeRootSetup } from '../src/host/groups/root-guard.js';
import { mkdir } from 'node:fs/promises';
import { need } from '../src/host/common/operations.js';
import { describe, expect, it, vi } from 'vitest';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { AgentOptions } from '@deepseek-ai/dsh-agent';
import { groupMemberModelSelectionsSchema, groupTurnSchema, groupRecordSchema, groupSetModelSchema } from '../src/shared/groups.js';
import { groupsSpec } from '../src/shared/groups-contract.js';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { withIntegrations, alpha, beta } from './integration-support.js';
import { Config } from '../lib/host/registry.js';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { groupKey, type GroupRecord } from '../src/shared/groups.js';
import { isOwnedGroupTool, getGroupWorkerBinding } from '../src/host/groups/worker-tool.js';
async function fixture(f: Parameters<Parameters<typeof withIntegrations>[0]>[0], groupRoundTimeoutMs = 1000) {
  const roots = new Map<string, AgentHandle>(); const persisted = new Map<string, AgentHandle>(); const sequence: string[] = [];
  const config = Config({ dataDir: f.root, seedExamples: false, groupRoundTimeoutMs });
  Object.assign(f.registry, { config, status: async () => [...f.bots.keys()].map(id => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })) });
  const workspaces = new Map<string, { id: string; path: string; sessionIds: SessionId[]; attachSession(id: SessionId): Promise<void> }>();
  const workspaceRegistry = { create: vi.fn(async (path: string) => {
    let workspace = workspaces.get(path);
    if (!workspace) { workspace = { id: `workspace-${workspaces.size}`, path, sessionIds: [], async attachSession(id: SessionId) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); } }; workspaces.set(path, workspace); }
    return workspace;
  }) };
  f.ctx.provide('workspaceRegistry', workspaceRegistry as never);
  Object.assign(f.registry, { ensureBotsWorkspace: async () => { const workspace = await workspaceRegistry.create(f.root); return { path: workspace.path, workspaceId: workspace.id }; } });
  f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'loopback' }) } as typeof f.ctx.agentDefaultModel);
  const resolveCallConfig = vi.fn(async (selection: { provider: string; model: string; reasoningEffort?: string }) => {
    if (selection.reasoningEffort && !['low', 'high'].includes(selection.reasoningEffort)) throw new Error('Unsupported effort');
    return selection;
  });
  f.ctx.provide('llm', { listProviders: () => ['synthetic', 'alternate'].map(id => ({ id, name: id })),
    listModels: async (provider: string) => [{ provider, id: provider === 'synthetic' ? 'loopback' : 'second', name: 'Fixture' }],
    resolveCallConfig } as unknown as typeof f.ctx.llm);
  f.ctx.provide('agentPresets', { register: vi.fn(() => async () => { sequence.push('preset-dispose'); }), mount: vi.fn(async () => {}) } as unknown as typeof f.ctx.agentPresets);
  const create = vi.fn(async ({ sessionId, meta }: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string } }) => {
    const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, ...meta });
    let activity = Promise.resolve();
    const agent = { id: sessionId, session, ctx: f.ctx, inbox: { nextTurn: [], nextStep: [] }, whenIdle: vi.fn(() => activity),
      followup: vi.fn((message: import('@deepseek-ai/dsh-llm').UserMessage) => {
        // Native lifecycle service double; real turn/blank/model behavior is verified by groups-workspace-profile.
        activity = (async () => {
          const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1;
          session.append('turn/start', { turn });
          try {
            expect(await executeRootSetup(agent, [message], turn)).toBe(true);
            session.append('turn/end', { turn, reason: { kind: 'completed' } });
          } catch { session.append('turn/end', { turn, reason: { kind: 'blocked' } }); }
        })();
        void activity.catch(() => {});
      }),
    } as unknown as Agent;
    const h = { agent, dispose: vi.fn(async () => { sequence.push('root-dispose'); roots.delete(sessionId); }) }; roots.set(sessionId, h); persisted.set(sessionId, h); return h;
  });
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => { const h = persisted.get(resumeSessionId); if (!h || roots.has(resumeSessionId)) throw new Error('ownership'); roots.set(resumeSessionId, h); return h; });
  f.ctx.provide('agents', { get: (id: string) => roots.get(id)?.agent, create, resume } as unknown as typeof f.ctx.agents);
  const flush = vi.fn(async () => true); f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  const rename = vi.fn(async ({ title }: { title: string }) => ({ title, renamed: true }));
  f.ctx.provide('sessionController', { rename } as unknown as typeof f.ctx.sessionController);
  const errors: unknown[] = [];
  let behavior: 'success' | 'hold' | 'partial' | 'throw' = 'success';
  const calls: { preset: string; prompt: string; signal: AbortSignal; route?: AgentOptions }[] = [];
  let onStart: ((input: { childId: SessionId; request: { parent: Agent; agentPreset: string; agentOptions?: AgentOptions; prompt: { text: string }[] } }, index: number) => Promise<SubagentResult>) | undefined;
  const start = vi.fn(async (input: { childId: SessionId; signal: AbortSignal; request: { parent: Agent; agentPreset: string; agentOptions?: AgentOptions; prompt: { text: string }[] } }) => {
    if (behavior === 'throw') throw new Error('sensitive-native-error');
    calls.push({ preset: input.request.agentPreset, prompt: input.request.prompt[0]?.text ?? '', signal: input.signal, route: input.request.agentOptions });
    let finish!: (r: SubagentResult) => void;
    const result = new Promise<SubagentResult>(r => { finish = r; });
    if (onStart) void onStart(input, calls.length).then(finish, error => { errors.push(error); finish(answer('fixture-error')); });
    else if (behavior !== 'hold') finish({ output: [{ type: 'text', text: `reply-${calls.length}` }], stopReason: behavior === 'partial' ? 'max-tokens' : 'completed' });
    return { childId: input.childId, result, dispose: vi.fn(async () => { sequence.push('child-dispose'); finish({ output: [], stopReason: 'aborted' }); }) };
  });
  f.ctx.provide('subagents', { getProvider: () => ({ inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true, depthLimit: true } }), startActivation: start } as unknown as typeof f.ctx.subagents);
  let domain = await f.ctx.storageDomain.open(groupsDomain); let groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start();
  const createGroup = (op = 'create-1', mode: 'natural' | 'mention' = 'natural') => groups.create({ operationId: op, name: 'Same name', members: [alpha, beta], mode, historyConfirmed: true });
  const settle = async (g: GroupRecord) => { await vi.waitFor(async () => expect((await groups.view(groupKey(g))).turns.every(t => !['running', 'accepted'].includes(t.state))).toBe(true)); expect(errors).toEqual([]); return groups.view(groupKey(g)); };
  return { get domain() { return domain; }, setOnStart(fn: NonNullable<typeof onStart>) { onStart = fn; }, get groups() { return groups; }, createGroup, settle, calls, resolveCallConfig, create, resume, flush, rename, roots, workspaces, sequence, start, setBehavior(b: typeof behavior) { behavior = b; },
    async seedUncertain(turnId: string) {
      const t = domain.table('turns').get(turnId); if (!t) throw new Error();
      await domain.table('turns').put(t.id,{...t,state:'running'});
      for (const [id,d] of domain.table('deliveries').entries()) if (d.turnId === turnId) await domain.table('deliveries').put(id,{...d,state:'running'});
    },
    async reopen() { await groups.close(); domain = await f.ctx.storageDomain.open(groupsDomain); groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start(); }, close: () => groups.close() };
}
const answer = (text: string): SubagentResult => ({ output: [{ type: 'text', text }], stopReason: 'completed' });
describe('natural groups — real ToolRuntime and persistent JSON, native activation double', () => {
  it('accepts plain text, routes replies exactly and rejects foreign references', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup();
      await s.groups.send(groupKey(g), { operationId: 'plain', text: 'Hello', expectedMembershipRevision: 1 });
      const v = await s.settle(g);
      expect(s.calls.map(c => c.preset)).toEqual(['bot-alpha', 'bot-beta']);
      const botMessage = need(v.messages.find(m => m.speaker?.bot.botId === 'alpha'));
      await s.groups.send(groupKey(g), { operationId: 'reply', text: 'Please expand', replyTo: botMessage.id, expectedMembershipRevision: 1 });
      await s.settle(g);
      expect(s.calls.at(-1)?.preset).toBe('bot-alpha');
      await expect(s.groups.send(groupKey(g), { operationId: 'bad-ref', text: 'x', replyTo: 'foreign', expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
    } finally { await s.close(); }
  }));
  it('A asks B through the registered tool, B replies, A resumes, without a user impersonation or deadlock', () => withIntegrations(async f => {
    const s = await fixture(f); const scopes: Array<{ dispose(): void }> = [];
    try {
      const g = await s.createGroup(), members = (await s.groups.view(groupKey(g))).members;
      const selected = { provider: 'alternate', model: 'second', reasoningEffort: 'high' };
      const memberSelected = { provider: 'synthetic', model: 'loopback', reasoningEffort: 'low' };
      await s.groups.setModel(groupKey(g), { expectedModelRevision: 0, modelSelection: selected });
      await s.groups.setModel(groupKey(g), { expectedModelRevision: 1, memberId: need(members[0]).id, modelSelection: memberSelected });
      s.setOnStart(async (input, index) => {
        const worker = f.createAgent(input.childId); scopes.push(worker.scope);
        worker.value.session = Session.create(input.childId, undefined, { version: 4, id: input.childId, createdAt: Date.now(), isSeeded: false,
          parentSession: input.request.parent.session.id, agentPreset: input.request.agentPreset });
        expect(getGroupWorkerBinding(worker.agent)?.audience).toEqual([alpha, beta]);
        expect(getGroupWorkerBinding(worker.agent)?.modelSelection).toEqual(index === 2 ? selected : memberSelected);
        await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', { agent: worker.agent, source: 'startup' });
        worker.agent.session.append('turn/start', { turn: 0 }); worker.agent.session.append('step/start', { turn: 0, step: 0 });
        expect(isOwnedGroupTool(worker.agent, 'group_message')).toBe(true);
        if (index === 1) {
          const dispatch = () => worker.agent.ctx.tools.execute({ agent: worker.agent, name: 'group_message', arguments: {
            action: 'send', to: need(members[1]).id, text: 'B, verify the number', requestReply: true }, callId: ToolCallId('ask-b'), signal: new AbortController().signal });
          const first = await dispatch(); expect(first.isError, JSON.stringify(first)).toBeFalsy();
          expect((await dispatch()).isError).toBeFalsy();
          const latest = (await s.groups.view(groupKey(g))).group;
          await s.groups.setModel(groupKey(g), { expectedModelRevision: latest.modelRevision ?? 0, modelSelection: null });
          await s.groups.setModel(groupKey(g), { expectedModelRevision: (latest.modelRevision ?? 0) + 1, memberId: need(members[0]).id, modelSelection: selected });
          return answer('Waiting for B');
        }
        if (index === 2) { expect(input.request.prompt[0]?.text).toContain('B, verify the number'); return answer('Verified: 42'); }
        expect(index).toBe(3); expect(input.request.prompt[0]?.text).toContain('Verified: 42');
        expect(JSON.parse(need(need(input.request.prompt[0]).text.split('\n').at(-1))).questionSource.authorKind).toBe('bot');
        return answer('Using B result: 42');
      });
      await s.groups.send(groupKey(g), { operationId: 'ask', text: 'Check this', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      const v = await s.settle(g);
      expect(s.calls.map(c => c.preset)).toEqual(['bot-alpha', 'bot-beta', 'bot-alpha']);
      expect(s.calls.map(call => call.route)).toEqual([memberSelected, selected, memberSelected]);
      expect(v.turns[0]?.memberModelSelections).toEqual([{ memberId: need(members[0]).id, modelSelection: memberSelected }]);
      expect(v.messages.filter(m => m.text === 'B, verify the number')).toHaveLength(1);
      expect(v.messages.filter(m => m.authorKind === 'user')).toHaveLength(1);
      expect(v.messages.at(-1)?.speaker?.bot).toEqual(alpha);
      expect(v.turns[0]?.state).toBe('completed');
    } finally { await s.close(); for (const scope of scopes) scope.dispose(); }
  }));
  it('queued input sees predecessor output, while the predecessor cannot see future queued input', () => withIntegrations(async f => {
    const s = await fixture(f); let resolve!: (v: SubagentResult) => void;
    try {
      const g = await s.createGroup('legacy-queue', 'mention'), members = (await s.groups.view(groupKey(g))).members;
      s.setOnStart(async (_input, index) => index === 1 ? new Promise<SubagentResult>(r => { resolve = r; }) : answer('second'));
      await s.groups.send(groupKey(g), { operationId: 'first', text: 'first', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      await s.groups.send(groupKey(g), { operationId: 'second', text: 'future-secret', memberIds: [need(members[1]).id], expectedMembershipRevision: 1 });
      resolve(answer('late predecessor answer'));
      await s.settle(g);
      expect(s.calls[0]?.prompt).not.toContain('future-secret');
      expect(s.calls[1]?.prompt).toContain('late predecessor answer');
    } finally { await s.close(); }
  }));
});
describe('natural group safety and bounded continuation', () => {
  it('explicit skip accepts an empty completed result without a fabricated message', () => withIntegrations(async f => {
    const s = await fixture(f); const scopes: Array<{ dispose(): void }> = [];
    try {
      const g = await s.createGroup();
      s.setOnStart(async input => {
        const worker = f.createAgent(input.childId); scopes.push(worker.scope);
        worker.value.session = Session.create(input.childId, undefined, { version: 4, id: input.childId, createdAt: Date.now(), isSeeded: false,
          parentSession: input.request.parent.session.id, agentPreset: input.request.agentPreset });
        await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', { agent: worker.agent, source: 'startup' });
        const result = await worker.agent.ctx.tools.execute({ agent: worker.agent, name: 'group_message',
          arguments: { action: 'skip' }, callId: ToolCallId('skip'), signal: new AbortController().signal });
        expect(result.isError, JSON.stringify(result)).toBeFalsy();
        return { output: [], stopReason: 'completed' };
      });
      await s.groups.send(groupKey(g), { operationId: 'skip', text: 'optional question', expectedMembershipRevision: 1 });
      const v = await s.settle(g);
      expect(v.turns[0]?.state).toBe('completed'); expect(v.deliveries.map(d => d.state)).toEqual(['skipped', 'skipped']);
      expect(v.messages.map(m => m.text)).toEqual(['optional question']);
    } finally { await s.close(); for (const scope of scopes) scope.dispose(); }
  }));
  it('limits recursive requests, rejects nonmembers and removes owned-tool capability after completion', () => withIntegrations(async f => {
    const s = await fixture(f); const workers: ReturnType<typeof f.createAgent>[] = [];
    f.registry.config.groupMaxContinuations = 2;
    try {
      const g = await s.createGroup(), members = (await s.groups.view(groupKey(g))).members;
      s.setOnStart(async (input, index) => {
        const worker = f.createAgent(input.childId); workers.push(worker);
        worker.value.session = Session.create(input.childId, undefined, { version: 4, id: input.childId, createdAt: Date.now(), isSeeded: false,
          parentSession: input.request.parent.session.id, agentPreset: input.request.agentPreset });
        await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', { agent: worker.agent, source: 'startup' });
        const send = (to: string, call: string) => worker.agent.ctx.tools.execute({ agent: worker.agent, name: 'group_message',
          arguments: { action: 'send', to, text: 'question', requestReply: true }, callId: ToolCallId(call), signal: new AbortController().signal });
        expect((await send('foreign-member', 'foreign')).isError).toBe(true);
        const next = await send(need(members.find(m => `bot-${m.bot.botId}` !== input.request.agentPreset)).id, 'next');
        expect(Boolean(next.isError), JSON.stringify({ index, next })).toBe(index === 3);
        return answer(`answer-${index}`);
      });
      await s.groups.send(groupKey(g), { operationId: 'bounded', text: 'start', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await s.settle(g); expect(s.calls).toHaveLength(3);
      expect(workers.every(w => !isOwnedGroupTool(w.agent, 'group_message'))).toBe(true);
    } finally { await s.close(); for (const worker of workers) worker.scope.dispose(); }
  }));
  it('stop cancels a durable pending handoff and a late result cannot revive it', () => withIntegrations(async f => {
    const s = await fixture(f); const workers: ReturnType<typeof f.createAgent>[] = [];
    let sent = false;
    try {
      const g = await s.createGroup(), members = (await s.groups.view(groupKey(g))).members;
      s.setOnStart(async input => {
        const worker = f.createAgent(input.childId); workers.push(worker);
        worker.value.session = Session.create(input.childId, undefined, { version: 4, id: input.childId, createdAt: Date.now(), isSeeded: false,
          parentSession: input.request.parent.session.id, agentPreset: input.request.agentPreset });
        await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', { agent: worker.agent, source: 'startup' });
        const result = await worker.agent.ctx.tools.execute({ agent: worker.agent, name: 'group_message',
          arguments: { action: 'send', to: need(members[1]).id, text: 'please answer', requestReply: true }, callId: ToolCallId('ask'), signal: new AbortController().signal });
        expect(result.isError, JSON.stringify(result)).toBeFalsy(); sent = true;
        return new Promise<SubagentResult>(() => {});
      });
      await s.groups.send(groupKey(g), { operationId: 'stop', text: 'start', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(sent).toBe(true));
      const turn = need((await s.groups.view(groupKey(g))).turns[0]);
      await s.groups.cancel(groupKey(g), turn.id, turn.revision);
      const v = await s.settle(g); expect(v.turns[0]?.state).toBe('cancelled'); expect(s.calls).toHaveLength(1);
      expect(v.deliveries.every(d => d.state === 'cancelled')).toBe(true);
    } finally { await s.close(); for (const worker of workers) worker.scope.dispose(); }
  }));
});
describe('native group attachment references', () => {
  it('preserves actual native file/image blocks into the group and the next/reply worker', () => withIntegrations(async f => {
    const s = await fixture(f);
    const attachments = [
      { type: 'file' as const, attachment: { attachmentId: 'a'.repeat(64), name: 'result.pdf', bytes: 42 } },
      { type: 'image' as const, attachment: { attachmentId: 'b'.repeat(64), mediaType: 'image/png' as const, width: 1, height: 1, bytes: 68, name: 'chart.png' } },
    ];
    const prompts: unknown[][] = [];
    try {
      const g = await s.createGroup();
      s.setOnStart(async (input, index) => {
        prompts.push(input.request.prompt);
        return index === 1 ? { output: attachments as unknown as SubagentResult['output'], stopReason: 'completed' } : answer('Read referenced artifacts');
      });
      await s.groups.send(groupKey(g), { operationId: 'artifacts', text: 'Create artifacts', expectedMembershipRevision: 1 });
      const v = await s.settle(g), result = need(v.messages.find(m => m.speaker?.bot.botId === 'alpha'));
      expect(result.attachments).toEqual(attachments);
      expect(prompts[1]?.slice(1)).toEqual(attachments);
      await s.groups.send(groupKey(g), { operationId: 'artifact-reply', text: 'Use these', replyTo: result.id, expectedMembershipRevision: 1 });
      await s.settle(g); expect(prompts[2]?.slice(1)).toEqual(attachments);
      const native = need(s.roots.get(g.rootSessionId)).agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === result.id);
      expect(native?.type === 'user/message' ? native.data.content : undefined).toEqual(attachments);
    } finally { await s.close(); }
  }));
  it('accepts only the exact root-scoped uploaded file receipt and keeps file-only input', () => withIntegrations(async f => {
    const s = await fixture(f); const bindingDispose = vi.fn(), commit = vi.fn();
    const file = { attachmentId: 'c'.repeat(64), name: 'input.txt', bytes: 9 };
    try {
      const g = await s.createGroup();
      const resolve = vi.fn((agent: Agent, receipt: string) => agent.session.id === g.rootSessionId && receipt === 'staged-root' ? file : undefined);
      const bindPrompt = vi.fn(() => ({ commit, [Symbol.dispose]: bindingDispose }));
      f.ctx.provide('fileUploads', { resolve, bindPrompt } as never);
      await expect(s.groups.send(groupKey(g), { operationId: 'foreign-receipt', text: '', fileReceiptIds: ['other-session'], expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      expect(s.start).not.toHaveBeenCalled();
      s.setOnStart(async input => { expect(input.request.prompt.slice(1)).toEqual([{ type: 'file', attachment: file }]); return answer('read input'); });
      await s.groups.send(groupKey(g), { operationId: 'file-input', text: '', fileReceiptIds: ['staged-root'], expectedMembershipRevision: 1 });
      const v = await s.settle(g);
      const nativeInput = need(s.roots.get(g.rootSessionId)).agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === v.messages[0]?.id);
      expect(nativeInput?.type === 'user/message' ? nativeInput.data.source : undefined).toMatchObject({kind:'user',group:groupKey(g)});
      expect(v.messages[0]?.text).toBe(''); expect(v.messages[0]?.attachments).toEqual([{ type: 'file', attachment: file }]);
      expect(bindPrompt).toHaveBeenCalledTimes(1); expect(commit).toHaveBeenCalledTimes(1); expect(bindingDispose).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }));
});
describe('group attachment native opener bridge', () => {
  it('opens only a ref from the exact group message and reports unavailable providers', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), file = { attachmentId: 'd'.repeat(64), name: 'native-output.txt', bytes: 5 };
      s.setOnStart(async () => ({ output: [{ type: 'file', attachment: file }] as unknown as SubagentResult['output'], stopReason: 'completed' }));
      await s.groups.send(groupKey(g), { operationId: 'open-output', text: 'output', expectedMembershipRevision: 1 });
      const v = await s.settle(g), message = need(v.messages.find(m => m.attachments?.length));
      await expect(s.groups.openAttachment(groupKey(g), message.id, file.attachmentId)).rejects.toMatchObject({ code: 'dsh-bot/unsupported' });
      const fileHostPath = vi.fn(() => '/provider-owned/native-output.txt'), openWorkspacePath = vi.fn(async () => ({ opened: true as const }));
      f.ctx.provide('attachments', { fileHostPath } as never);
      Object.assign(need(f.ctx.get('sessionController')), { workspaceDesktop: () => ({ available: true }), openWorkspacePath });
      await expect(s.groups.openAttachment(groupKey(g), message.id, 'forged-file')).rejects.toMatchObject({ code: 'dsh-bot/not-found' });
      await expect(s.groups.openAttachment(groupKey(g), 'foreign-message', file.attachmentId)).rejects.toMatchObject({ code: 'dsh-bot/not-found' });
      expect(openWorkspacePath).not.toHaveBeenCalled();
      expect(await s.groups.openAttachment(groupKey(g), message.id, file.attachmentId)).toEqual({ opened: true });
      expect(fileHostPath).toHaveBeenCalledWith(file); expect(openWorkspacePath).toHaveBeenCalledWith({ path: '/provider-owned/native-output.txt' }, expect.any(AbortSignal));
      fileHostPath.mockReturnValueOnce(undefined as unknown as string);
      await expect(s.groups.openAttachment(groupKey(g), message.id, file.attachmentId)).rejects.toMatchObject({ code: 'dsh-bot/unsupported' });
    } finally { await s.close(); }
  }));
});

describe('native workspace root opening and ownership', () => {
  it('attaches new roots to the Bots workspace and serializes concurrent open/send without a new root', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); expect(g.cwd).toBe(f.root);
      const workspace = need(s.workspaces.get(f.root)); expect(workspace.sessionIds).toContain(g.rootSessionId);
      const [opened, again] = await Promise.all([s.groups.open(groupKey(g)), s.groups.open(groupKey(g)),
        s.groups.send(groupKey(g), { operationId: 'open-send', text: 'workspace question', expectedMembershipRevision: 1 })]);
      expect(opened).toEqual({ sessionId: g.rootSessionId, workspaceId: workspace.id }); expect(again).toEqual(opened);
      expect(workspace.sessionIds.filter(id => id === g.rootSessionId)).toHaveLength(1);
      expect(s.create).toHaveBeenCalledTimes(1); await s.settle(g);
    } finally { await s.close(); }
  }));
  it('borrows an exact Controller-restored root, sends through it, and never disposes it at plugin shutdown', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); await s.close();
      const controllerRoot = await s.resume({ resumeSessionId: g.rootSessionId });
      const borrowedDisposer = vi.spyOn(controllerRoot, 'dispose'), before = borrowedDisposer.mock.calls.length;
      await s.reopen(); expect(s.groups.lifecycle().ownedRoots).toBe(0);
      expect((await s.groups.open(groupKey(g))).sessionId).toBe(g.rootSessionId);
      await s.groups.send(groupKey(g), { operationId: 'borrowed', text: 'borrowed root question', expectedMembershipRevision: 1 }); await s.settle(g);
      await s.close(); expect(controllerRoot.dispose).toHaveBeenCalledTimes(before);
      expect(s.roots.get(g.rootSessionId)?.agent).toBe(controllerRoot.agent);
      await controllerRoot.dispose();
    } finally { await s.close(); }
  }));
  it('keeps legacy cwd when opening and rejects an unrelated live Agent without disposing it', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const cwd = `${f.root}/legacy-group`; await mkdir(cwd);
      const g = await s.groups.create({ operationId: 'legacy', name: 'Legacy group', members: [alpha, beta], mode: 'mention', historyConfirmed: true, cwd });
      const opened = await s.groups.open(groupKey(g)); expect(need(s.workspaces.get(cwd)).id).toBe(opened.workspaceId);
      expect((await s.groups.view(groupKey(g))).group.cwd).toBe(cwd);
      await s.close();
      const foreignId = g.rootSessionId as SessionId;
      const agent = { id: foreignId, session: Session.create(foreignId, undefined, { version: 4, id: foreignId, createdAt: Date.now(), isSeeded: false, agentPreset: 'dsh-bot-group-root', cwd: f.root }) } as Agent;
      const dispose = vi.fn(async () => {}); s.roots.set(foreignId, { agent, dispose }); await s.reopen();
      await expect(s.groups.open(groupKey(g))).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      expect((await s.groups.view(groupKey(g))).reason).toBe('root-owned-elsewhere'); expect(dispose).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }));
});

describe('root title persistence failure ownership cleanup', () => {
  it.each(['rename', 'flush'] as const)('releases a resumed owned root on %s failure and really retries persistence on the next open', failure => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); await s.close();
      if (failure === 'rename') s.rename.mockRejectedValueOnce(new Error('Synthetic rename failure'));
      else s.flush.mockResolvedValueOnce(false);
      await s.reopen();
      expect(s.roots.has(g.rootSessionId)).toBe(false); expect(s.groups.lifecycle().ownedRoots).toBe(0);
      const attempts = s.rename.mock.calls.length;
      expect((await s.groups.open(groupKey(g))).sessionId).toBe(g.rootSessionId);
      expect(s.rename.mock.calls.length).toBeGreaterThan(attempts); expect(s.resume).toHaveBeenCalledTimes(2);
      expect(s.groups.lifecycle().ownedRoots).toBe(1);
    } finally { await s.close(); }
  }));
  it('retains a failed owned disposer for shutdown and does not clear its persistence error without retrying', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); await s.close(); const resume = need(s.resume.getMockImplementation());
      s.resume.mockImplementationOnce(async input => { const handle = await resume(input); vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('Synthetic teardown failure')); return handle; });
      s.rename.mockRejectedValueOnce(new Error('Synthetic rename failure'));
      await s.reopen(); expect(s.groups.lifecycle().ownedRoots).toBe(1);
      const attempts = s.rename.mock.calls.length;
      await s.groups.open(groupKey(g)); expect(s.rename.mock.calls.length).toBeGreaterThan(attempts);
      expect(s.resume).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }));
  it('forgets a failed borrowed reference without disposing Controller ownership and retries the title on open', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); await s.close();
      const controllerRoot = await s.resume({ resumeSessionId: g.rootSessionId }), disposer = vi.spyOn(controllerRoot, 'dispose');
      const before = disposer.mock.calls.length; s.rename.mockRejectedValueOnce(new Error('Synthetic borrowed rename failure'));
      await s.reopen(); expect(s.groups.lifecycle().ownedRoots).toBe(0); expect(disposer).toHaveBeenCalledTimes(before);
      expect(s.roots.get(g.rootSessionId)?.agent).toBe(controllerRoot.agent);
      const attempts = s.rename.mock.calls.length;
      await s.groups.open(groupKey(g)); expect(s.rename.mock.calls.length).toBeGreaterThan(attempts);
      await s.close(); expect(disposer).toHaveBeenCalledTimes(before); await controllerRoot.dispose();
    } finally { await s.close(); }
  }));
  it('cleans a borrowed reference after a Controller acquisition race followed by rename failure', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(); await s.close();
      const resume = need(s.resume.getMockImplementation());
      s.resume.mockImplementationOnce(async input => { await resume(input); throw new Error('Controller won restore race'); });
      s.rename.mockRejectedValueOnce(new Error('Synthetic raced rename failure'));
      await s.reopen(); const controllerRoot = need(s.roots.get(g.rootSessionId));
      const disposer = vi.spyOn(controllerRoot, 'dispose'), before = disposer.mock.calls.length, attempts = s.rename.mock.calls.length;
      await s.groups.open(groupKey(g)); expect(s.rename.mock.calls.length).toBeGreaterThan(attempts);
      expect(s.groups.lifecycle().ownedRoots).toBe(0);
      await s.close(); expect(disposer).toHaveBeenCalledTimes(before); await controllerRoot.dispose();
    } finally { await s.close(); }
  }));
});


describe('bounded independent natural work and exact supplements', () => {
  it('runs two independent turns, queues a third, supplements exactly once and cancels only the selected chain', () => withIntegrations(async f => {
    // This asserts targeted cancellation, not deadline expiry. Full-suite JSON I/O can exceed one second.
    const s = await fixture(f, 30_000); const prompt = vi.fn(async () => ({ messageId: 'native-followup' }));
    Object.assign(f.ctx.subagents, { prompt });
    try {
      s.setBehavior('hold'); const g = await s.createGroup(), key = groupKey(g), members = (await s.groups.view(key)).members;
      const originalRoute = { provider: 'alternate', model: 'second', reasoningEffort: 'high' };
      await s.groups.setModel(key, { expectedModelRevision: 0, memberId: need(members[1]).id, modelSelection: originalRoute });
      const first = await s.groups.send(key, {operationId:'parallel-a',text:'WORK_A',memberIds:[need(members[0]).id],expectedMembershipRevision:1});
      const second = await s.groups.send(key, {operationId:'parallel-b',text:'WORK_B',memberIds:[need(members[1]).id],expectedMembershipRevision:1});
      await vi.waitFor(() => expect(s.calls).toHaveLength(2));
      const third = await s.groups.send(key, {operationId:'parallel-c',text:'FUTURE_C',memberIds:[need(members[0]).id],expectedMembershipRevision:1});
      expect(s.calls).toHaveLength(2); expect(s.calls.every(c=>!c.prompt.includes('FUTURE_C'))).toBe(true);
      const v = await s.groups.view(key), d = need(v.deliveries.find(d=>d.turnId===second.id));
      await s.groups.setModel(key, { expectedModelRevision: 1, memberId: need(members[1]).id, modelSelection: { provider: 'synthetic', model: 'loopback', reasoningEffort: 'low' } });
      const input = {operationId:'supplement-b',text:'EXACT_B',expectedMembershipRevision:1,followup:{turnId:second.id,deliveryId:d.id}};
      const accepted = await s.groups.send(key,input); expect(accepted.followups?.[0]?.state).toBe('accepted');
      expect(s.calls).toHaveLength(2); expect(s.calls[1]?.route).toEqual(originalRoute); expect(s.calls[1]?.signal.aborted).toBe(false);
      expect(accepted.memberModelSelections).toEqual(second.memberModelSelections);
      await s.groups.send(key,input); expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith(expect.objectContaining({childSessionId:d.childSessionId,delivery:'steer',content:[{type:'text',text:'EXACT_B'}]}),expect.any(AbortSignal));
      expect((await s.groups.view(key)).messages.filter(m=>m.text==='EXACT_B')).toHaveLength(1);
      await expect(s.groups.send(key,{...input,text:'changed'})).rejects.toMatchObject({code:'dsh-bot/conflict'});
      await expect(s.groups.send(key,{...input,operationId:'wrong-target',followup:{turnId:first.id,deliveryId:d.id}})).rejects.toMatchObject({code:'dsh-bot/unavailable'});
      await s.groups.cancel(key, second.id, need((await s.groups.view(key)).turns.find(t=>t.id===second.id)).revision);
      await vi.waitFor(()=>expect(s.calls).toHaveLength(3));
      expect(s.calls[0]?.signal.aborted).toBe(false); expect(s.calls[2]?.prompt).toContain('FUTURE_C');
      for(const id of [first.id,third.id]) await s.groups.cancel(key,id,need((await s.groups.view(key)).turns.find(t=>t.id===id)).revision);
      await s.settle(g);
    } finally {await s.close();}
  }));
  it('persists an unknown prompt outcome and never repeats it on retry or cold reopen', () => withIntegrations(async f => {
    const s=await fixture(f);const prompt=vi.fn(async()=>{throw new Error('unknown native acceptance');});Object.assign(f.ctx.subagents,{prompt});
    try {
      s.setBehavior('hold');const g=await s.createGroup(),key=groupKey(g),members=(await s.groups.view(key)).members;
      const t=await s.groups.send(key,{operationId:'unknown-turn',text:'start',memberIds:[need(members[0]).id],expectedMembershipRevision:1});
      await vi.waitFor(()=>expect(s.calls).toHaveLength(1));const d=need((await s.groups.view(key)).deliveries[0]);
      const input={operationId:'unknown-supplement',text:'supplement',expectedMembershipRevision:1,followup:{turnId:t.id,deliveryId:d.id}};
      await expect(s.groups.send(key,input)).rejects.toMatchObject({code:'dsh-bot/recovery-needed'});
      await expect(s.groups.send(key,input)).rejects.toMatchObject({code:'dsh-bot/recovery-needed'});expect(prompt).toHaveBeenCalledTimes(1);
      await s.reopen();await expect(s.groups.send(key,input)).rejects.toMatchObject({code:'dsh-bot/recovery-needed'});expect(prompt).toHaveBeenCalledTimes(1);
    } finally {await s.close();}
  }));
});


describe('supplement admission closes independently of result persistence', () => {
  it.each(['validation', 'flush', 'native-lock'] as const)('does not accept a supplement when result settles during %s', phase => withIntegrations(async f => {
    const s = await fixture(f);
    let release!: () => void, reached!: () => void, complete!: (result: SubagentResult) => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    let nativeSignal: AbortSignal | undefined;
    const prompt = vi.fn(async (_request: unknown, signal: AbortSignal) => {
      nativeSignal = signal;
      if (phase === 'native-lock') { reached(); await held; }
      signal.throwIfAborted();
      return { messageId: 'must-not-be-accepted' };
    });
    Object.assign(f.ctx.subagents, { prompt });
    try {
      s.setOnStart(() => new Promise<SubagentResult>(resolve => { complete = resolve; }));
      const g = await s.createGroup(), key = groupKey(g), members = (await s.groups.view(key)).members;
      const turn = await s.groups.send(key, { operationId: `race-${phase}`, text: 'original work', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const delivery = need((await s.groups.view(key)).deliveries[0]);
      if (phase === 'validation') {
        const status = f.registry.status.bind(f.registry);
        vi.spyOn(f.registry, 'status').mockImplementationOnce(async () => { reached(); await held; return status(); });
      } else if (phase === 'flush') {
        s.flush.mockImplementationOnce(async () => { reached(); await held; return true; });
      }
      const input = { operationId: `late-${phase}`, text: 'late supplement', expectedMembershipRevision: 1, followup: { turnId: turn.id, deliveryId: delivery.id } };
      // Attach the rejection handler before opening either barrier.
      const pending = s.groups.send(key, input).then(value => ({ value }), error => ({ error }));
      await entered;
      complete(answer('original work completed'));
      // Drain native-result microtasks while the public validation/flush/lock remains held.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(s.calls[0]?.signal.aborted).toBe(false);
      if (phase === 'native-lock') expect(nativeSignal?.aborted).toBe(true);
      release();
      expect(await pending).toMatchObject({ error: { code: phase === 'validation' ? 'dsh-bot/unavailable' : 'dsh-bot/recovery-needed' } });
      const view = await s.settle(g), current = need(view.turns.find(t => t.id === turn.id));
      expect(current.state).toBe('completed');
      expect(view.deliveries[0]?.state).toBe('completed');
      expect(view.messages.some(m => m.text === 'original work completed')).toBe(true);
      expect(current.followups?.find(row => row.operationId === input.operationId)?.state).toBe(phase === 'validation' ? undefined : 'unknown');
      expect(prompt).toHaveBeenCalledTimes(phase === 'native-lock' ? 1 : 0);
      await expect(s.groups.send(key, input)).rejects.toMatchObject({ code: phase === 'validation' ? 'dsh-bot/unavailable' : 'dsh-bot/recovery-needed' });
      expect(prompt).toHaveBeenCalledTimes(phase === 'native-lock' ? 1 : 0);
    } finally { release(); await s.close(); }
  }));
});

describe('group-local model selection and admission snapshots', () => {
  it('uses a strict CAS API, persists model CAS separately from group progress revisions, and rejects invalid routes', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g);
      expect(groupSetModelSchema.safeParse({ expectedRevision: 1, modelSelection: null }).success).toBe(false);
      expect(groupSetModelSchema.safeParse({ expectedModelRevision: -1, modelSelection: null }).success).toBe(false);
      expect(groupSetModelSchema.safeParse({ expectedModelRevision: 0, modelSelection: null, global: true }).success).toBe(false);
      expect(groupSetModelSchema.safeParse({ expectedModelRevision: 0, modelSelection: { provider: 'alternate', model: 'second', secret: 'x' } }).success).toBe(false);
      expect(groupsSpec.methods['dshBot.groups/setModel'].parameters[1].codec.decode({ expectedModelRevision: 0, modelSelection: null })).toEqual({ expectedModelRevision: 0, modelSelection: null });
      await expect(s.groups.setModel(key, { expectedModelRevision: 2, modelSelection: null })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: { provider: 'missing', model: 'x' } })).rejects.toMatchObject({ code: 'dsh-bot/unavailable' });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: { provider: 'alternate', model: 'missing' } })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: { provider: 'alternate', model: 'second', reasoningEffort: 'invalid' } })).rejects.toMatchObject({ code: 'dsh-bot/unavailable' });
      const selection = { provider: 'alternate', model: 'second', reasoningEffort: 'high' };
      const changed = await s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: selection });
      expect(changed).toMatchObject({ modelSelection: selection, revision: 2, modelRevision: 1, membershipRevision: 1 });
      expect(s.calls).toHaveLength(0);
      expect(f.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'synthetic', model: 'loopback' });
      await s.reopen();
      expect((await s.groups.view(key)).group.modelSelection).toEqual(selection);
      const cleared = await s.groups.setModel(key, { expectedModelRevision: 1, modelSelection: null });
      expect(cleared).toMatchObject({ revision: 3, modelRevision: 2, membershipRevision: 1 });
      expect(Object.hasOwn(cleared, 'modelSelection')).toBe(false);
    } finally { await s.close(); }
  }));
  it('treats legacy records without modelRevision as zero across cold reopen and background completion', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g);
      expect(Object.hasOwn(g, 'modelRevision')).toBe(false);
      await s.groups.send(key, { operationId: 'legacy-background', text: 'complete first', expectedMembershipRevision: 1 });
      const completed = (await s.settle(g)).group;
      expect(completed.revision).toBeGreaterThan(g.revision);
      expect(Object.hasOwn(completed, 'modelRevision')).toBe(false);
      await s.reopen();
      expect(Object.hasOwn((await s.groups.view(key)).group, 'modelRevision')).toBe(false);
      const selected = await s.groups.setModel(key, { expectedModelRevision: g.modelRevision ?? 0,
        modelSelection: { provider: 'alternate', model: 'second' } });
      expect(selected.modelRevision).toBe(1);
      expect(selected.revision).toBe(completed.revision + 1);
    } finally { await s.close(); }
  }));
  it('ignores background group revisions but strictly rejects concurrent model choices and ABA', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g);
      const a = { provider: 'alternate', model: 'second' }, b = { provider: 'synthetic', model: 'loopback' };
      const initial = await s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: a });
      await s.groups.send(key, { operationId: 'model-background', text: 'complete first', expectedMembershipRevision: 1 });
      const completed = (await s.settle(g)).group;
      expect(completed.revision).toBeGreaterThan(initial.revision);
      expect(completed.modelRevision).toBe(initial.modelRevision);
      const cleared = await s.groups.setModel(key, { expectedModelRevision: initial.modelRevision, modelSelection: null });
      expect(cleared.modelRevision).toBe(2);
      const raced = await Promise.allSettled([
        s.groups.setModel(key, { expectedModelRevision: 2, modelSelection: a }),
        s.groups.setModel(key, { expectedModelRevision: 2, modelSelection: b }),
      ]);
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(raced.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'dsh-bot/conflict' } });
      const winner = (await s.groups.view(key)).group;
      expect(winner.modelRevision).toBe(3);
      const other = winner.modelSelection?.provider === a.provider ? b : a;
      const changed = await s.groups.setModel(key, { expectedModelRevision: 3, modelSelection: other });
      const restored = await s.groups.setModel(key, { expectedModelRevision: changed.modelRevision, modelSelection: winner.modelSelection });
      expect(restored.modelSelection).toEqual(winner.modelSelection);
      expect(restored.modelRevision).toBe(5);
      await expect(s.groups.setModel(key, { expectedModelRevision: winner.modelRevision, modelSelection: null })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      expect((await s.groups.view(key)).group).toEqual(restored);
    } finally { await s.close(); }
  }));
  it('keeps admitted and queued work on its snapshot while later work uses the changed override', () => withIntegrations(async f => {
    const s = await fixture(f);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const g = await s.createGroup('snapshot', 'mention'), key = groupKey(g);
      const selection = { provider: 'alternate', model: 'second', reasoningEffort: 'high' };
      await s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: selection });
      s.setOnStart(async (_input, index) => { if (index === 1) await gate; return answer('model fixture'); });
      const first = await s.groups.send(key, { operationId: 'active-model', text: 'first', round: true, expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const queued = await s.groups.send(key, { operationId: 'queued-model', text: 'queued', round: true, expectedMembershipRevision: 1 });
      expect(first.modelSelection).toEqual(selection); expect(queued.modelSelection).toEqual(selection);
      const latest = (await s.groups.view(key)).group;
      await s.groups.setModel(key, { expectedModelRevision: latest.modelRevision ?? 0, modelSelection: { provider: 'synthetic', model: 'loopback' } });
      expect(s.calls[0]?.signal.aborted).toBe(false);
      release(); await s.settle(g);
      expect(s.calls).toHaveLength(4);
      expect(s.calls.every(call => JSON.stringify(call.route) === JSON.stringify(selection))).toBe(true);
      const next = await s.groups.send(key, { operationId: 'new-model', text: 'new', round: true, expectedMembershipRevision: 1 });
      await s.settle(g);
      expect(next.modelSelection).toEqual({ provider: 'synthetic', model: 'loopback' });
      expect(s.calls.at(-1)?.route).toEqual({ provider: 'synthetic', model: 'loopback', reasoningEffort: undefined });
      expect(Object.hasOwn(s.calls.at(-1)?.route ?? {}, 'reasoningEffort')).toBe(true);
    } finally { release?.(); await s.close(); }
  }));
});


describe('per-member group model overrides', () => {
  const a = { provider: 'alternate', model: 'second', reasoningEffort: 'high' };
  const b = { provider: 'synthetic', model: 'loopback', reasoningEffort: 'low' };
  it('strictly bounds unique member IDs and roundtrips the public record, turn and request codecs', () => {
    const row = { memberId: 'member-a', modelSelection: a };
    expect(groupMemberModelSelectionsSchema.parse([row])).toEqual([row]);
    for (const rows of [[row, row], [{ ...row, botId: 'alpha' }], [{ ...row, modelSelection: { ...a, secret: 'x' } }],
      Array.from({ length: 17 }, (_, index) => ({ ...row, memberId: `member-${index}` }))])
      expect(groupMemberModelSelectionsSchema.safeParse(rows).success).toBe(false);
    expect(groupSetModelSchema.safeParse({ expectedModelRevision: 0, memberId: '', modelSelection: null }).success).toBe(false);
    const method = groupsSpec.methods['dshBot.groups/setModel'];
    const input = { expectedModelRevision: 0, memberId: row.memberId, modelSelection: a };
    const decoded = method.parameters[1].codec.decode(input);
    expect(method.parameters[1].strictCodec.decode(method.parameters[1].strictCodec.encode(decoded))).toEqual(input);
    expect(groupRecordSchema.shape.memberModelSelections.safeParse([row, row]).success).toBe(false);
    expect(groupTurnSchema.shape.memberModelSelections.safeParse([row, row]).success).toBe(false);
  });
  it('gives stable member IDs independent models and efforts above group, Bot and DSH defaults without mutating them', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      for (const [id, bot] of f.bots) f.bots.set(id, { ...bot, name: 'Identical name', model: b });
      const botsBefore = structuredClone([...f.bots]), g = await s.createGroup(), key = groupKey(g);
      const members = (await s.groups.view(key)).members;
      const alphaId = need(members[0]).id, betaId = need(members[1]).id;
      await s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: a });
      await s.groups.setModel(key, { expectedModelRevision: 1, memberId: alphaId, modelSelection: b });
      await s.groups.send(key, { operationId: 'priority-group', text: 'same names', expectedMembershipRevision: 1 });
      await s.settle(g);
      expect(s.calls.map(call => call.route)).toEqual([b, a]);
      const changed = await s.groups.setModel(key, { expectedModelRevision: 2, memberId: betaId, modelSelection: a });
      expect(changed.memberModelSelections).toEqual([{ memberId: alphaId, modelSelection: b }, { memberId: betaId, modelSelection: a }]);
      const clearedDefault = await s.groups.setModel(key, { expectedModelRevision: 3, modelSelection: null });
      expect(clearedDefault.modelSelection).toBeUndefined(); expect(clearedDefault.memberModelSelections).toEqual(changed.memberModelSelections);
      const clearedMember = await s.groups.setModel(key, { expectedModelRevision: 4, memberId: alphaId, modelSelection: null });
      expect(clearedMember.memberModelSelections).toEqual([{ memberId: betaId, modelSelection: a }]);
      await s.groups.send(key, { operationId: 'priority-bot', text: 'Bot fallback', expectedMembershipRevision: 1 }); await s.settle(g);
      expect(s.calls.slice(-2).map(call => call.route)).toEqual([b, a]);
      const bot = need(f.bots.get('alpha')); const { model: _model, ...withoutModel } = bot; f.bots.set('alpha', withoutModel);
      await s.groups.send(key, { operationId: 'priority-dsh', text: 'DSH fallback', expectedMembershipRevision: 1 }); await s.settle(g);
      expect(s.calls.at(-2)?.route).toEqual({ provider: 'synthetic', model: 'loopback' });
      f.bots.set('alpha', bot);
      expect([...f.bots]).toEqual(botsBefore);
      expect(f.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'synthetic', model: 'loopback' });
      await s.reopen(); expect((await s.groups.view(key)).group.memberModelSelections).toEqual(clearedMember.memberModelSelections);
      await s.groups.setModel(key, { expectedModelRevision: 5, modelSelection: b });
      const lastCleared = await s.groups.setModel(key, { expectedModelRevision: 6, memberId: betaId, modelSelection: null });
      expect(lastCleared.modelSelection).toEqual(b); expect(lastCleared.memberModelSelections).toBeUndefined();
    } finally { await s.close(); }
  }));
  it('shares one CAS across members and default, ignores background progress and detects member ABA', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g), members = (await s.groups.view(key)).members;
      const alphaId = need(members[0]).id, betaId = need(members[1]).id;
      const raced = await Promise.allSettled([
        s.groups.setModel(key, { expectedModelRevision: 0, memberId: alphaId, modelSelection: a }),
        s.groups.setModel(key, { expectedModelRevision: 0, memberId: betaId, modelSelection: b }),
      ]);
      expect(raced.filter(row => row.status === 'fulfilled')).toHaveLength(1);
      expect(raced.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'dsh-bot/conflict' } });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, modelSelection: null })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      await s.groups.send(key, { operationId: 'progress', text: 'progress', expectedMembershipRevision: 1 }); await s.settle(g);
      const changed = await s.groups.setModel(key, { expectedModelRevision: 1, memberId: alphaId, modelSelection: b });
      const restored = await s.groups.setModel(key, { expectedModelRevision: changed.modelRevision, memberId: alphaId, modelSelection: a });
      expect(restored.modelRevision).toBe(3);
      await expect(s.groups.setModel(key, { expectedModelRevision: 1, memberId: alphaId, modelSelection: null })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    } finally { await s.close(); }
  }));
  it('rejects unknown, disabled and recreated members and drops removed overrides before a fresh membership', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g), member = need((await s.groups.view(key)).members[0]);
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, memberId: 'unknown', modelSelection: a })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      const domain = s.domain;
      await domain.table('members').put(member.id, { ...member, enabled: false });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, memberId: member.id, modelSelection: a })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      await domain.table('members').put(member.id, member);
      const bot = need(f.bots.get('alpha')); f.bots.set('alpha', { ...bot, createdAt: 2 });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, memberId: member.id, modelSelection: a })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      f.bots.set('alpha', bot);
      s.resolveCallConfig.mockImplementationOnce(async selection => { f.bots.set('alpha', { ...bot, createdAt: 2 }); return selection; });
      await expect(s.groups.setModel(key, { expectedModelRevision: 0, memberId: member.id, modelSelection: a })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      expect((await s.groups.view(key)).group.modelRevision).toBeUndefined();
      f.bots.set('alpha', bot); f.bots.set('gamma', { ...bot, id: 'gamma' });
      const configured = await s.groups.setModel(key, { expectedModelRevision: 0, memberId: member.id, modelSelection: a });
      const removed = await s.groups.edit(key, { name: g.name, mode: g.mode, members: [beta, { botId: 'gamma', botCreatedAt: 1 }],
        expectedRevision: configured.revision, expectedMembershipRevision: 1, historyConfirmed: true });
      expect(removed.memberModelSelections).toBeUndefined(); expect(removed.modelRevision).toBe(2);
      await expect(s.groups.setModel(key, { expectedModelRevision: 2, memberId: member.id, modelSelection: null })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      const added = await s.groups.edit(key, { name: g.name, mode: g.mode, members: [alpha, beta],
        expectedRevision: removed.revision, expectedMembershipRevision: removed.membershipRevision, historyConfirmed: true });
      const replacement = need((await s.groups.view(key)).members.find(row => row.bot.botId === 'alpha' && row.removedAt === undefined));
      expect(replacement.id).not.toBe(member.id); expect(added.memberModelSelections).toBeUndefined(); expect(added.modelRevision).toBe(3);
      await expect(s.groups.setModel(key, { expectedModelRevision: 2, memberId: replacement.id, modelSelection: b })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    } finally { await s.close(); }
  }));
  it('freezes every member override at admission for queued work while active workers keep their route', () => withIntegrations(async f => {
    const s = await fixture(f, 30_000); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const g = await s.createGroup('member-snapshot', 'mention'), key = groupKey(g), members = (await s.groups.view(key)).members;
      const alphaId = need(members[0]).id, betaId = need(members[1]).id;
      await s.groups.setModel(key, { expectedModelRevision: 0, memberId: alphaId, modelSelection: a });
      await s.groups.setModel(key, { expectedModelRevision: 1, memberId: betaId, modelSelection: b });
      s.setOnStart(async (_input, index) => { if (index === 1) await gate; return answer('member snapshot'); });
      const first = await s.groups.send(key, { operationId: 'active', text: 'first', round: true, expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const queued = await s.groups.send(key, { operationId: 'queued', text: 'queued', round: true, expectedMembershipRevision: 1 });
      expect(queued.memberModelSelections).toEqual(first.memberModelSelections);
      await s.groups.setModel(key, { expectedModelRevision: 2, memberId: alphaId, modelSelection: b });
      await s.groups.setModel(key, { expectedModelRevision: 3, memberId: betaId, modelSelection: a });
      expect(s.calls[0]?.signal.aborted).toBe(false); release(); await s.settle(g);
      expect(s.calls.map(call => call.route)).toEqual([a, b, a, b]);
      await s.groups.send(key, { operationId: 'new', text: 'new', round: true, expectedMembershipRevision: 1 }); await s.settle(g);
      expect(s.calls.slice(-2).map(call => call.route)).toEqual([b, a]);
    } finally { release?.(); await s.close(); }
  }));
});
