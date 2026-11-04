// Native Host and public APIs; every model response is scripted, no external model requests.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'group-composer-commands-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'commands', 'webServer'];

export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [];
    const data = { realModelRequests: 0, scriptedModelRequests: 0 };
    const save = async (value) => {
      const tmp = resolve(config.outputDir, 'composer.tmp');
      await writeFile(tmp, JSON.stringify({ ...data, ...value }, null, 2)); await rename(tmp, resolve(config.outputDir, 'composer.json'));
    };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Composer test' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Composer test' }; }
      async *stream(options) {
        data.scriptedModelRequests++;
        await fetch(config.endpoint, { method: 'POST', body: JSON.stringify({ sessionId: options.sessionId }) });
        const text = 'Scripted group reply for the composer command test.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      await ctx.dshBots.waitUntilReady();
      const bots = [];
      for (const [id, botName] of [['planner', 'Planner'], ['reviewer', 'Reviewer']])
        bots.push(await ctx.dshBots.create({ id, name: botName, template: 'minimal', model: { provider: 'dp-loopback', model: 'fixture' } }));
      const groups = ctx.get('dshBotGroups'); assert.ok(groups);
      const group = await groups.create({ operationId: 'composer-group', name: 'Composer test group', mode: 'natural', historyConfirmed: true,
        members: bots.map(b => ({ botId: b.id, botCreatedAt: b.createdAt })) });
      const key = { groupId: group.id, groupCreatedAt: group.createdAt };
      const question = 'Composer command test question';
      const turn = await groups.send(key, { operationId: 'composer-question', text: question, expectedMembershipRevision: 1 });
      const deadline = Date.now() + 30000;
      for (;;) {
        assert.ok(Date.now() < deadline, 'Group question did not settle');
        const view = await groups.view(key), row = view.turns.find(t => t.id === turn.id);
        if (row && !['accepted', 'running'].includes(row.state)) break;
        await delay(50, undefined, { signal: controller.signal });
      }
      const root = ctx.agents.get(group.rootSessionId); assert.ok(root);
      // What the native '/' menu would offer on this root: the Host catalog for its exact Agent.
      const rootCommands = ctx.commands.list(root).map(row => ({ name: row.name, input: Boolean(row.input) }));
      await save({ group: { id: group.id, createdAt: group.createdAt, rootSessionId: group.rootSessionId, cwd: group.cwd }, question, rootCommands });
      console.log('B4_WEB_READY');
    })().catch(async error => { await writeFile(resolve(config.outputDir, 'fixture-error.txt'), String(error.stack)); console.error('B4_WEB_FAILED', error); });
    return async () => { controller.abort(); for (const dispose of disposers.reverse()) dispose(); await run.catch(() => {}); };
  });
}
