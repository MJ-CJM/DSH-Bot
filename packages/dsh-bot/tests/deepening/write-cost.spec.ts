import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { threadCpuUsage } from 'node:process';
import { expect, it, type TestContext, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import Storage, { storageBackendServiceKey, type StorageBackend } from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { memoryDomain } from '../../src/host/memory/domain-v2.js';
import { MemoryKernel } from '../../src/host/memory/op-log.js';
import { command } from './v2-fixtures.js';
import { required } from '../fixtures/required.js';

async function openKernel({ onTestFinished }: TestContext, observeWrite?: (...event: string[]) => void) {
  const ctx = new Context();
  let kernel: MemoryKernel | undefined;
  onTestFinished(async () => {
    try { await kernel?.close(); } finally { await ctx.fiber.dispose(); }
  });
  const backend: StorageBackend = { close: async () => {}, kv: { open: async descriptor => {
    const tables = Object.fromEntries(descriptor.tables.map(name => [name, {} as Record<string, unknown>]));
    return { loadAll: async () => ({ tables, global: null }), close: async () => {},
      setGlobal: async () => { observeWrite?.('global'); },
      putRecord: async (table, key, value) => { observeWrite?.('put', table, key); required(tables[table])[key] = value; },
      deleteRecord: async (table, key) => { observeWrite?.('delete', table, key); delete required(tables[table])[key]; } };
  } } };
  await ctx.plugin(Storage).await();
  ctx.effect(() => ctx.storage.backend.register('memory', backend));
  ctx.provide(storageBackendServiceKey('memory'), backend);
  await ctx.plugin(Domain, { backend: 'memory' }).await();
  kernel = new MemoryKernel(await ctx.storageDomain.open(memoryDomain), () => {});
  await kernel.recover();
  return kernel;
}

async function seed(kernel: MemoryKernel, count: number) {
  for (let i = 0; i < count; i++) await kernel.commit(command({ kernel }, 'WRITE_COST'));
}

const batchSize = 10;
async function sampleBatch(kernel: MemoryKernel): Promise<number> {
  // Prepare equal-size inputs outside the clock. Every proposal still uses its exact expected revision.
  const inputs = Array.from({ length: batchSize }, (_, i) => {
    const input = command({ kernel }, 'WRITE_COST');
    return { ...input, expectedRevision: input.expectedRevision + i,
      versions: input.versions.map(version => ({ ...version, commitSeq: version.commitSeq + i })) };
  });
  const start = threadCpuUsage();
  for (const input of inputs) await kernel.commit(input);
  const { user, system } = threadCpuUsage(start);
  return (user + system) / batchSize;
}

function median(samples: number[]): number {
  const sorted = samples.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return (required(sorted[Math.floor((sorted.length - 1) / 2)]) + required(sorted[middle])) / 2;
}

it('keeps the median CPU cost per kernel write at 5000 ops within twice the cost at 500 ops', async (test) => {
  const small = await openKernel(test), large = await openKernel(test), early: number[] = [], late: number[] = [];
  // Fill the larger history first to warm the path before either sample. Real JSON durability is measured by H.
  await seed(large, 5000);
  await seed(small, 500);
  for (let offset = 0; offset < 100; offset += batchSize) {
    if ((offset / batchSize) % 2 === 0) {
      early.push(await sampleBatch(small)); late.push(await sampleBatch(large));
    } else {
      late.push(await sampleBatch(large)); early.push(await sampleBatch(small));
    }
  }
  const at500MedianCpuUs = median(early), at5000MedianCpuUs = median(late);
  const ratio = at5000MedianCpuUs / at500MedianCpuUs, dir = resolve('../../.dsh-dev/deepening/b5-rework-2');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'write-regression.json'), JSON.stringify({ early, late, batchSize,
    at500MedianCpuUs, at5000MedianCpuUs, ratio, ops: { small: small.seq, large: large.seq },
    level: 'UNIT / thread CPU microseconds per write; public storage-domain with test-owned in-memory backend' }, null, 2));
  expect(small.seq).toBe(600);
  expect(large.seq).toBe(5100);
  expect(at500MedianCpuUs).toBeGreaterThan(0);
  expect(ratio).toBeLessThanOrEqual(2);
});

it('writes one payload then one op without traversing stored history or the versions projection', async (test) => {
  const writes = vi.fn(), kernel = await openKernel(test, writes);
  await seed(kernel, 8);
  writes.mockClear();
  const history = ['ops', 'payloads', 'projections'] as const;
  const scans = history.flatMap(name => {
    const table = kernel.domain.table(name);
    return [vi.spyOn(table, 'entries'), vi.spyOn(table, 'keys')];
  });
  // The map instance is immutable. Wrap the traversal API on its prototype for this commit only.
  const versions = Object.getPrototypeOf(kernel.snapshot.versions) as typeof kernel.snapshot.versions;
  const visits = [vi.spyOn(versions, Symbol.iterator), vi.spyOn(versions, 'entries'), vi.spyOn(versions, 'keys'),
    vi.spyOn(versions, 'values'), vi.spyOn(versions, 'forEach')];
  try {
    const input = command({ kernel }, 'WRITE_COST');
    await kernel.commit(input);
    expect(writes.mock.calls).toEqual([['put', 'payloads', required(input.versions[0]).contentRef], ['put', 'ops', input.opId]]);
    for (const scan of [...scans, ...visits]) expect(scan).not.toHaveBeenCalled();
  } finally {
    for (const scan of [...scans, ...visits]) scan.mockRestore();
  }
});
