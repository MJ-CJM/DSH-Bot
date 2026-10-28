import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { startDelegate } from '../../src/host/data-flow/delegation.js';
import { protectDataFlow } from '../../src/host/data-flow/tool-guard.js';
import { MemoryLineage } from '../../src/host/data-flow/lineage.js';
import { eraseOutletCopies } from '../../src/host/data-flow/managed-copies.js';
import { groupChild, groupInput, groupResult } from '../../src/host/groups/data-flow.js';
import type { GroupState } from '../../src/host/groups/state.js';
import type { GroupRecord } from '../../src/shared/groups.js';
import { withIntegrations, policy } from '../integration-support.js';
import { flowFixture, alpha, beta } from './managed-flow-fixture.js';

describe('B6b product boundary wiring (UNIT: native transport doubles, real JSON and ToolRuntime)', () => {
  it.each([false, true])('uses caller delivery and checks child-result taint: private child=%s', async privateChild => {
    const x = await flowFixture();
    try {
      let spec: SubagentActivationSpec | undefined, settle!: (value: SubagentResult) => void;
      const output = new Promise<SubagentResult>(accept => { settle = accept; });
      x.f.ctx.provide('subagents', { startActivation: vi.fn(async (value: SubagentActivationSpec) => {
        spec = value; return { childId: value.childId, result: output, dispose: async () => {} };
      }) } as unknown as Context['subagents']);
      const followup = vi.fn(), owner = { ctx: x.f.ctx, session: { id: 'clean' }, followup } as unknown as Agent;
      const activation = await startDelegate(x.registry(), owner, alpha, beta, 'call', { provider: 'spawn', label: 'Fixture',
        request: { parent: owner, prompt: [{ type: 'text', text: 'SHARED_TASK' }] }, delivery: 'parent',
        signal: new AbortController().signal });
      expect(spec?.delivery).toBe('caller'); expect(spec?.childId).toBe(activation.childId);
      if (privateChild) {
        const memory = await x.f.beta.save({ content: 'CHILD_PRIVATE_CANARY' });
        const version = x.f.kernel.snapshot.versions.get(memory.id); if (!version) throw new Error('Missing child version');
        const label = await new MemoryLineage(x.f.kernel).record(activation.childId, [version.versionId]);
        await x.flow.inherit(activation.childId, label);
      }
      settle({ output: [{ type: 'text', text: privateChild ? 'CHILD_PRIVATE_CANARY' : 'SHARED_RESULT' }], stopReason: 'completed' });
      if (privateChild) { await expect(activation.result).rejects.toThrow(); expect(followup).not.toHaveBeenCalled(); }
      else { await activation.result; expect(followup).toHaveBeenCalledTimes(1); }
    } finally { await x.close(); }
  });
  it('persists group audience, inherits input before startup, and blocks private member output before root append', async () => {
    const x = await flowFixture();
    try {
      const root = { session: { id: 'group-root', snapshotEvents: () => [] } } as unknown as Agent;
      const state = { registry: x.registry(),
        members: () => [alpha, beta].map((bot, i) => ({ id: String(i), bot, enabled: true })) } as unknown as GroupState;
      const group = { id: 'group', createdAt: 1 } as GroupRecord;
      const id = await groupInput(state, group, root, 'GROUP_TEXT', 'turn'); expect(id).toBeTruthy();
      const child = await groupChild(state, group, root, alpha, 'CONTEXT', 'delivery', new AbortController().signal);
      if (!child) throw new Error('Missing managed child');
      expect(x.flow.label(child.childId).readers).toEqual([alpha, beta]);
      const append = vi.fn(() => 'APPENDED');
      await expect(groupResult(state, group, alpha, child.childId, root, 'SHARED_RESULT', 'one', append,
        new AbortController().signal)).resolves.toBe('APPENDED');
      await x.flow.inherit(child.childId, x.flow.label('private'));
      await expect(groupResult(state, group, alpha, child.childId, root, 'PRIVATE_CANARY', 'two', append,
        new AbortController().signal)).rejects.toThrow(); expect(append).toHaveBeenCalledTimes(1);
    } finally { await x.close(); }
  });
  it('guards real notification record/display, rejects an old intent after forget and erases its managed body', async () => {
    const x = await flowFixture();
    try { await withIntegrations(async f => {
      Object.assign(f.registry, x.registry());
      await f.notifications.savePolicy(policy('in-app', 'in-app'), 0, true);
      const row = await f.notifications.record(alpha, { operationId: 'synthetic', policyId: 'in-app', text: 'NOTIFY_CANARY' },
        { kind: 'tool', id: 'call', sessionId: 'clean' });
      expect(row.flowId).toBeTruthy(); expect((await f.notifications.deliver(row.id)).state).toBe('recorded');
      await x.f.kernel.commit({ opId: crypto.randomUUID(), kind: 'forget', subjectIds: [x.sharedId],
        expectedRevision: x.f.kernel.seq, forgetEpoch: x.f.kernel.epoch + 1 });
      await expect(f.notifications.deliver(row.id)).rejects.toThrow();
      f.ctx.provide('dshBotNotifications', f.notifications);
      await eraseOutletCopies(f.ctx, x.f.kernel); expect(f.notifications.list()).toEqual([]);
      await expect(f.notifications.record(alpha, { operationId: 'synthetic', policyId: 'in-app', text: 'NOTIFY_CANARY' },
        { kind: 'tool', id: 'call', sessionId: 'clean' })).rejects.toThrow();
    }); } finally { await x.close(); }
  });
  it('wraps an assigned connector after native approval, taints its result, and rejects generic/nested tool exports', async () => {
    const x = await flowFixture();
    try { await withIntegrations(async f => {
      Object.assign(f.registry, x.registry(), { memoryAdmission: { assertAllowed() {} } });
      const { agent } = f.createAgent('clean'), calls = vi.fn(async () => ({ text: 'UNTRUSTED_CONNECTOR_RESPONSE' }));
      const definition = { id: 'fixture', revision: 1, serverName: 'fixture', enabled: true, transport: 'stdio', command: 'synthetic' };
      f.ctx.provide('dshBotConnectors', { runtime: () => [{ sessionId: 'clean', assignmentId: 'assignment', state: 'ready' }],
        assignments: () => [{ id: 'assignment', enabled: true, connectorId: 'fixture', desiredRevision: 1 }],
        definitions: () => [definition] } as unknown as Context['dshBotConnectors']);
      const off = f.ctx.on('approval/request', async () => 'allowed-once');
      protectDataFlow(agent, alpha, f.registry);
      const release = agent.ctx.tools.register(defineTool({ name: 'mcp__fixture__send', description: 'Synthetic connector',
        parameters: {}, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: calls }));
      const run = (name: string) => agent.ctx.tools.execute({ agent, name, arguments: {}, callId: ToolCallId(crypto.randomUUID()),
        signal: new AbortController().signal });
      expect((await run('mcp__fixture__send')).isError).toBe(false); expect(calls).toHaveBeenCalledTimes(1);
      expect(x.flow.label('clean').readers).toEqual([]);
      expect((await run('run_code')).isError).toBe(true);
      definition.enabled = false; expect((await run('mcp__fixture__send')).isError).toBe(true); expect(calls).toHaveBeenCalledTimes(1);
      release(); off();
    }); } finally { await x.close(); }
  });
  it('rechecks notification policy revoked while exact data approval is pending', async () => {
    const x = await flowFixture(), send = vi.fn(async () => ({ state: 'accepted' as const }));
    try { await withIntegrations(async f => {
      Object.assign(f.registry, x.registry());
      const p = policy('external', 'im'); await f.notifications.savePolicy(p, 0, true);
      const { agent } = f.createAgent('clean');
      f.ctx.provide('agents', { get: () => agent } as unknown as Context['agents']);
      const off = f.ctx.on('approval/request', async () => {
        await f.notifications.savePolicy({ ...p, enabled: false }, 1, true); return 'allowed-once';
      });
      const row = await f.notifications.record(alpha, { operationId: 'revoked', policyId: p.id, text: 'CANARY' },
        { kind: 'tool', id: 'call', sessionId: 'clean' });
      const result = await f.notifications.deliver(row.id, row.scopeDigest);
      expect(result.state).toBe('unknown'); expect(send).not.toHaveBeenCalled(); off();
    }, { describe: async () => ({ targetDigest: 'target', label: 'Synthetic' }), send }); }
    finally { await x.close(); }
  });

});
