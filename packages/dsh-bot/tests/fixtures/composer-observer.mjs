/** Host-only integration fixture: reads public services after Loader settlement. */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { format } from 'node:util';
import { agentEvents } from '@deepseek-ai/dsh-agent';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { getBotBinding } from 'dsh-bot/bot-context';

export const inject = ['loader', 'sessionController', 'agents', 'agentPresets', 'agentDefaultModel', 'systemPrompt', 'skills', 'tools', 'llm'];

async function saveResult(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${path}.tmp`, path);
}

export function apply(ctx, config) {
  const calls = { stream: 0 };
  class CatalogOnlyAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 't05-bot-model', name: 'Offline test model' }]; }
    stream() { calls.stream++; throw new Error('T05 must not request model output'); }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['t05-bot-provider'], new CatalogOnlyAdapter()));
  ctx.effect(() => ctx.logger.exporter({
    export(message) {
      const text = format(...message.args);
      if (text.includes('[dsh-bot]')) console.log(text);
    },
  }));
  ctx.provide('t05LogReady', true);
  ctx.effect(() => {
    const controller = new AbortController();
    const operation = inspect(ctx, config, controller.signal, calls).catch(async (error) => {
      if (!controller.signal.aborted) {
        await saveResult(config.responsePath, { ok: false, error: String(error.stack ?? error) });
      }
    });
    return async () => {
      controller.abort();
      await operation;
    };
  });
}

async function inspect(ctx, config, signal, calls) {
  await ctx.loader.await();
  let request;
  while (!signal.aborted && request === undefined) {
    try { request = JSON.parse(await readFile(config.requestPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await setTimeout(100, undefined, { signal });
    }
  }
  if (signal.aborted) return;
  const live = [];
  const create = async (preset) => {
    const created = await ctx.sessionController.create({ cwd: request.cwd, agentPreset: preset });
    const resolved = await ctx.sessionController.resolveAgent(created.sessionId);
    if ('error' in resolved) throw resolved.error;
    return resolved.agent;
  };
  const inspectAgent = async (agent, botId) => {
    const skills = await ctx.skills.list({ cwd: request.cwd, scope: agent });
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent });
    const routed = await agentEvents(ctx, agent).waterfall('agent/request', {
      turn: 1, step: 1, signal,
    }, async () => ({ provider: 'fixture-baseline', model: 'fixture-baseline', reasoningEffort: 'low' }));
    return {
      botId, sessionId: agent.id, status: agent.status,
      binding: getBotBinding(agent) ?? null,
      preset: ctx.agentPresets.composedPreset(agent.ctx),
      skills: skills.map((skill) => ({ name: skill.name, provider: skill.provider })),
      tools: ctx.tools.schemas(agent).map((tool) => tool.name).sort(),
      persona: assembly.sections.filter((section) => section.name === 'deployment:persona-prefix').map((section) => section.text).join('\n'),
      model: { provider: assembly.variables.provider, model: assembly.variables.model },
      requestModel: { provider: routed.provider, model: routed.model,
        ...(routed.reasoningEffort === undefined ? {} : { reasoningEffort: routed.reasoningEffort }) },
      hasModelRequestHeader: agent.session.requestHeader() !== undefined,
    };
  };
  const agents = [];
  for (const botId of request.ids) {
    if (signal.aborted) return;
    const agent = await create(`bot-${botId}`);
    live.push(agent);
    agents.push(await inspectAgent(agent, botId));
  }
  const plainAgent = await create('standard');
  const plain = await inspectAgent(plainAgent, null);
  const bots = ctx.get('dshBots');
  if (!bots) throw new Error('Bot registry unavailable after Loader settlement');
  await bots.update(request.ids[0], { tools: { deny: [] }, persona: { prefix: 'T05_ALPHA_UPDATED' } });
  const old = await inspectAgent(live[0], request.ids[0]);
  const freshAgent = await create(`bot-${request.ids[0]}`);
  const fresh = await inspectAgent(freshAgent, request.ids[0]);
  const invalidModels = [];
  for (const [id, model] of [
    ['t05-bad-provider', { provider: 'absent-provider', model: 't05-bot-model' }],
    ['t05-bad-model', { provider: 't05-bot-provider', model: 'absent-model' }],
  ]) {
    await bots.create({ id, name: id, template: 'minimal', model });
    try {
      const unexpected = await create(`bot-${id}`);
      invalidModels.push({ id, rejected: false, sessionId: unexpected.id });
    } catch (error) {
      invalidModels.push({ id, rejected: true, code: error.code, message: error.message });
    }
  }
  const defaults = ctx.agentDefaultModel.currentSelection();
  await saveResult(config.responsePath, {
    ok: true, agents, plain, generation: { old, fresh, oldAgentStillLive: ctx.agents.get(live[0].id) === live[0] },
    invalidModels, streamCalls: calls.stream, idleSessionsCreated: 5,
    defaultModel: { provider: defaults.provider, model: defaults.model }, promptsSent: 0,
  });
}
