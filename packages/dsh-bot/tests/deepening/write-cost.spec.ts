import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Storage, { storageBackendServiceKey, type StorageBackend } from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { memoryDomain } from '../../src/host/memory/domain-v2.js';
import { MemoryKernel } from '../../src/host/memory/op-log.js';
import { command } from './v2-fixtures.js';
import { required } from '../fixtures/required.js';

it('keeps kernel single-write CPU median at 5000 ops within twice the median at 500 ops', async () => {
  const ctx = new Context(), early: number[] = [], late: number[] = [];
  // UNIT isolates algorithmic growth from filesystem fsync jitter; H measures actual JSON durability separately.
  const backend: StorageBackend = { close: async () => {}, kv: { open: async descriptor => {
    const tables = Object.fromEntries(descriptor.tables.map(name => [name, {} as Record<string, unknown>]));
    return { loadAll: async () => ({ tables, global: null }), close: async () => {}, setGlobal: async () => {},
      putRecord: async (table, key, value) => { required(tables[table])[key] = value; },
      deleteRecord: async (table, key) => { delete required(tables[table])[key]; } };
  } } };
  await ctx.plugin(Storage).await();
  const unregister = ctx.storage.backend.register('memory', backend);
  ctx.provide(storageBackendServiceKey('memory'), backend);
  await ctx.plugin(Domain, { backend: 'memory' }).await();
  const kernel = new MemoryKernel(await ctx.storageDomain.open(memoryDomain), () => {}), f = { kernel };
  await kernel.recover();
  try {
    for (let n = 0; n < 5100; n++) {
      const input = command(f, `WRITE_COST_${n}`), start = performance.now();
      await f.kernel.commit(input);
      const elapsed = performance.now() - start;
      if (n >= 500 && n < 600) early.push(elapsed);
      if (n >= 5000) late.push(elapsed);
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[50] ?? Infinity;
    const ratio = median(late) / median(early), dir = resolve('../../.dsh-dev/deepening/b5-rework-2');
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'write-regression.json'), JSON.stringify({ early, late,
      at500P50ms: median(early), at5000P50ms: median(late), ratio, ops: f.kernel.seq,
      level: 'UNIT / public storage-domain with test-owned in-memory backend; disk writes measured by H' }, null, 2));
    expect(f.kernel.seq).toBe(5100); expect(ratio).toBeLessThanOrEqual(2);
  } finally { await kernel.close(); unregister(); await ctx.fiber.dispose(); }
});
