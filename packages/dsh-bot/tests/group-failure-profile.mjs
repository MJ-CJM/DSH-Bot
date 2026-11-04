// Native Host and real tools; model responses are scripted and end with native LlmFailure finishes.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'group-failure-probe';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'webServer'];
// Same chunk shape the real DeepSeek route recorded for "Insufficient Balance".
const failures = {
  'Quota Partial': { message: 'Insufficient Balance (request_id: fixture-partial)', code: 'QUOTA', status: 402 },
  'Quota Silent': { message: 'Insufficient Balance (request_id: fixture-silent)', code: 'QUOTA', status: 402 },
  'Request Bot': { message: 'Model rejected the request: unsupported parameter', code: 'INVALID_REQUEST', status: 400 },
};
// Members that first do real work (text + a native read), then fail on the next model request.
const workFirst = new Set(['Quota Partial', 'Request Bot']);
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), disposers = [], steps = new Map();
    let group, view, bots = [], saving = Promise.resolve(), modelRequests = 0;
    const save = () => { const json = JSON.stringify({ group, view, bots: bots.map(b => ({ id: b.id, name: b.name })), modelRequests, realModelRequests: 0 }, null, 2); saving = saving.then(async () => { const tmp = resolve(config.outputDir, 'failures.tmp'); await writeFile(tmp, json); await rename(tmp, resolve(config.outputDir, 'failures.json')); }); return saving; };
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Failure test' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Failure test' }; }
      async *stream(options) {
        modelRequests++;
        const agent = ctx.agents.get(options.sessionId); assert.ok(agent);
        const label = agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor')?.data.label;
        assert.ok(label in failures, `unexpected model caller ${label}`);
        const step = (steps.get(options.sessionId) ?? 0) + 1; steps.set(options.sessionId, step);
        if (workFirst.has(label) && step === 1) {
          const text = label === 'Quota Partial' ? 'Checked the seed file; continuing with the next check:' : 'Collected the first result; requesting the next one:';
          const id = ToolCallId(randomUUID()), args = JSON.stringify({ file_path: resolve(group.cwd, 'seed.txt') });
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'block-start', index: 1, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 1, id, name: 'read', argumentsDelta: args };
          yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'read', arguments: args } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'finish', reason: { kind: 'error', failure: failures[label] } };
      }
    }
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      disposers.push(ctx.llm.registerAdapter(['dp-loopback'], new Adapter()));
      await ctx.dshBots.waitUntilReady();
      for (const [id, botName] of [['quota-partial', 'Quota Partial'], ['quota-silent', 'Quota Silent'], ['request-bot', 'Request Bot']])
        bots.push(await ctx.dshBots.create({ id, name: botName, template: 'standard', model: { provider: 'dp-loopback', model: 'fixture' } }));
      const groups = ctx.get('dshBotGroups'); assert.ok(groups);
      group = await groups.create({ operationId: 'failure-group', name: 'Failure test group', mode: 'natural', historyConfirmed: true,
        members: bots.map(b => ({ botId: b.id, botCreatedAt: b.createdAt })) });
      await writeFile(resolve(group.cwd, 'seed.txt'), 'FAILURE_FIXTURE_READ');
      const key = { groupId: group.id, groupCreatedAt: group.createdAt };
      await groups.send(key, { operationId: 'first', text: 'Please check the build and launch it', expectedMembershipRevision: 1 });
      const deadline = Date.now() + 30000;
      const settled = current => current.deliveries.length === 3 && current.deliveries.every(d => !['pending', 'starting', 'running'].includes(d.state));
      for (view = await groups.view(key); !settled(view); view = await groups.view(key)) {
        assert.ok(Date.now() < deadline, 'member runs settle'); await delay(50, undefined, { signal: controller.signal });
      }
      await save(); console.log('B4_WEB_READY');
    })().catch(async error => { await writeFile(resolve(config.outputDir, 'fixture-error.txt'), String(error.stack)); console.error('B4_WEB_FAILED', error); });
    return async () => { controller.abort(); for (const dispose of disposers.reverse()) dispose(); await run; };
  });
}
