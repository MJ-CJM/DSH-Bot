import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { apply as applyBase } from './deepening/b4-web-profile.mjs';
export const name = 'simplified-bots-ui-profile';
export const inject = ['loader', 'dshBots', 'sessionController', 'llm', 'agents', 'permissionPresets', 'sessionQuery'];
const modelChoices = [{ id: 'fixture', name: 'Synthetic UI hold fixture' }, { id: 'fixture-alt', name: 'Synthetic UI alternate' }];
const memberProvider = 'dp-ui-member';
const memberModels = modelChoices.map(model => ({ ...model, name: `Member provider ${model.name}` }));
const efforts = [{ id: 'ui-low', name: 'UI light reasoning' }, { id: 'ui-high', name: 'UI intensive reasoning' }];
class UiAdapter extends LlmAdapter {
  constructor(config, host) { super(); this.config = config; this.host = host; }
  async listModels(provider) { return (provider === memberProvider ? memberModels : modelChoices).map(model => ({ provider, ...model })); }
  async resolveModel(provider, model) {
    const choice = (provider === memberProvider ? memberModels : modelChoices).find(choice => choice.id === model); assert.ok(choice);
    return { provider, ...choice, reasoning: { efforts, defaultEffort: 'ui-low' } };
  }
  async *stream(options) {
    const agent = this.host.agents.get(options.sessionId); assert.ok(agent);
    await appendFile(join(this.config.outputDir, 'ui-model-calls.jsonl'), `${JSON.stringify({ sessionId: options.sessionId,
      parentSession: agent.session.header.parentSession, agentPreset: agent.session.header.agentPreset, input: JSON.stringify(options), provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort })}\n`);
    const body = JSON.stringify(options);
    const response = await fetch(this.config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: options.signal, redirect: 'error' });
    assert.equal(response.status, 200);
    if (body.includes('V060_HOLD_WORK')) {
      await writeFile(join(this.config.outputDir, `working-${options.sessionId}.json`), JSON.stringify({ sessionId: options.sessionId }));
      while (!await access(join(this.config.outputDir, 'release-work')).then(() => true).catch(() => false)) await delay(30, undefined, { signal: options.signal });
    }
    const text = 'DP_LOOPBACK_OK';
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  applyBase(ctx, config);
  ctx.effect(() => {
    const controller = new AbortController(), releases = [];
    let probeRun;
    const probePermissions = async () => {
      let previous;
      while (!controller.signal.aborted) {
        const request = await readFile(join(config.outputDir, 'permission-probe-request.json'), 'utf8').then(JSON.parse).catch(() => undefined);
        if (request && request.id !== previous) {
          assert.match(request.id, /^[a-z0-9-]+$/); assert.match(request.sessionId, /^group-root-/); previous = request.id;
          const agent = ctx.agents.get(request.sessionId); assert.ok(agent, 'Permission probe requires the already-open native group root');
          const observed = await ctx.sessionQuery.observeSession(request.sessionId);
          try {
            await writeFile(join(config.outputDir, `permission-probe-${request.id}.json`), JSON.stringify({ id: request.id,
              rootSessionId: request.sessionId, currentValue: ctx.permissionPresets.current(agent.session),
              groupView: await (async () => { const groups = ctx.get('dshBotGroups'); const summary = (await groups.list()).find(row => row.group.rootSessionId === request.sessionId); return groups.view({ groupId: summary.group.id, groupCreatedAt: summary.group.createdAt }); })(),
              permissionCommands: observed.events.filter(event => event.type === 'command/run' && event.data.name === 'permission').map(event => ({ seq: event.seq, commandId: event.data.commandId, args: event.data.args })),
              rootModelRequests: observed.events.filter(event => event.type === 'request/header').length }));
          } finally { observed[Symbol.dispose](); }
        }
        await delay(40, undefined, { signal: controller.signal });
      }
    };
    const run = (async () => {
      let fixture; const deadline = Date.now() + 60000;
      while (!fixture) { assert.ok(Date.now() < deadline); fixture = await readFile(join(config.outputDir, 'web-fixture.json'), 'utf8').then(JSON.parse).catch(() => undefined); if (!fixture) await delay(30, undefined, { signal: controller.signal }); }
      releases.push(ctx.llm.registerAdapter(['dp-ui-hold', memberProvider], new UiAdapter(config, ctx)));
      const mentionBots = [];
      for (const id of ['v060-mention-a', 'v060-mention-b']) {
        const bot = await ctx.dshBots.create({ id, name: '研究员 Researcher', template: 'minimal', model: { provider: 'dp-ui-hold', model: 'fixture' } });
        mentionBots.push({ id: bot.id, name: bot.name, createdAt: bot.createdAt });
      }
      await writeFile(join(config.outputDir, 'grok-fixture.json'), JSON.stringify({ ...fixture, mentionBots,
        permissionCatalog: ctx.permissionPresets.catalog(), modelChoices: { provider: 'dp-ui-hold', memberProvider, memberModels, models: modelChoices, efforts }, realModelRequests: 0 }));
      probeRun = probePermissions().catch(async error => {
        if (!controller.signal.aborted) await writeFile(join(config.outputDir, 'permission-probe-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      });
    })().catch(async error => { await writeFile(join(config.outputDir, 'grok-fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack })); });
    return async () => { controller.abort(); await run; await probeRun; for (const release of releases) release(); };
  });
}
