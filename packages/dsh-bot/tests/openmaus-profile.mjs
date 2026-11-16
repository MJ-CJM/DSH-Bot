// Real official Host composition, deterministic adapters, product services only.
import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { verify as recipes } from './openmaus-recipes-host.mjs';
import { verify as followup } from './openmaus-followup-host.mjs';
import { verify as p0 } from './openmaus-p0-host.mjs';

export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'sessionPersistence', 'configEditor', 'typertGateway', 'agentPresets', 'subagents', 'credentials', 'dshBotConnectors', 'clientModules'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), releases = [], calls = [], results = {}, synthetic = {};
    const save = (name, value) => writeFile(resolve(config.outputDir, name), JSON.stringify(value, null, 2));
    let phase = 'startup';
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'OpenMaus deterministic local fixture' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'OpenMaus deterministic local fixture' }; }
      async *stream(options) {
        calls.push({ sessionId: options.sessionId, at: Date.now() });
        const scripted = synthetic.reply?.(options, ctx);
        if (scripted) { yield* scripted; return; }
        const text = 'OPENMAUS_LOCAL_CHECKED: synthetic result with no external request.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const timer = setTimeout(() => lifetime.abort(new Error(`OpenMaus deadline at ${phase}`)), 240000);
    const task = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      const readyDeadline = Date.now() + 30000;
      while (!ctx.get('dshBotGroups') || !ctx.get('dshBotProactive') || !ctx.get('dshBotConnectors') || !ctx.dshBots.supergroup) {
        lifetime.signal.throwIfAborted(); assert.ok(Date.now() < readyDeadline, 'Product service registration deadline');
        await delay(25, undefined, { signal: lifetime.signal });
      }
      assert.deepEqual(ctx.llm.listProviders(), [], 'No real provider is configured');
      const adapter = new Adapter(); adapter.ctx = ctx;
      releases.push(ctx.llm.registerAdapter(['openmaus-local'], adapter));
      const productConfig = { ...config, provider: 'openmaus-local', model: 'fixture', releases, signal: lifetime.signal, modelCalls: () => calls.length, synthetic };
      for (const [name, verify] of [['recipesRouting', recipes], ['followupMemory', followup], ['materialsResume', p0]]) {
        if (config.phases && !config.phases.includes(name)) continue;
        phase = name; console.log(`OPENMAUS_PHASE ${phase}`);
        results[name] = await verify(ctx, productConfig);
        assert.equal(results[name].status, 'PASS'); await save(`openmaus-${name}.json`, results[name]);
      }
      clearTimeout(timer);
      const resources = {};
      const productPackageName = config.productPackageName ?? JSON.parse(await readFile(resolve(config.installedRoot, 'package.json'), 'utf8')).name;
      assert.ok(['dsh-bot', 'dsh-botgroup'].includes(productPackageName), 'Unexpected product package identity');
      for (const id of [productPackageName, '@deepseek-ai/dsh-client-shortcuts', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-renderer']) {
        const path = ctx.clientModules.clientPath(id); assert.ok(path, `${id} Client not composed`);
        const bytes = await readFile(path);
        resources[id] = { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      }
      assert.equal(resources[productPackageName].path, resolve(config.installedRoot, 'lib/client.js'));
      await save('client-provenance.json', resources);
      await save('openmaus-host.json', { status: 'PASS', results, syntheticModelRequests: calls.length, modelCalls: calls, realModelRequests: 0 });
      console.log('OPENMAUS_READY');
      // Browser actions continue against this exact real Host, and a fresh owner
      // observation is persisted when they mutate domains. No browser mocks.
      const observe = () => { void save('openmaus-browser-observer.json', { at: Date.now(), syntheticModelRequests: calls.length, realModelRequests: 0 }); };
      releases.push(ctx.on('domain/changed', observe));
      observe();
    })().catch(async error => {
      clearTimeout(timer); await save('openmaus-error.json', { status: 'FAIL', phase, results, error: String(error.stack), modelCalls: calls, realModelRequests: 0 });
      console.error('OPENMAUS_FAILED', error);
    });
    return async () => { lifetime.abort(); clearTimeout(timer); for (const release of releases.reverse()) await release(); await task; };
  }, 'dsh-bot: OpenMaus frozen-package integration');
}
