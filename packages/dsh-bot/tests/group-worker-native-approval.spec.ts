import { expect, it, vi } from 'vitest';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import * as ToolBash from '@deepseek-ai/dsh-tool-bash';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { ToolCallId } from '@deepseek-ai/dsh-llm';

import { installWorkerApproval, workerApprovalMatches } from '../src/host/groups/worker-approval.js';
import { protectWorkerCapabilities } from '../src/host/groups/worker-capabilities.js';
import { protectDataFlow } from '../src/host/data-flow/tool-guard.js';
import { flowFixture, alpha, beta } from './deepening/managed-flow-fixture.js';
import { withIntegrations } from './integration-support.js';

it.each([
  { mode: 'member', change: 'revoke' }, { mode: 'guest', change: 'revoke' }, { mode: 'supergroup', change: 'revoke' },
  { mode: 'member', change: 'none' }, { mode: 'guest', change: 'none' }, { mode: 'supergroup', change: 'none' },
  { mode: 'member', change: 'never' }, { mode: 'guest', change: 'never' }, { mode: 'supergroup', change: 'never' },
  { mode: 'member', change: 'abort' }, { mode: 'guest', change: 'abort' }, { mode: 'supergroup', change: 'abort' },
  { mode: 'member', change: 'reservation' }, { mode: 'member', change: 'root-missing' },
  { mode: 'member', change: 'root-replaced' }, { mode: 'member', change: 'root-error' }, { mode: 'member', change: 'refresh' },
  { mode: 'member', change: 'unload' }, { mode: 'member', change: 'rejected' }, { mode: 'member', change: 'unavailable' },
] as const)('native bash $mode / $change applies the expected approval boundary', async ({ mode, change }) => {
  const x = await flowFixture();
  try { await withIntegrations(async f => {
    Object.assign(f.registry, x.registry(), { config: { nativeToolPolicy: 'native' } });
    const root = f.createAgent('root'), child = f.createAgent('worker');
    Object.assign(child.value, { inject: vi.fn() });
    await child.scope.ctx.plugin({ inject: ['tools', 'systemPrompt', 'approval'], apply(ctx) { child.value.ctx = ctx; } }).await();
    setApprovalPolicy(root.agent.session, change === 'never' ? 'never' : 'ask'); setApprovalPolicy(child.agent.session, 'never');
    await x.flow.inherit(child.agent.session.id, { readers: [alpha, beta], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
    const operation = vi.fn(async () => ({ result: async () => ({
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
      stdout: { text: 'SIDE_EFFECT_RAN', truncated: false }, stderr: { text: '', truncated: false },
    }) }));
    f.ctx.provide('shell', { sandboxMode: 'read-only',
      resolve: (request: object) => ({ ...request, workdir: f.root, timeoutMs: 1000 }),
      execute: operation,
    } as never);
    f.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: f.root }) } as never);
    f.ctx.provide('workingDirectory', { ensure: async () => f.root } as never);
    f.ctx.provide('shellEnv', { collect: () => ({}) } as never);
    await f.ctx.plugin(ToolBash, { enableRunInBackground: false }).await();
    let live = true, rootAvailable = true, rootBroken = false, rootAgent = root.agent;
    let replacement: ReturnType<typeof f.createAgent> | undefined;
    const stop = installWorkerApproval(child.agent, () => {
      if (rootBroken) throw new Error('Group root unavailable');
      return live && rootAvailable ? rootAgent : undefined;
    });
    protectWorkerCapabilities(child.agent, () => live ? mode : undefined, mode, () => workerApprovalMatches(child.agent));
    protectDataFlow(child.agent, alpha, f.registry);
    const controller = new AbortController();
    const answerer = vi.fn(async () => {
      if (change === 'revoke') {
        setApprovalPolicy(root.agent.session, 'never');
        expect(workerApprovalMatches(child.agent)).toBe(false);
      }
      if (change === 'abort') controller.abort(new Error('Group task cancelled'));
      if (change === 'reservation') live = false;
      if (change === 'root-missing') rootAvailable = false;
      if (change === 'root-error') rootBroken = true;
      if (change === 'root-replaced') {
        replacement = f.createAgent('root'); rootAgent = replacement.agent;
        setApprovalPolicy(rootAgent.session, 'ask');
      }
      if (change === 'refresh') {
        setApprovalPolicy(root.agent.session, 'never'); setApprovalPolicy(root.agent.session, 'ask');
        await f.ctx.waterfall(scopeTarget(child.agent, child.agent), 'agent/pre-step', {
          agent: child.agent, messages: [], turn: 0, step: 0, signal: new AbortController().signal,
        }, async () => ({ kind: 'enter' as const, messages: [] }));
        expect(workerApprovalMatches(child.agent)).toBe(true);
      }
      if (change === 'unload') stop();
      if (change === 'rejected' || change === 'unavailable') return change;
      return 'allowed-once' as const;
    });
    f.ctx.on('approval/request', answerer);
    const result = await f.ctx.tools.execute({ agent: child.agent, name: 'bash', arguments: { command: 'printf SYNTHETIC_MARKER', description: 'Local native approval fixture', sandbox_permissions: 'workspace-write', justification: 'Local native approval fixture' }, callId: ToolCallId(crypto.randomUUID()), signal: controller.signal });
    try {
      expect(answerer).toHaveBeenCalledTimes(change === 'never' ? 0 : 1);
      if (change === 'none') { expect(operation).toHaveBeenCalledOnce(); expect(result.isError).toBe(false); }
      else { expect(operation).not.toHaveBeenCalled(); expect(result.isError).toBe(true); }
      const decided = child.agent.session.snapshotEvents().findLast(event => event.type === 'approval/decided');
      expect(decided?.data.outcome).toBe(change === 'none' ? 'allowed-once' : change === 'abort' ? 'cancelled' :
        change === 'unavailable' ? 'unavailable' : 'rejected');
    } finally { child.scope.dispose(); root.scope.dispose(); replacement?.scope.dispose(); }
  }); } finally { await x.close(); }
});
