import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'v041-hot-probe';
export const inject = ['loader', 'storageDomain', 'agentPresets', 'typert', 'tools', 'agents', 'sessionController',
  'sessionPersistence', 'sessions', 'workspaceRegistry', 'subagents', 'llm', 'webServer'];
async function digest(dir, base = dir, files = {}) {
  for (const item of await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) await digest(path, base, files);
    else files[relative(base, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return files;
}
export function apply(ctx, config) {
  let fork, stopping = false;
  ctx.effect(() => {
    const running = (async () => {
      await ctx.loader.await();
      assert.equal(ctx.llm.listProviders().length, 0, 'No real model providers');
      const save = (name, value) => writeFile(resolve(config.outputDir, name), JSON.stringify(value, null, 2));
      const wait = async name => {
        const deadline = Date.now() + 80000;
        while (await access(resolve(config.outputDir, name)).then(() => false, () => true)) {
          assert.ok(!stopping && Date.now() < deadline, `Waiting for ${name}`); await delay(25);
        }
      };
      const url = path => pathToFileURL(resolve(config.installed, path)).href;
      const activate = async plugin => {
        fork = ctx.plugin(plugin, { seedExamples: false, dataDir: resolve(config.outputDir, 'bots'), messagingEnabled: false });
        await fork.await();
        const deadline = Date.now() + 30000;
        while (!ctx.get('dshBots')) { assert.ok(!stopping && Date.now() < deadline, 'Registry absent'); await delay(20); }
        const registry = ctx.get('dshBots'); await registry.waitUntilReady();
        while ((await ctx.get('dshBotAutomation')?.status())?.state !== 'ready') {
          assert.ok(!stopping && Date.now() < deadline, 'Host composition not ready'); await delay(20);
        }
        return registry;
      };
      const installedVersion = async () => JSON.parse(await readFile(resolve(config.installed, 'package.json'))).version;
      const baseline = (await ctx.agentPresets.list()).map(row => row.id).sort();
      if (config.phase === 'cold') {
        const hot = JSON.parse(await readFile(resolve(config.outputDir, 'hot-result.json')));
        assert.notEqual(process.pid, hot.pid); assert.equal(await installedVersion(), '0.4.1');
        const modern = await ctx.loader.import(url('lib/index.js')); assert.equal(modern.VERSION, '0.4.1');
        const registry = await activate(modern);
        const ready = JSON.parse(await readFile(resolve(config.outputDir, 'hot-ready.json')));
        assert.deepEqual(await registry.list(), ready.bots);
        const memories = await registry.memoryFor('hot-synthetic').list();
        const mapping = registry.memoryKernel.domain.table('migration_items').get(ready.memories[0].id);
        assert.ok(mapping, 'Cold activation must migrate the legacy memory');
        assert.deepEqual(memories, ready.memories.map(row => ({ ...row, id: mapping.memoryId })));
        const migration = registry.memoryKernel.domain.table('migration').get('active');
        assert.equal(migration.phase, 'done'); assert.deepEqual(migration.counts, { source: 1, copied: 1, quarantined: 0 });
        await save('cold-result.json', { status: 'PASS', pid: process.pid, previousPid: hot.pid,
          version: modern.VERSION, installed: config.installed, bots: await registry.list(), memories, realModelRequests: 0 });
        return;
      }
      assert.equal(config.phase, 'hot'); assert.equal(await installedVersion(), '0.3.2');
      const old = await ctx.loader.import(url('lib/index.js'));
      const registry = await activate(old);
      await registry.create({ id: 'hot-synthetic', name: 'Synthetic hot upgrade', template: 'minimal',
        persona: { prefix: 'No sessions or models.' } });
      await registry.memoryFor('hot-synthetic').save({ content: 'SYNTHETIC_HOT_PRESERVE', pinned: true });
      const bots = await registry.list(), memories = await registry.memoryFor('hot-synthetic').list();
      // Unload only the plugin. The Host PID and ESM cache survive the actual pnpm installation.
      await fork.dispose(); fork = undefined;
      const before = await digest(resolve(config.outputDir, 'storage'));
      const otherData = async () => ({ bots: await digest(resolve(config.outputDir, 'bots')),
        sessions: await digest(resolve(config.outputDir, 'sessions')), owner: await digest(resolve(process.env.DSH_HOME, 'dsh-bot')) });
      const otherBefore = await otherData();
      assert.ok(Object.keys(before).length > 0);
      await save('hot-ready.json', { pid: process.pid, oldActivated: true, before, bots, memories,
        installed: config.installed, realpath: await realpath(config.installed) });
      await wait('installed-041.json'); assert.equal(await installedVersion(), '0.4.1');
      // Only the bootstrap gets a fresh URL; all business modules retain their real installed URLs and old cache.
      const modern = await ctx.loader.import(`${url('lib/index.js')}?v041-bootstrap`);
      assert.equal(modern.VERSION, '0.4.1'); assert.deepEqual(modern.inject, []);
      const stale = await import(url('lib/shared/schema.js'));
      assert.equal(stale.DSH_BOT_MODULE_VERSION, undefined, 'Real installed URL must retain the old schema namespace');
      const checkError = error => {
        assert.match(error.message, /请完全退出并重新打开 DSH/); assert.match(error.message, /Fully quit and reopen DSH/);
        assert.doesNotMatch(String(error), /SyntaxError|memoryFields|ERR_MODULE_NOT_FOUND|Cannot find package/);
        assert.equal(error.cause, undefined); return true;
      };
      // Exercise actual Cordis config/activation rejection, plus apply's defensive guard.
      let message;
      await assert.rejects(async () => {
        fork = ctx.plugin(modern, {}); await fork.await();
      }, error => { message = error.message; return checkError(error); });
      await fork?.dispose(); fork = undefined;
      assert.throws(() => modern.apply(ctx, {}), checkError);
      const after = await digest(resolve(config.outputDir, 'storage')); assert.deepEqual(after, before);
      const otherAfter = await otherData(); assert.deepEqual(otherAfter, otherBefore);
      assert.equal(ctx.get('dshBots'), undefined);
      for (const name of ['dsh_bot', 'dsh_bot_memory']) assert.equal(ctx.storageDomain.get(name), undefined);
      assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id).sort(), baseline);
      await save('hot-result.json', { status: 'PASS', pid: process.pid, oldActivated: true,
        message, storageUnchanged: true, before, after, otherBefore, otherAfter, realModelRequests: 0, installed: config.installed,
        installation: 'CLI pnpm add in the same profile node_modules; no deployment copy',
        activation: 'public loader.import fresh bootstrap URL + ctx.plugin; not native UI/HMR proof' });
    })().then(() => console.log('DP_V041_DONE')).catch(async error => {
      await writeFile(resolve(config.outputDir, `${config.phase}-failure.json`), JSON.stringify({ error: String(error), stack: error.stack }));
      console.error('DP_V041_FAILED', error);
    });
    return async () => { stopping = true; await running; await fork?.dispose(); };
  });
}
