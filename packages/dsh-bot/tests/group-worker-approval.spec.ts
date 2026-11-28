import { expect, it, vi } from 'vitest';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { installWorkerApproval, workerApprovalMatches } from '../src/host/groups/worker-approval.js';
import { protectWorkerCapabilities } from '../src/host/groups/worker-capabilities.js';
import { protectDataFlow } from '../src/host/data-flow/tool-guard.js';
import { flowFixture, alpha, beta } from './deepening/managed-flow-fixture.js';
import { withIntegrations } from './integration-support.js';

it.each(['member', 'guest', 'supergroup'] as const)('inherits root ask/never for %s without changing sandbox, refreshes warm work, and fails closed for missing roots', mode => withIntegrations(async f => {
  const root = f.createAgent('root'), child = f.createAgent('child');
  Object.assign(child.value, { inject: vi.fn() });
  await child.scope.ctx.plugin({ inject: ['tools', 'systemPrompt', 'approval'], apply(ctx) { child.value.ctx = ctx; } }).await();
  setApprovalPolicy(child.agent.session, 'never');
  const rootHeader = structuredClone(root.agent.session.header), childHeader = structuredClone(child.agent.session.header);
  let current = root.agent as typeof root.agent | undefined;
  const stop = installWorkerApproval(child.agent, () => current);
  protectWorkerCapabilities(child.agent, () => mode, mode, () => workerApprovalMatches(child.agent));
  expect(child.agent.ctx.approval.overrideOf(child.agent.session)).toBe('ask');
  expect(workerApprovalMatches(child.agent)).toBe(true);
  expect(child.agent.session.header).toEqual(childHeader); expect(root.agent.session.header).toEqual(rootHeader);
  const step = () => f.ctx.waterfall(scopeTarget(child.agent, child.agent), 'agent/pre-step', { agent: child.agent, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [] }));
  setApprovalPolicy(root.agent.session, 'never');
  expect(workerApprovalMatches(child.agent)).toBe(false);
  await step(); expect(child.agent.ctx.approval.overrideOf(child.agent.session)).toBe('never');
  expect(workerApprovalMatches(child.agent)).toBe(true);
  setApprovalPolicy(root.agent.session, 'ask');
  await step(); expect(child.agent.ctx.approval.overrideOf(child.agent.session)).toBe('ask');
  // A policy round trip also revokes the previous inheritance receipt.
  setApprovalPolicy(root.agent.session, 'never'); setApprovalPolicy(root.agent.session, 'ask');
  expect(workerApprovalMatches(child.agent)).toBe(false);
  await step(); expect(workerApprovalMatches(child.agent)).toBe(true);
  current = undefined;
  expect(workerApprovalMatches(child.agent)).toBe(false); await expect(step()).rejects.toThrow('approval-denied');
  stop(); expect(workerApprovalMatches(child.agent)).toBe(false); child.scope.dispose(); root.scope.dispose();
}));

it('keeps root never requests denied and cancels old allowed decisions after root revocation', async () => {
  const x = await flowFixture();
  try { await withIntegrations(async f => {
    Object.assign(f.registry, x.registry(), { config: { nativeToolPolicy: 'native' } });
    const root = f.createAgent('root'), child = f.createAgent('group-worker');
    Object.assign(child.value, { inject: vi.fn() });
    await child.scope.ctx.plugin({ inject: ['tools', 'systemPrompt', 'approval'], apply(ctx) { child.value.ctx = ctx; } }).await();
    setApprovalPolicy(root.agent.session, 'never'); setApprovalPolicy(child.agent.session, 'never');
    await x.flow.inherit(child.agent.session.id, { readers: [alpha, beta], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
    const called = vi.fn(async () => 'SHELL_RESULT');
    f.ctx.tools.register(defineTool({ name: 'bash', description: 'inert approval target', parameters: {}, execute: called,
      output: { schema: { type: 'string' }, render: () => [] } }));
    installWorkerApproval(child.agent, () => root.agent);
    protectWorkerCapabilities(child.agent, () => 'member', 'member', () => workerApprovalMatches(child.agent));
    protectDataFlow(child.agent, alpha, f.registry);
    child.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'ask', reason: 'native tool approval' }));
    const answerer = vi.fn(async () => 'allowed-once' as const); f.ctx.on('approval/request', answerer);
    const call = () => f.ctx.tools.execute({ agent: child.agent, name: 'bash', arguments: {},
      callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
    expect((await call()).isError).toBe(true); expect(answerer).not.toHaveBeenCalled(); expect(called).not.toHaveBeenCalled();
    setApprovalPolicy(root.agent.session, 'ask');
    await f.ctx.waterfall(scopeTarget(child.agent, child.agent), 'agent/pre-step', { agent: child.agent, messages: [], turn: 0, step: 0, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [] }));
    answerer.mockImplementation(async () => { setApprovalPolicy(root.agent.session, 'never'); return 'allowed-once'; });
    expect((await call()).isError).toBe(true); expect(answerer).toHaveBeenCalledOnce(); expect(called).not.toHaveBeenCalled();
    child.scope.dispose(); root.scope.dispose();
  }); } finally { await x.close(); }
});
