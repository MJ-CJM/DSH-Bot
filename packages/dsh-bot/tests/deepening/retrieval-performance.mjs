import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { openMemoryKernel } from '../../lib/host/memory/open-v2.js';
import { memoryContext } from '../../lib/host/memory/context.js';
import { rankFacts, readableFacts } from '../../lib/host/memory/query.js';
import { BotStore } from '../../lib/host/stores/bots.js';
import { botDomain } from '../../lib/host/stores/domain.js';
const root = process.cwd();
assert.equal(process.env.DSH_HOME, resolve(root, '.dsh-dev'));
assert.ok(process.argv[2], 'Pass the existing synthetic benchmark seed directory');
const source = resolve(process.argv[2]);
assert.ok(source.startsWith(`${root}/.dsh-dev/deepening/b5-performance-`));
const seed = JSON.parse(await readFile(join(source, 'seed.json')));
assert.equal(seed.seeded, 10000);
const logMode = seed.ops === 10000 ? 'independent' : 'bootstrap';
const dir = resolve(process.argv[3] ?? resolve(root, `.dsh-dev/deepening/b5s/performance-${logMode}`));
assert.ok(dir.startsWith(`${root}/.dsh-dev/deepening/`));
await mkdir(dir, { recursive: true });
// Copy only synthetic benchmark data: never mutate a pre-existing benchmark or real profile.
const { cp } = await import('node:fs/promises');
await cp(join(source, 'storage'), join(dir, 'storage'), { recursive: true, force: false, errorOnExist: true });
const ctx = new Context(); let opened, botsDomain;
try {
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: join(dir, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  botsDomain = await ctx.storageDomain.open(botDomain);
  const bots = new BotStore(botsDomain); assert.equal(bots.list().length, 10);
  opened = await openMemoryKernel(ctx, join(dir, 'owner'), 'Asia/Shanghai');
  const k = opened.kernel; assert.equal(k.snapshot.versions.size, 10000); assert.equal(k.seq, seed.ops);
  const owners = bots.list().map(b => ({ botId: b.id, botCreatedAt: b.createdAt }));
  const now = Date.parse('2026-10-25T12:00:00Z');
  const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
  const providers = owners.map(b => memoryContext(k, b, policy, 20, () => now));
  const texts = providers.map(p => p());
  const queries = ['Synthetic', 'baseline', 'field 500', 'Synthetic 9876', '食品预算', 'unseen vocabulary'];
  const search = i => rankFacts(readableFacts(k, owners[i % owners.length], { at: now }), queries[i % queries.length], 5);
  const t0 = performance.now(); search(0); const firstSearchMs = performance.now() - t0;
  for (let i = 0; i < 200; i++) {
    providers[i % 10](); memoryContext(k, owners[i % 10], policy, 20, () => now)(); search(i);
  }
  const hits = [], recomputes = [], searches = [];
  for (let i = 0; i < 1000; i++) {
    let at = performance.now(); assert.equal(providers[i % 10](), texts[i % 10]); hits.push(performance.now() - at);
    at = performance.now(); assert.equal(memoryContext(k, owners[i % 10], policy, 20, () => now)(), texts[i % 10]);
    recomputes.push(performance.now() - at);
    at = performance.now(); search(i); searches.push(performance.now() - at);
  }
  const p95 = samples => samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  const summary = { source, mode: `actual JSON / npm rc.2 / copied synthetic ${logMode}`,
    memories: k.snapshot.versions.size, bots: bots.list().length, ops: k.seq, warmups: 200, samples: 1000,
    machine: { model: cpus()[0]?.model, platform: platform(), arch: arch(), node: process.version }, queries,
    // Permission filtering means each Bot sees 2000 shared + 800 owned = 2800 out of the stored 10000.
    readableRows: owners.map(b => readableFacts(k, b, { at: now }).length),
    firstSearchMs, searchP95ms: p95(searches), hitP95ms: p95(hits), recomputeP95ms: p95(recomputes),
    searchIncludes: 'temporalFacts + adjudicate + rankFacts; no result cache', hits, recomputes, searches };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, hits: undefined, recomputes: undefined, searches: undefined }));
  assert.ok(summary.hitP95ms <= 5, 'I33 cache hit p95 <=5ms');
  assert.ok(summary.recomputeP95ms <= 50, 'I33 recompute p95 <=50ms');
} finally { await opened?.close(); await botsDomain?.close(); await ctx.fiber.dispose(); }
