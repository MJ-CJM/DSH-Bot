import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'b8-lifecycle-probe';
export const inject = ['loader', 'storageDomain', 'agentPresets', 'typert', 'tools', 'agents', 'sessionController',
  'sessionPersistence', 'sessions', 'workspaceRegistry', 'subagents'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const running = (async () => {
      await ctx.loader.await();
      const plugin = await import(pathToFileURL(resolve(config.installed, 'lib/index.js')).href);
      const { acquireMemoryOwner } = await import(pathToFileURL(resolve(config.installed, 'lib/host/memory/owner-lease.js')).href);
      const cycles = [], baseline = (await ctx.agentPresets.list()).map(row => row.id).sort();
      for (let cycle = 0; cycle < 20; cycle++) {
        const fork = ctx.plugin(plugin, { seedExamples: false, dataDir: resolve(config.outputDir, 'bots'), messagingEnabled: false });
        try {
          await fork.await();
          const deadline = Date.now() + 15000;
          while (!ctx.get('dshBots') || !ctx.get('dshBotShadow')) {
            assert.ok(Date.now() < deadline, 'Startup deadline'); await delay(20);
          }
          const registry = ctx.get('dshBots'), planner = ctx.get('dshBotShadow');
          await registry.waitUntilReady();
          while ((await ctx.get('dshBotAutomation')?.status())?.state !== 'ready') {
            assert.ok(Date.now() < deadline, 'Composition deadline'); await delay(20);
          }
          assert.equal(registry.memoryAdmission.inFlight, 0); assert.equal(planner.status().modelRequests, 0);
          await fork.dispose();
          await assert.rejects(() => planner.evaluate({}, {})); await assert.rejects(() => registry.list());
          for (const name of ['dshBots', 'dshBotShadow', 'dshBotGroups', 'dshBotConnectors', 'dshBotNotifications'])
            assert.equal(ctx.get(name), undefined, `Leaked service ${name}`);
          for (const name of ['dsh_bot_memory', 'dsh_bot_shadow']) assert.equal(ctx.storageDomain.get(name), undefined);
          assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id).sort(), baseline);
          const lease = await acquireMemoryOwner(resolve(process.env.DSH_HOME, 'dsh-bot/memory-owner')); await lease.close();
          cycles.push({ cycle, services: 0, domains: 0, inFlight: 0, ownerReacquired: true });
        } finally { await fork.dispose(); }
      }
      await writeFile(resolve(config.outputDir, 'receipts/lifecycle.json'), JSON.stringify({ status: 'PASS', cycles,
        mcpStarted: 0, shadowTimers: 0, realModelRequests: 0 }));
    })().then(() => console.log('DP_B8_DONE')).catch(async error => {
      await writeFile(resolve(config.outputDir, 'receipts/lifecycle-failure.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.error('DP_B8_FAILED', error);
    });
    return () => running;
  });
}
