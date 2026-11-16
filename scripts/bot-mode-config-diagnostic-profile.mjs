import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export const name = 'bot-mode-config-diagnostic';
export const inject = ['loader', 'configEditor', 'dshBots'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const task = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      for (let attempt = 0; !ctx.dshBots.supergroup && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      const rows = ctx.configEditor.configuration().filter(row => row.entry.options.id === 'dsh-bot').map(row => ({
        id: row.entry.options.id, name: row.entry.options.name, raw: row.entry.options.config?.supergroup,
        inherited: row.inherited.supergroup, override: row.override.supergroup,
        active: row.entry.fiber?.state, uid: row.entry.fiber?.uid,
      }));
      const initial = ctx.dshBots.supergroup.settings();
      const off = await ctx.dshBots.supergroup.configure({ enabled: false, expectedEnabled: initial.enabled });
      const on = await ctx.dshBots.supergroup.configure({ enabled: true, expectedEnabled: off.enabled });
      const result = { status: 'PASS', rows, initial, off, on, registry: ctx.dshBots.config.supergroup, settings: ctx.dshBots.supergroup.settings() };
      await writeFile(resolve(config.outputDir, 'result.json'), JSON.stringify(result, null, 2));
      console.log('B03_CONFIG_DONE');
    })().catch(async error => { await writeFile(resolve(config.outputDir, 'result.json'), JSON.stringify({ status: 'FAIL', error: String(error), stack: error.stack })); console.log('B03_CONFIG_FAILED'); });
    return async () => { await task; };
  });
}
