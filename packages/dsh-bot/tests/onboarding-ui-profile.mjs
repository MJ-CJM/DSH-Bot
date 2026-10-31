import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'onboarding-ui-fixture';
export const inject = ['loader', 'dshBots', 'sessionController', 'llm', 'agents', 'sessionQuery'];
class Adapter extends LlmAdapter {
  constructor(ctx, config) { super(); this.ctx = ctx; this.config = config; }
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic onboarding fixture' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    const source = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && ['user', 'dsh-bot-onboarding'].includes(event.data.source.kind))?.data.source;
    const body = JSON.stringify(options);
    const call = { sessionId: options.sessionId, source, provider: options.provider, model: options.model,
      onboarding: source?.kind === 'dsh-bot-onboarding', realModel: false };
    await appendFile(join(this.config.outputDir, 'ui-model-calls.jsonl'), `${JSON.stringify(call)}\n`);
    const response = await fetch(this.config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body, signal: options.signal, redirect: 'error' });
    assert.equal(response.status, 200);
    const zh = body.includes('论文助手');
    const text = call.onboarding
      ? zh ? '我是论文助手，可以协助整理文献和研究进展。你希望我先关注哪个方向？' : 'I can help organize papers and research updates. What would you like me to focus on first?'
      : 'ONBOARDING_UI_TASK_RECEIVED';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(); let off, probes;
    const run = (async () => {
      await ctx.loader.await(); assert.deepEqual(ctx.llm.listProviders(), []);
      off = ctx.llm.registerAdapter(['dp-loopback'], new Adapter(ctx, config));
      await ctx.dshBots.waitUntilReady();
      let groups = ctx.get('dshBotGroups'); const deadline = Date.now() + 30000;
      while (!groups) { assert.ok(Date.now() < deadline); await delay(20, undefined, { signal: lifetime.signal }); groups = ctx.get('dshBotGroups'); }
      const bots = [], sessions = {};
      for (const [id, name, avatar, prefix] of [
        ['v063-empty-whale', 'Empty Whale', undefined, 'Review evidence and report the result.'],
        ['v063-empty-emoji', 'Emoji Helper', '🦉', 'Keep research notes concise.'],
        ['v063-active-whale', 'Active Whale', undefined, 'Review source evidence.'],
      ]) {
        const bot = await ctx.dshBots.create({ id, name, ...(avatar ? { avatar } : {}), template: 'minimal',
          model: { provider: 'dp-loopback', model: 'fixture' }, persona: { prefix } });
        bots.push({ id: bot.id, createdAt: bot.createdAt, name });
        const main = await ctx.dshBots.openConversation(id); sessions[id] = main.sessionId;
        if (id !== 'v063-empty-whale') {
          const { agent } = await ctx.sessionController.resolveAgent(main.sessionId); assert.ok(agent);
          agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'SYNTHETIC_AVATAR_HISTORY' }] }));
          await agent.whenIdle();
        }
      }
      const group = await groups.create({ operationId: 'v063-avatar-group', name: 'Research Group', mode: 'natural',
        members: bots.slice(0, 2).map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt })), historyConfirmed: true });
      const opened = await groups.open({ groupId: group.id, groupCreatedAt: group.createdAt });
      await writeFile(join(config.outputDir, 'onboarding-ui-fixture.json'), JSON.stringify({ bots, sessions,
        group: { ...group, rootSessionId: opened.sessionId ?? group.rootSessionId }, realModelRequests: 0 }));
      console.log('B4_WEB_READY');
      probes = (async () => {
        let previous;
        while (!lifetime.signal.aborted) {
          const request = await readFile(join(config.outputDir, 'onboarding-probe-request.json'), 'utf8').then(JSON.parse).catch(() => undefined);
          if (request && request.id !== previous) {
            assert.match(request.id, /^[a-z0-9-]+$/); previous = request.id;
            const observed = await ctx.sessionQuery.observeSession(request.sessionId);
            try {
              const bots = await ctx.dshBots.list(), statuses = await ctx.dshBots.status();
              const botId = statuses.find(status => status.mainSessionId === request.sessionId)?.id;
              const bot = bots.find(bot => bot.id === botId);
              await writeFile(join(config.outputDir, `onboarding-probe-${request.id}.json`), JSON.stringify({ bot,
                status: botId ? await ctx.dshBots.onboardingStatus(botId) : undefined,
                inputs: observed.events.filter(event => event.type === 'user/message').map(event => ({ id: event.data.id, source: event.data.source })),
                replies: observed.events.filter(event => event.type === 'assistant/message').map(event => ({ id: event.data.message.id, content: event.data.message.content })),
                requests: observed.events.filter(event => event.type === 'request/header').length }));
            } finally { observed[Symbol.dispose](); }
          }
          await delay(35, undefined, { signal: lifetime.signal });
        }
      })().catch(async error => { if (!lifetime.signal.aborted) await writeFile(join(config.outputDir, 'onboarding-ui-error.json'), JSON.stringify({ error: String(error), stack: error.stack })); });
    })().catch(async error => {
      await writeFile(join(config.outputDir, 'onboarding-ui-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('B4_WEB_FAILED');
    });
    return async () => { lifetime.abort(); await run; await probes; off?.(); };
  });
}
