import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';
export const name = 'bot-screenshot-fixture';
export const inject = ['loader', 'dshBots', 'dshBotGroups', 'dshBotConnectors', 'dshBotNotifications', 'dshBotCollaborationRemote', 'dshBotReferenceMemory'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let team;
    let stopping = false;
    const run = (async () => {
      await ctx.loader.await();
      const bots = [];
      for (const [id, name] of [['assistant', 'Assistant'], ['researcher', 'Research Assistant']]) {
        bots.push(await ctx.dshBots.create({ id, name, template: 'minimal', persona: { prefix: 'Synthetic screenshot fixture. Use no tools.' } }));
        await ctx.dshBots.openConversation(id);
      }
      const keys = bots.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt }));
      await ctx.dshBots.memoryFor('assistant').save({ content: 'Prefers clear, concise research summaries.', kind: 'preference', tags: ['demo'], pinned: true }, { by: 'user', at: Date.now() });
      await ctx.dshBotConnectors.saveDefinition({ id: 'sample', label: 'Example MCP connector', serverName: 'sample', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
      await ctx.dshBotNotifications.savePolicy({ id: 'local', owner: keys[0], channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
      await ctx.dshBotNotifications.record(keys[0], { operationId: 'screenshot', policyId: 'local', text: 'Research summary is ready to review.' }, { kind: 'tool', id: 'synthetic-screenshot' });
      team = ctx.plugin(TeamService, {});
      await team.await();
      await ctx.dshBotCollaborationRemote.ensure(keys[0], 0);
      await ctx.dshBotCollaborationRemote.createTask(keys[0], { subject: 'Review research summary', description: 'Compare the two synthetic summaries.', blockedBy: [] });
      const group = await ctx.dshBotGroups.create({ operationId: 'screenshot', name: 'Research group', mode: 'round-robin', members: keys, historyConfirmed: true });
      const groupKey = { groupId: group.id, groupCreatedAt: group.createdAt };
      await ctx.dshBotGroups.send(groupKey, { operationId: 'screenshot-round', expectedMembershipRevision: 1, text: 'Compare the research approaches for this synthetic example.', round: true });
      const deadline = Date.now() + 30000;
      let view;
      do { view = await ctx.dshBotGroups.view(groupKey); if (view.turns.every(t => t.state === 'completed')) break; await new Promise(r => setTimeout(r, 25)); } while (!stopping && Date.now() < deadline);
      assert.ok(view.turns.every(t => t.state === 'completed'));
      await ctx.dshBotReferenceMemory.request({ action: 'configure', bot: keys[0], mode: 'internal+reference-graph', expectedRevision: 0 });
      await writeFile(join(config.outputDir, 'fixture.json'), JSON.stringify({ status: 'PASS', bots: bots.map(b => b.id), groupId: group.id }));
      console.log('V03_SCREENSHOT_READY');
    })().catch(async error => {
      await writeFile(join(config.outputDir, 'fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('V03_SCREENSHOT_FAILED');
    });
    return async () => { stopping = true; await run; await team?.dispose(); };
  });
}
