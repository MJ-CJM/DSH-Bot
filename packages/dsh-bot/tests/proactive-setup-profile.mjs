import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const inject = ['loader', 'dshBots', 'credentials', 'sessionController', 'sessions', 'llm'];
class SetupAdapter extends LlmAdapter {
  async listModels(provider) { return [{provider,id:'fixture',name:'Synthetic setup conversation'}]; }
  async *stream() {
    yield {type:'block-start',index:0,blockType:'text'};
    yield {type:'text-delta',index:0,text:'Synthetic avatar regression reply'};
    yield {type:'block-end',index:0,block:{type:'text',text:'Synthetic avatar regression reply'}};
    yield {type:'finish',reason:{kind:'stop'}};
  }
}
export function apply(ctx, config) {
  const bootId = randomUUID();
  ctx.effect(() => {
    const abort = new AbortController(); let modelCalls = 0, githubReads = 0, seededModelCalls = 0, seeding = true;
    const releaseAdapter = ctx.llm.registerAdapter(['dp-loopback'], new SetupAdapter());
    const release = ctx.on('agent/request', (_payload, next) => { if (seeding) {seededModelCalls++;return next();} modelCalls++; throw new Error('Setup must not invoke a model'); });
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://api.github.com/')) {
        githubReads++; assert.equal(options?.method ?? 'GET', 'GET');
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return previous(url, options);
    };
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      await ctx.credentials.set('GITHUB_TOKEN', 'synthetic-setup-only');
      if (!(await ctx.dshBots.list()).some(bot => bot.id === 'setup-bot')) await ctx.dshBots.create({ id: 'setup-bot', name: 'Setup verification', template: 'minimal' });
      while (!ctx.dshBots.mainSessions) await delay(20, undefined, { signal: abort.signal });
      const identityPath = join(config.outputDir, 'setup-session.json');
      const previousSession = await readFile(identityPath, 'utf8').then(JSON.parse).catch(() => undefined);
      const main = previousSession ?? await ctx.dshBots.openConversation('setup-bot');
      if (!main.historical) {
        const workspace = await ctx.dshBots.ensureBotsWorkspace();
        main.historical = (await ctx.sessionController.create({ workspaceId: workspace.workspaceId, agentPreset: 'bot-setup-bot' })).sessionId;
      }
      await writeFile(identityPath, JSON.stringify(main));
      const agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent;
      assert.ok(agent, 'Setup fixture must retain an existing native Bot agent');
      for (const id of [main.sessionId, main.historical]) {
        const current = (await ctx.sessionController.resolveAgent(id)).agent;
        assert.ok(current);
        if (!current.session.snapshotEvents().some(event => event.type === 'turn/start')) {
          await ctx.sessionController.prompt({sessionId:id, requestId:`setup-seed-${id}`, mode:'queue', content:[{type:'text',text:'Synthetic avatar regression history'}]}, abort.signal);
          await current.whenIdle();
          assert.equal(await ctx.sessions.flush(current.session), true);
        }
      }
      const bot = await ctx.dshBots.get('setup-bot');
      await ctx.dshBots.recordActivity({ sessionId: main.sessionId, botId: bot.id, expectedBotCreatedAt: bot.createdAt,
        role: 'assistant', text: 'Synthetic existing conversation', at: Date.now() });
      await ctx.dshBots.recordActivity({ sessionId: main.historical, botId: bot.id, expectedBotCreatedAt: bot.createdAt,
        role: 'assistant', text: 'Synthetic historical conversation', at: Date.now() });
      seeding = false;
      console.log('B4_WEB_READY');
      while (!abort.signal.aborted) {
        const status = await ctx.get('dshBotProactive')?.status();
        const botStatuses = await ctx.dshBots.status();
        const activity = await ctx.dshBots.listActivity();
        const conversation = { expected: main.sessionId, main: botStatuses.find(row => row.id === bot.id)?.mainSessionId,
          activity: activity.sessions.some(row => row.sessionId === main.sessionId), historical: main.historical, historicalVisible: activity.sessions.some(row => row.sessionId === main.historical) };
        await writeFile(join(config.outputDir, 'setup-native.json'), JSON.stringify({ bootId, conversation, state: status?.state, directExecution: status?.capabilities.directExecution, source: status?.localFeedScope, feed: status?.localFeed, modelCalls, seededModelCalls, githubReads }));
        await delay(100, undefined, { signal: abort.signal });
      }
    })().catch(error => { if (!abort.signal.aborted) console.error('B4_WEB_FAILED', error); });
    return async () => { abort.abort(); release(); releaseAdapter(); globalThis.fetch = previous; await run; };
  });
}
