// Test-only first-main creation; no pair session or hidden/archived row.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'b2b-lazy-fixture';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'sessionController', 'sessions', 'approval', 'workspaceRegistry'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopped = false;
    const run = (async () => {
      await ctx.loader.await();
      const wait = async (fn) => { const end = Date.now() + 45000; while (!stopped && Date.now() < end) { const v = await fn(); if (v) return v; await delay(20); } throw Error('Lazy fixture deadline'); };
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const first = config.phase === 'first', service = ctx.get('dshBotMessaging'); assert.ok(service);
      const off = ctx.on('approval/request', async () => 'allowed-once', { prepend: true });
      try {
        if (first) for (const id of ['alpha', 'beta']) await ctx.dshBots.create({ id, name: id, template: 'minimal', persona: { prefix: `B2B_PERSONA_${id}` } });
        const alphaMain = await ctx.dshBots.openConversation('alpha');
        const r = await ctx.sessionController.resolveAgent(alphaMain.sessionId); if ('error' in r) throw r.error;
        if (first) {
          assert.equal((await ctx.dshBots.status()).find(b => b.id === 'beta').mainSessionId, undefined);
          assert.equal((await ctx.sessionController.list({}, new AbortController().signal)).items.length, 1);
          await fetch(`${config.mockUrl}/control`, { method: 'POST', body: JSON.stringify([{ route: 'window-notify' }]) });
          r.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'B2B_FIRST_TARGET_MAIN' }] }));
          await r.agent.whenIdle(); await wait(() => service.store.rows()[0]?.processing === 'completed'); await service.settled();
        }
        const betaMain = await ctx.dshBots.mainSessions.find('beta'); assert.ok(betaMain);
        const rows = (await ctx.sessionController.list({}, new AbortController().signal)).items;
        assert.deepEqual(rows.map(s=>s.sessionId).sort(), [alphaMain.sessionId,betaMain.sessionId].sort());
        const workspace = ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(alphaMain.sessionId));
        assert.deepEqual([...workspace.sessionIds].sort(), rows.map(s=>s.sessionId).sort());
        const identity = { alphaMain, betaMain };
        if (!first) assert.deepEqual(identity, JSON.parse(await readFile(resolve(config.outputDir, 'identity.json'))));
        else await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify(identity));
        await writeFile(resolve(config.outputDir, `${config.phase}-result.json`), JSON.stringify({ status: 'PASS', lazyFirstMainOnly: true, rows, identity }, null, 2));
        console.log('B2B_DONE');
      } finally { off(); }
    })().catch(async e => { await writeFile(resolve(config.outputDir, `${config.phase}-failure.json`), JSON.stringify({ error: String(e), stack: e.stack })); console.log('B2B_FAILED'); });
    return async () => { stopped = true; await run; };
  });
}
