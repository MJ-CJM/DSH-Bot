import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { apply as applyBase } from './deepening/b4-web-profile.mjs';
export const name = 'grok-ui-profile';
export const inject = ['loader', 'dshBots', 'sessionController', 'llm', 'subagents', 'agents'];
export function apply(ctx, config) {
  applyBase(ctx, config);
  ctx.effect(() => {
    const controller = new AbortController();
    const run = (async () => {
      const deadline = Date.now() + 45000;
      let fixture;
      while (!fixture) {
        controller.signal.throwIfAborted(); assert.ok(Date.now() < deadline, 'Base browser fixture timeout');
        fixture = await readFile(join(config.outputDir, 'web-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (!fixture) await delay(30, undefined, { signal: controller.signal });
      }
      const children = {}, childOutcomes = {};
      for (const [id, sessionId] of Object.entries(fixture.sessions)) {
        const { agent } = await ctx.sessionController.resolveAgent(sessionId);
        assert.ok(agent);
        let receipt, launched = false;
        const offApproval = ctx.on('approval/request', async (request, next) => {
          if (request.agent === agent && request.toolName === 'bot_delegate' && request.reason?.includes('"UI_CATALOG_SAMPLE"'))
            return 'allowed-once';
          return next();
        }, { prepend: true });
        // Dispatch inside an actual native request turn so the public ApprovalService can audit it.
        const offRequest = agent.ctx.on('agent/request', async (_request, next) => {
          if (!launched) {
            launched = true;
            const result = await agent.ctx.tools.execute({ agent, name: 'bot_delegate',
              arguments: { targetBotId: id, task: 'UI_CATALOG_SAMPLE', title: 'Synthetic background sample' },
              callId: ToolCallId(`ui-catalog-${crypto.randomUUID()}`), signal: controller.signal });
            await writeFile(join(config.outputDir, `delegate-${id}.json`), JSON.stringify(result));
            assert.notEqual(result.isError, true, JSON.stringify(result));
            assert.equal(typeof result.value?.childId, 'string', JSON.stringify(result)); receipt = result.value;
          }
          return next();
        });
        try {
          agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'UI_CATALOG_SAMPLE' }] }));
          await agent.whenIdle();
          assert.ok(receipt?.childId, 'Managed delegate receipt missing');
          await ctx.agents.get(receipt.childId)?.whenIdle();
          await agent.whenIdle();
          children[id] = receipt.childId;
          childOutcomes[id] = { accepted: receipt.status, scope: 'UI catalog only' };
        } finally { offRequest(); offApproval(); }
        if (id === 'en-light-1360') await ctx.dshBots.memoryOutlets.inherit(sessionId, {
          readers: [], originTrust: 'candidate', sourceVersions: [], restrictions: ['no-egress'], grants: [],
        });
      }
      await writeFile(join(config.outputDir, 'grok-fixture.json'), JSON.stringify({ ...fixture, children, childOutcomes,
        backgroundScope: 'catalog display after explicit Host ToolRuntime dispatch; not model delegation behavior', realModelRequests: 0 }));
      console.log('GROK_UI_READY');
    })().catch(async error => {
      await writeFile(join(config.outputDir, 'grok-fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('GROK_UI_FAILED');
    });
    return async () => { controller.abort(); await run; };
  });
}
