import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inject, product } from './group-recall-native-profile.mjs';

export { inject };

export function apply(ctx, config) {
  ctx.effect(() => {
    const lifecycle = new AbortController(), { signal } = lifecycle;
    const counts = { sessionCreations: 0, agentCreations: 0, agentRequests: 0, modelStreams: 0 };
    const releases = [
      ctx.on('session/created', () => { counts.sessionCreations++; }),
      ctx.on('agent/created', () => { counts.agentCreations++; }),
      ctx.on('agent/request', (_payload, next) => { counts.agentRequests++; return next(); }),
      ctx.on('llm/stream', (_payload, next) => { counts.modelStreams++; return next(); }),
    ];
    const path = name => join(config.outputDir, name);
    const save = (name, payload) => writeFile(path(name), JSON.stringify(payload, null, 2));
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      const seeded = await product(ctx, { ...config, phase: 'product-warm', browser: true }, counts, releases, signal);
      const { alpha, rootSessionId, mainSessionId } = seeded.fixture;
      const users = async id => (await ctx.sessionQuery.readSession(id)).events
        .filter(row => row.type === 'user/message').map(row => row.data.id);
      const read = async () => ({ agentRequests: counts.agentRequests, modelStreams: counts.modelStreams,
        groupMessages: await users(rootSessionId), directMessages: await users(mainSessionId),
        memories: (await ctx.get('dshBots').memoryFor(alpha.botId).list()).map(row => row.id) });
      await save('recall-web-initial.json', { ...seeded, baseline: await read() });
      console.log('B4_WEB_READY');
      let last;
      while (!signal.aborted) {
        let request;
        try { request = JSON.parse(await readFile(path('recall-web-probe.json'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (request && request.id !== last) {
          assert.match(request.id, /^[a-z0-9-]+$/);
          last = request.id;
          await save(`recall-web-probe-${last}.json`, await read());
        }
        await delay(60, undefined, { signal });
      }
    })().catch(async error => {
      if (signal.aborted) return;
      await save('recall-web-error.json', { error: String(error), stack: error.stack });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => {
      lifecycle.abort();
      await run;
      for (const release of releases.reverse()) await release();
    };
  });
}
