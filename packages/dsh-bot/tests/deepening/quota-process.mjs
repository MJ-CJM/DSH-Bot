import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { openBotStores } from '../../lib/host/store.js';
import { AutoShareQuota } from '../../lib/host/memory/quota.js';
import { retireShard } from '../../lib/host/memory/shards.js';
import { memoryVersionSchema } from '../../lib/shared/memory-v2.js';
const [phase, root] = process.argv.slice(2), repo = fileURLToPath(new URL('../../../../', import.meta.url));
assert.ok(['seed', 'cold'].includes(phase)); assert.ok(resolve(root).startsWith(resolve(repo, '.dsh-dev') + '/'));
const ctx = new Context(); let stores;
try {
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: join(root, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  stores = await openBotStores(ctx, { memoryV2: { dataDir: join(root, 'data'), timeZone: 'Asia/Shanghai' } });
  const kernel = stores.memoryKernel; assert.ok(kernel);
  const quota = new AutoShareQuota(kernel, () => Date.parse('2026-10-27T12:00:00Z'));
  if (phase === 'seed') {
    await stores.bots.create({ id: 'alpha', name: 'Synthetic Alpha' }, 1);
    await quota.configureHost({ enabled: true, botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai' });
  } else {
    assert.equal(kernel.snapshot.quota.size, 5);
    const old = stores.bots.get('alpha'); await retireShard(kernel, { botId: old.id, botCreatedAt: old.createdAt });
    await stores.bots.remove('alpha'); await stores.bots.create({ id: 'alpha', name: 'New synthetic Alpha' }, 99);
  }
  const bot = stores.bots.get('alpha'), owner = { botId: bot.id, botCreatedAt: bot.createdAt };
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => {
    const opId = randomUUID();
    return quota.commit(opId, owner, kernel.policyRevision, () => {
      const memoryId = randomUUID(), contentRef = randomUUID();
      const version = memoryVersionSchema.parse({ schemaVersion: 2, memoryId, versionId: randomUUID(), contentRef,
        revision: 1, commitSeq: kernel.seq + 1, userScope: kernel.scope.scope.id,
        scope: 'shared', shard: owner, kind: 'user_fact', recordedAt: 100, sourceRefs: [],
        provenance: { channel: 'model', bot: owner }, trust: 'candidate', status: 'active',
        labels: { readers: 'shared', originTrust: 'candidate', sourceVersions: [], restrictions: ['no-egress'], grants: [] } });
      return { opId, kind: 'accept', owner, subjectIds: [memoryId], versions: [version],
        expectedRevision: kernel.seq, forgetEpoch: kernel.epoch,
        payloads: { [contentRef]: { content: 'SYNTHETIC_ACCOUNTING_ONLY', valid: { from: null, to: null, basis: 'unknown' } } } };
    });
  }));
  const accepted = results.filter(r => r.status === 'fulfilled').length;
  assert.equal(accepted, phase === 'seed' ? 5 : 0); assert.equal(kernel.snapshot.quota.size, 5);
  console.log(JSON.stringify({ phase, pid: process.pid, accepted, charged: kernel.snapshot.quota.size, birth: bot.createdAt,
    realModelRequests: 0, evidence: 'npm rc.2 new process / real JSON / synthetic accounting' }));
} finally { await stores?.close(); await ctx.fiber.dispose(); }
