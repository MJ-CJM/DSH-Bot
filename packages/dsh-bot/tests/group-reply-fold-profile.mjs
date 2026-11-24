import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'group-reply-fold-profile';
export const inject = ['loader', 'llm', 'agents', 'dshBots', 'dshBotGroups'];

export function apply(ctx, config) {
  return ctx.effect(() => {
    const counter = new Map();
    const lifetime = new AbortController();
    const guestId = 'reader-jarvis';
    const names = ['reader-alpha', 'reader-beta', 'reader-short', 'reader-late', guestId];
    class Synthetic extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Offline group reply' }]; }
      async *stream(options) {
        const agent = ctx.agents.get(options.sessionId);
        const name = names.find(id => agent?.session.header.agentPreset?.endsWith(id));
        assert.ok(name && agent.session.header.parentSession, 'Only synthetic group workers may call the fixture');
        const n = (counter.get(name) ?? 0) + 1;
        counter.set(name, n);
        if (name === 'reader-late') {
          const gate = resolve(config.outputDir, 'release-' + n);
          while (!existsSync(gate)) {
            lifetime.signal.throwIfAborted();
            await delay(30, undefined, { signal: options.signal });
          }
        }
        const text = name === 'reader-short' ? '已就绪。' : [
          '【迁移准备】',
          '**结论**：' + name + '-' + n + ' 已核对本轮目标，等待验收数据。',
          ...Array.from({ length: 34 }, (_, i) => name + '-' + n + ' 阅读锚点 ' + (i + 1) + '。核对步骤、版本和责任人后，记录本项的验收结果。'),
        ].join('\n\n');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    let release;
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      release = ctx.llm.registerAdapter(['fold-offline'], new Synthetic());
      await ctx.dshBots.waitUntilReady();
      const members = [];
      for (const name of names) {
        const bot = await ctx.dshBots.create({ id: name, name: name === guestId ? 'Jarvis' : name, template: 'minimal', memory: { enabled: false, injectLimit: 20 }, model: { provider: 'fold-offline', model: 'fixture' } });
        if (bot.id !== guestId) members.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      }
      const group = await ctx.dshBotGroups.create({ operationId: 'fold-acceptance-group', name: '群回复验收', members, historyConfirmed: true, mode: 'natural', onDemand: false });
      await writeFile(resolve(config.outputDir, 'fixture.json'), JSON.stringify({ rootSession: group.rootSessionId }));
      console.log('B4_WEB_READY');
      while (!existsSync(resolve(config.outputDir, 'request-public-followup'))) {
        await delay(50, undefined, { signal: lifetime.signal });
      }
      const key = { groupId: group.id, groupCreatedAt: group.createdAt };
      const view = await ctx.dshBotGroups.view(key);
      const completed = view.turns.find(turn => ['completed', 'idle'].includes(turn.state) && !turn.guestQuestion);
      const target = view.members.find(member => member.bot.botId === 'reader-short');
      assert.ok(completed && target, 'A completed ordinary turn and a current member are required for the owner follow-up');
      const choice = await ctx.dshBotGroups.ownerFollowUpChoice(key, completed.id, target.id);
      const accepted = await ctx.dshBotGroups.startOwnerFollowUp(key,
        { operationId: 'reading-follow-up', text: '请补充本轮的确认结果。' },
        { ...choice, cardId: 'reading-card', cardRevision: 1 }, async () => {}, async () => {});
      await writeFile(resolve(config.outputDir, 'public-followup.json'), JSON.stringify({ messageId: accepted.inputMessageId }));
    })().catch(async error => {
      if (lifetime.signal.aborted) return;
      await writeFile(resolve(config.outputDir, 'fixture-error.txt'), String(error.stack));
      console.log('B4_WEB_FAILED');
    });
    return async () => { lifetime.abort(); await run; release?.(); };
  }, 'offline group-reply test');
}
