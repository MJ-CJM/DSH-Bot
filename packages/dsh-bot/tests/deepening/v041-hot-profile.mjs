import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
export const name = 'v041-hot-probe';
export const inject = ['loader', 'storageDomain', 'agentPresets', 'typert', 'tools', 'agents', 'sessionController',
  'sessionPersistence', 'sessions', 'workspaceRegistry', 'subagents'];
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
      const save = (name, value) => writeFile(resolve(config.outputDir, name), JSON.stringify(value, null, 2));
      const wait = async name => {
        const deadline = Date.now() + 80000;
        while (await access(resolve(config.outputDir, name)).then(() => false, () => true)) {
          assert.ok(!stopping && Date.now() < deadline, `Waiting for ${name}`); await delay(25);
        }
      };
      const url = path => pathToFileURL(resolve(config.hot, 'package', path)).href;
      const old = await import(url('lib/index.js'));
      fork = ctx.plugin(old, { seedExamples: false, dataDir: resolve(config.outputDir, 'bots'), messagingEnabled: false });
      await fork.await();
      const deadline = Date.now() + 30000;
      while (!ctx.get('dshBots')) { assert.ok(Date.now() < deadline); await delay(20); }
      const registry = ctx.get('dshBots'); await registry.waitUntilReady();
      await registry.create({ id: 'hot-synthetic', name: 'Synthetic hot upgrade', template: 'minimal',
        persona: { prefix: 'No sessions or models.' } });
      await registry.memoryFor('hot-synthetic').save({ content: 'SYNTHETIC_HOT_PRESERVE', pinned: true });
      // Unload the old plugin only; the Host PID and its ESM cache survive both installations.
      await fork.dispose(); fork = undefined;
      const before = await digest(resolve(config.outputDir, 'storage'));
      assert.ok(Object.keys(before).length > 0);
      await save('hot-ready.json', { pid: process.pid, oldActivated: true, before });
      await wait('installed-040.json');
      let reproduction;
      await assert.rejects(import(`${url('lib/shared/memory-v2.js')}?link-reproduction`), error => {
        assert.match(error.message, /does not provide an export named 'memoryFields'/);
        reproduction = String(error); return true;
      });
      await save('reproduced.json', { pid: process.pid, reproduction });
      await wait('installed-041.json');
      const modern = await import(`${url('lib/index.js')}?v041-bootstrap`);
      assert.equal(modern.VERSION, '0.4.1'); assert.deepEqual(modern.inject, []);
      let message;
      assert.throws(() => modern.apply(ctx, {}), error => {
        message = error.message;
        assert.match(message, /请完全退出并重新打开 DSH/); assert.match(message, /Fully quit and reopen DSH/);
        assert.doesNotMatch(message, /SyntaxError|memoryFields/); assert.equal(error.cause, undefined); return true;
      });
      const after = await digest(resolve(config.outputDir, 'storage')); assert.deepEqual(after, before);
      assert.equal(ctx.get('dshBots'), undefined);
      await save('hot-result.json', { status: 'PASS', pid: process.pid, oldActivated: true, reproduction,
        message, storageUnchanged: true, before, after, realModelRequests: 0,
        installation: 'CLI tarball install + fixed canonical deployment copy; not native HMR/UI proof' });
    })().then(() => console.log('DP_V041_DONE')).catch(async error => {
      await writeFile(resolve(config.outputDir, 'hot-failure.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.error('DP_V041_FAILED', error);
    });
    return async () => { stopping = true; await running; await fork?.dispose(); };
  });
}
