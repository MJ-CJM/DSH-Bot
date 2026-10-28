import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { expect, it, vi } from 'vitest';
import { memoryDomain } from '../../src/host/memory/domain-v2.js';
import { MemoryKernel } from '../../src/host/memory/op-log.js';
import { openMemoryDomain } from '../../src/host/memory/layout-upgrade.js';
import { annotatedFact } from './shared-fixtures.js';

async function fixture() {
  const base = resolve('../../.dsh-dev/deepening/b5-rework-2'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'layout-')), ctx = new Context();
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: join(dir, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  const old = await ctx.storageDomain.open({ ...memoryDomain, layout: 'single' }), kernel = new MemoryKernel(old, () => {});
  await kernel.recover();
  const fact = annotatedFact({ id: 'layout', content: 'LAYOUT_CANARY', scope: 'shared', trust: 'user_confirmed', from: null,
    to: null, basis: 'unknown', seq: 1, kind: 'user_fact', subject: 'user', factKey: 'city', qualifiers: {} });
  fact.version.userScope = kernel.scope.scope.id;
  await kernel.commit({ opId: randomUUID(), kind: 'accept', expectedRevision: 0, forgetEpoch: 0,
    subjectIds: [fact.version.memoryId], versions: [fact.version], payloads: { [fact.version.contentRef]: fact.payload } });
  await kernel.close();
  return { ctx, fact, async close() { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
it('recopies an interrupted native layout bootstrap before using it, and erases legacy payload copies', async () => {
  const f = await fixture();
  try {
    const partial = await f.ctx.storageDomain.open(memoryDomain);
    for (const key of partial.table('ops').keys()) await partial.table('ops').delete(key);
    await partial.close();
    const domain = await openMemoryDomain(f.ctx), kernel = new MemoryKernel(domain, () => {});
    await kernel.recover(); expect(kernel.seq).toBe(1);
    expect(kernel.snapshot.versions.has(f.fact.version.memoryId)).toBe(true);
    expect(domain.table('layout').get('upgrade')?.phase).toBe('ready'); await kernel.close();
    const legacy = await f.ctx.storageDomain.open({ ...memoryDomain, layout: 'single' });
    expect(legacy.table('payloads').size).toBe(0); expect(legacy.table('ops').size).toBe(0); await legacy.close();
    const reopened = await openMemoryDomain(f.ctx), restored = new MemoryKernel(reopened, () => {});
    await restored.recover(); expect(restored.seq).toBe(1); await restored.close();
  } finally { await f.close(); }
});
it('resumes after copied was durable but legacy erasure failed, without replaying old writes into the new medium', async () => {
  const f = await fixture(), original = f.ctx.storageDomain.open.bind(f.ctx.storageDomain);
  let failed = false, copies = 0;
  const spy = vi.spyOn(f.ctx.storageDomain, 'open').mockImplementation(async spec => {
    const domain = await original(spec);
    if (spec.layout === 'single' && !failed) {
      vi.spyOn(domain.table('payloads'), 'delete').mockImplementationOnce(async () => {
        failed = true; throw new Error('synthetic legacy erasure failure');
      });
    }
    if (spec.layout === 'per-record') {
      const table = domain.table('ops'), put = table.put.bind(table);
      vi.spyOn(table, 'put').mockImplementation(async (id, op) => { copies++; await put(id, op); });
    }
    return domain;
  });
  try {
    await expect(openMemoryDomain(f.ctx)).rejects.toThrow('legacy erasure failure');
    const before = copies, domain = await openMemoryDomain(f.ctx);
    expect(copies).toBe(before); expect(domain.table('layout').get('upgrade')?.phase).toBe('ready');
    const kernel = new MemoryKernel(domain, () => {}); await kernel.recover(); expect(kernel.seq).toBe(1); await kernel.close();
  } finally { spy.mockRestore(); await f.close(); }
});
