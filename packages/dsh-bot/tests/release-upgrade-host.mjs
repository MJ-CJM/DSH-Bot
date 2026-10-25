import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'release-upgrade-probe';
export const inject = ['loader', 'dshBots', 'dshBotAutomation'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      const deadline = Date.now() + 30000;
      while ((await ctx.dshBotAutomation.status()).state !== 'ready') {
        assert.ok(Date.now() < deadline, 'Host composition did not become ready');
        await delay(25);
      }
      if (config.phase === 'old') {
        await ctx.dshBots.create({ id: 'upgrade-bot', name: 'Synthetic upgrade Bot', template: 'minimal',
          persona: { prefix: 'Synthetic upgrade fixture; no model prompts.' } });
        await ctx.dshBots.memoryFor('upgrade-bot').save({ content: 'Keep this synthetic pinned preference.',
          kind: 'preference', tags: ['upgrade'], pinned: true }, { by: 'user', at: Date.now() });
      }
      const modern = config.oldVersion !== '0.2.2';
      while (modern && !['dshBotGroups', 'dshBotConnectors', 'dshBotNotifications'].every(name => ctx.get(name))) {
        assert.ok(Date.now() < deadline, 'Modern services did not activate');
        await delay(25);
      }
      const groups = ctx.get('dshBotGroups');
      const connectors = ctx.get('dshBotConnectors');
      const notifications = ctx.get('dshBotNotifications');
      const key = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });
      if (modern && config.phase === 'old') {
        const first = await ctx.dshBots.get('upgrade-bot');
        const second = await ctx.dshBots.create({ id: 'upgrade-peer', name: 'Synthetic upgrade peer', template: 'minimal', persona: { prefix: 'No real models.' } });
        await groups.create({ operationId: 'upgrade-group', name: 'Keep synthetic group', mode: 'mention', members: [key(first), key(second)], historyConfirmed: true });
        await connectors.saveDefinition({ id: 'upgrade-connector', label: 'Synthetic disabled MCP', serverName: 'upgrade', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
        await notifications.savePolicy({ id: 'upgrade-policy', owner: key(first), channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
        await notifications.record(key(first), { operationId: 'upgrade-inbox', policyId: 'upgrade-policy', text: 'Preserve synthetic inbox.' }, { kind: 'tool', id: 'upgrade-fixture' });
      }
      const main = await ctx.dshBots.openConversation('upgrade-bot');
      const bots = await ctx.dshBots.list();
      const memories = await ctx.dshBots.memoryFor('upgrade-bot').list();
      const snapshot = { bots, memories, main, ...(modern ? { groups: await groups.list(), connectors: connectors.definitions(), policies: notifications.policies(), inbox: notifications.list() } : {}) };
      if (config.phase === 'new') {
        assert.deepEqual(snapshot, JSON.parse(await readFile(resolve(config.outputDir, 'old-state.json'))));
      }
      await writeFile(resolve(config.outputDir, `${config.phase}-state.json`), JSON.stringify(snapshot, null, 2));
      console.log('P34_UPGRADE_READY');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, `${config.phase}-error.json`), JSON.stringify({ error: String(error) }));
      console.log('P34_UPGRADE_FAILED');
    });
    return async () => { await run; };
  });
}
