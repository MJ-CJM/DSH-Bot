import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyNativeIngress, assertTrustedIngress } from '../../lib/host/memory/trusted-ingress.js';
import { submittedPrompt, syntheticApproval, bounded } from './b6a-support.mjs';
export const name = 'dp-b6a-probe';
export const inject = ['loader', 'llm', 'dshBots', 'sessionController', 'approval'];
class SyntheticAdapter extends LlmAdapter {
  count = 0;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic, no provider' }]; }
  async *stream() { this.count++; yield { type: 'finish', reason: { kind: 'stop' } }; }
}
export function apply(ctx, config) {
  const save = (name, value) => writeFile(resolve(config.outputDir, `receipts/${name}.json`), JSON.stringify(value, null, 2));
  ctx.effect(() => {
    const controller = new AbortController(), signal = controller.signal, releases = [];
    let phase = 'activate', agent;
    const cancel = () => agent?.cancel({ kind: 'hook', reason: 'B6a fixture cancelled' }, { keepInbox: true });
    signal.addEventListener('abort', cancel, { once: true });
    const mark = async value => {
      signal.throwIfAborted(); phase = value;
      await save('progress', { suite: config.suite, phase, synthetic: true, realModelRequests: 0 });
      console.log(`DP_B6A_PHASE ${phase}`);
    };
    const timer = setTimeout(() => controller.abort(new Error(`B6a probe deadline during ${phase}`)), 45000);
    const adapter = new SyntheticAdapter();
    const run = bounded(async () => {
      assert.equal(ctx.llm.listProviders().length, 0);
      releases.push(ctx.llm.registerAdapter(['dp-b6a'], adapter));
      await mark('loader-ready'); await ctx.loader.await();
      await mark('registry-ready'); await ctx.dshBots.waitUntilReady();
      await mark('main-sessions-ready');
      while (!ctx.dshBots.mainSessions) { signal.throwIfAborted(); await delay(20, undefined, { signal }); }
      await mark('create-bot');
      const bot = await ctx.dshBots.create({ id: 'alpha', name: 'Synthetic Alpha', template: 'minimal',
        model: { provider: 'dp-b6a', model: 'fixture' }, persona: { prefix: 'Synthetic B6a fixture' } });
      await mark('open-conversation');
      const { sessionId } = await ctx.dshBots.openConversation('alpha');
      const resolved = await ctx.sessionController.resolveAgent(sessionId); assert.ok(resolved.agent);
      agent = resolved.agent;
      const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
      if (config.suite === 'trusted-ingress') {
        await mark('owner-api-prompt');
        const requestId = 'synthetic-owner-api', content = [{ type: 'text', text: 'I live in Shanghai.' }];
        const before = agent.session.snapshotEvents().length;
        const response = await ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue', content }, signal);
        assert.equal(response.accepted, true, 'prompt must be accepted');
        await agent.whenIdle();
        const events = agent.session.snapshotEvents().slice(before);
        await save('ingress-events', events.filter(e => e.type === 'user/message').map(e => ({ seq: e.seq, source: e.data.source })));
        const acceptedEvent = submittedPrompt(events, requestId, content), accepted = acceptedEvent.data;
        const classified = classifyNativeIngress(accepted); assert.equal(classified.trust, 'candidate');
        assert.equal(classified.effectiveAutoShare, false); assert.equal(classified.receipt, undefined);
        assert.throws(() => assertTrustedIngress({ ...accepted, isTrusted: true, owner: true, nonce: 'forged' }), /cannot be verified/);
        assert.equal([...ctx.dshBots.memoryKernel.snapshot.versions.values()].filter(v => v.scope === 'shared').length, 0);
        signal.throwIfAborted();
        await save('result', { status: 'FAIL (capability: no verifiable direct user entry)', apiImpersonationRejected: true,
          acceptedSourceKind: accepted.source.kind, acceptedRpcId: accepted.source.rpcId,
          ignoredRuntimeContexts: events.filter(e => e.type === 'user/message' && e.data.source.kind === 'runtime-context').length,
          effectiveAutoShare: false, syntheticAdapterRequests: adapter.count, realModelRequests: 0, sharedCommits: 0 });
      } else {
        await mark('save-private');
        const { id } = await ctx.dshBots.memoryFor('alpha').save({ content: 'I live in Shanghai.', tags: ['PRIVATE_TAG_CANARY'] });
        const confirmation = ctx.dshBots.memoryConfirmation; assert.ok(confirmation);
        let failure, completed = 0, answers = 0;
        releases.push(syntheticApproval(agent, async req => {
          await mark('approval-answer'); answers++;
          assert.match(req.reason, /all Bots/); assert.ok(!req.reason.includes('PRIVATE_TAG_CANARY')); return 'allowed-once';
        }));
        releases.push(agent.ctx.effect(() => agent.ctx.on('agent/request', async ({ signal: turnSignal }, next) => {
          try {
            await mark('approval-request');
            const invocation = `${agent.session.id}/confirm-once`, combined = AbortSignal.any([signal, turnSignal]);
            const grant = await confirmation.request(agent, id, owner, invocation, combined);
            await mark('approval-commit');
            await confirmation.commit(id, owner, invocation, grant, combined); completed++;
            await assert.rejects(confirmation.commit(id, owner, invocation, grant, combined), /consumed/);
          } catch (error) { failure = error; }
          return next();
        })));
        await mark('confirm-turn');
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'SYNTHETIC_CONFIRM' }], source: { kind: 'user' } }));
        await agent.whenIdle();
        assert.equal(failure, undefined); assert.equal(completed, 1); assert.equal(answers, 1);
        const ops = [...ctx.dshBots.memoryKernel.domain.table('ops').entries()].map(([, op]) => op);
        assert.equal(ops.filter(op => op.grantUse).length, 1);
        const audit = agent.session.snapshotEvents().filter(e => e.type === 'approval/asked' || e.type === 'approval/decided');
        await save('approval-audit', audit);
        assert.equal(audit.filter(e => e.type === 'approval/asked' && e.data.toolName === 'bot_memory_confirm').length, 1);
        assert.equal(audit.filter(e => e.type === 'approval/decided' && e.data.outcome === 'allowed-once').length, 1);
        signal.throwIfAborted();
        await save('result', { status: 'PASS', nativeOpenTurn: true, nativeAnswers: answers, approvedCommits: 1, duplicateCommits: 0,
          syntheticAdapterRequests: adapter.count, realModelRequests: 0 });
      }
      console.log('DP_B6A_DONE');
    }, signal).catch(async error => {
      await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, realModelRequests: 0 });
      console.log('DP_B6A_FAILED');
    }).finally(() => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      for (const off of releases.reverse()) off();
    });
    return async () => {
      controller.abort(new Error(`B6a probe unloaded during ${phase}`));
      agent?.cancel({ kind: 'hook', reason: 'B6a fixture unload' }, { keepInbox: true });
      await run;
    };
  });
}
