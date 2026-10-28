import '../../../../scripts/deepening/network-guard.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryKernel } from '../../lib/host/memory/op-log.js';
import { memoryDomain } from '../../lib/host/memory/domain-v2.js';
import { migrationBotDomain } from '../../lib/host/stores/domain.js';
import { BotStore } from '../../lib/host/stores/bots.js';
import { B6bAdapter, registerIsolatedAdapter } from './b6b-adapter.mjs';
import { crashMemory, memoryWindows } from './crash-memory.mjs';
import { crashSurfaces } from './crash-surfaces.mjs';
import { crashScheduling } from './crash-scheduling.mjs';
export const name = 'dp-b7-crash-probe';
export const inject = ['loader', 'storageDomain', 'llm', 'dshBots', 'sessions', 'sessionController', 'sessionPersistence'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const adapter = new B6bAdapter(), lifetime = new AbortController(); let off, kernel, legacy;
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      off = registerIsolatedAdapter(ctx.llm, adapter);
      while (!ctx.dshBots.mainSessions || !ctx.dshBots.memoryForget) await delay(20, undefined, { signal: lifetime.signal });
      let detail;
      if (memoryWindows.includes(config.window)) {
        // Separate synthetic domains avoid injecting legacy rows into the production registry's completed migration.
        // The exact production MemoryKernel/migratePrivate run on actual native JSON within the real CLI Host.
        legacy = await ctx.storageDomain.open({ ...migrationBotDomain, name: 'dp_b7_legacy' });
        const bots = new BotStore(legacy); if (!bots.list().length) await bots.create({ id: 'alpha', name: 'Alpha' }, 1);
        kernel = new MemoryKernel(await ctx.storageDomain.open({ ...memoryDomain, name: 'dp_b7_memory' }), () => {});
        await kernel.recover('UTC');
        detail = await crashMemory({ kernel, legacy }, { ...config, level: 'CLI_HOST_SERVICE_FIXTURE' });
      } else if (['main-create', 'main-flush', 'schedule-delivery'].includes(config.window))
        detail = await crashScheduling(ctx, config, adapter);
      else detail = await crashSurfaces(ctx, config, adapter);
      await writeFile(resolve(config.outputDir, 'recovery.json'), JSON.stringify({ status: 'PASS', pid: process.pid,
        window: config.window, realModelRequests: 0, ...detail }, null, 2), { flag: 'wx' });
      console.log('DP_B7_DONE');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, `${config.phase}-failure.json`), JSON.stringify({ error: String(error), stack: error.stack }, null, 2));
      console.log('DP_B7_FAILED');
    });
    return async () => { lifetime.abort(); await run; off?.(); await kernel?.close(); await legacy?.close(); };
  });
}
