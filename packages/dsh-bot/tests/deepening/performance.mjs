import { ioProfile, profileTables } from './io-profile.mjs';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { rebuild } from '../../lib/host/memory/projection.js';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { openMemoryKernel } from '../../lib/host/memory/open-v2.js';
import { BotStore } from '../../lib/host/stores/bots.js';
import { botDomain } from '../../lib/host/stores/domain.js';
import { memoryContext } from '../../lib/host/memory/context.js';
import { memoryVersionSchema, payloadSchema } from '../../lib/shared/memory-v2.js';
const [mode, dir, outputDir = dir, logMode = 'bootstrap'] = process.argv.slice(2);
assert.ok(['bootstrap', 'independent'].includes(logMode));
assert.ok(['seed', 'measure', 'cold'].includes(mode)); assert.ok(dir.startsWith(`${process.cwd()}/.dsh-dev/`));
const ctx = new Context(); let opened, botsDomain;
const ready = performance.now();
try {
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: join(dir, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  const start = performance.now();
  botsDomain = await ctx.storageDomain.open(botDomain);
  const bots = new BotStore(botsDomain);
  if (mode !== 'cold' && !bots.list().length) for (let i = 0; i < 10; i++)
    await bots.create({ id: `bot-${i}`, name: `Synthetic Bot ${i}` }, i + 1);
  assert.equal(bots.list().length, 10);
  opened = await openMemoryKernel(ctx, join(dir, 'owner'), 'Asia/Shanghai');
  const recovered = performance.now() - start, runtimeReady = performance.now() - ready;
  const kernel = opened.kernel;
  profileTables(kernel);
  if (mode === 'seed') {
    let versions = [], payloads = {};
    const seedStart = performance.now(), now = Date.parse('2026-10-25T12:00:00Z');
    const writes = [], segments = [];
    const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    let segmentStart = seedStart;
    const startingOps = kernel.seq, startingMemories = kernel.snapshot.versions.size;
    assert.equal(startingOps, logMode === 'independent' ? startingMemories : 0);
    assert.ok(startingMemories <= 10000);
    console.log(JSON.stringify({ logMode, resumeFrom: startingMemories }));
    for (let i = startingMemories; i < 10000; i++) {
      const bot = { botId: `bot-${Math.floor(i / 1000)}`, botCreatedAt: Math.floor(i / 1000) + 1 };
      const shared = i % 5 === 0, id = randomUUID(), contentRef = randomUUID();
      versions.push(memoryVersionSchema.parse({ schemaVersion: 2, memoryId: id, versionId: randomUUID(), contentRef,
        userScope: kernel.scope.scope.id, revision: 1, commitSeq: logMode === 'independent' ? i + 1 : 1, kind: i % 20 === 0 ? 'user_event' : 'user_fact',
        recordedAt: now, sourceRefs: [{ entryReceiptId: randomUUID() }], provenance: { channel: 'management', bot },
        trust: 'user_confirmed', status: 'active', scope: shared ? 'shared' : 'private', shard: bot,
        ...(!shared ? { ownerBotKey: bot } : {}), labels: { readers: shared ? 'shared' : [bot],
          originTrust: 'user_confirmed', sourceVersions: [], restrictions: ['no-egress'], grants: [] } }));
      payloads[contentRef] = payloadSchema.parse({ content: `Synthetic ${i} ${'baseline '.repeat(12)}`, subject: 'user',
        factKey: `field-${i}`, valid: { from: now - 86400000, to: null, basis: 'explicit' } });
      if (logMode === 'independent' || i === 9999) {
        const writeStart = performance.now();
        await kernel.commit({ opId: randomUUID(), kind: 'accept', subjectIds: versions.map(v => v.memoryId),
          expectedRevision: kernel.seq, forgetEpoch: 0, versions, payloads });
        writes.push(performance.now() - writeStart);
        versions = []; payloads = {};
      }
      if ((i + 1) % 1000 === 0) {
        const samples = writes.slice(-1000);
        const segment = { through: i + 1, segmentMs: performance.now() - segmentStart,
          writeP50ms: percentile(samples, 0.5), writeP95ms: percentile(samples, 0.95) };
        segments.push(segment); segmentStart = performance.now();
        console.log(JSON.stringify({ logMode, ...segment }));
      }
    }
    const seed = { logMode, seeded: kernel.snapshot.versions.size, bots: 10, ops: kernel.seq,
      startingOps, startingMemories, commitPath: 'MemoryKernel.commit / public KvTable / actual JSON backend',
      seedMs: performance.now() - seedStart, writes, segments, ioProfile };
    assert.equal(seed.seeded, 10000); assert.equal(seed.ops, logMode === 'independent' ? 10000 : 1);
    await writeFile(join(dir, 'seed.json'), JSON.stringify(seed, null, 2));
  } else {
    assert.equal(kernel.snapshot.versions.size, 10000);
    assert.equal(kernel.seq, logMode === 'independent' ? 10000 : 1);
    const ops = [...kernel.domain.table('ops').entries()].map(([, op]) => op).sort((a, b) => a.seq - b.seq);
    assert.equal(ops.length, kernel.seq);
    for (const [index, op] of ops.entries()) {
      assert.equal(op.seq, index + 1); assert.equal(op.expectedRevision, index);
      assert.equal(op.versions.length, logMode === 'independent' ? 1 : 10000);
    }
    const rebuildStart = performance.now(), rebuilt = rebuild(kernel.domain);
    const rebuildMs = performance.now() - rebuildStart;
    assert.ok(isDeepStrictEqual(rebuilt, kernel.snapshot), 'Fresh replay must equal published state');
    const owners = bots.list().map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt }));
    const policy = { maxInjectChars: 4000, privateShare: 0.6, journalShare: 0.25, journalDays: 30 };
    const now = Date.parse('2026-10-25T12:00:00Z');
    const providers = owners.map(owner => memoryContext(kernel, owner, policy, 20, () => now));
    const texts = providers.map(provider => provider()), text = texts[0]; assert.ok([...text].length <= 4000); assert.ok(text.includes('Synthetic'));
    const hits = [], recomputes = [];
    if (mode === 'measure') {
      for (let i = 0; i < 200; i++) {
        providers[i % 10](); memoryContext(kernel, owners[i % 10], policy, 20, () => now)();
      }
      for (let i = 0; i < 1000; i++) {
        let at = performance.now(); assert.equal(providers[i % 10](), texts[i % 10]); hits.push(performance.now() - at);
        at = performance.now(); assert.equal(memoryContext(kernel, owners[i % 10], policy, 20, () => now)(), texts[i % 10]);
        recomputes.push(performance.now() - at);
      }
    }
    await writeFile(join(outputDir, `${mode}-${process.pid}.json`), JSON.stringify({ mode, logMode, recovered, runtimeReady, rebuildMs, hits, recomputes,
      memories: 10000, bots: 10, ops: kernel.domain.table('ops').size, textChars: [...text].length,
      replayEquivalent: true, level: 'npm rc.2 runtime / actual JSON backend' }));
  }
} finally { await opened?.close(); await botsDomain?.close(); await ctx.fiber.dispose(); }
