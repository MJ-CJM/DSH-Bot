import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { memoryDomain } from '../../lib/host/memory/domain-v2.js';
import { MemoryKernel } from '../../lib/host/memory/op-log.js';
import { applyOp } from '../../lib/host/memory/projection.js';

const dir = resolve('.dsh-dev/deepening/b5-rework-2/profile');
assert.equal(process.env.DSH_HOME, resolve('.dsh-dev'));
await mkdir(resolve(dir, 'storage'), { recursive: true });
await copyFile(resolve('.dsh-dev/deepening/b5-rework-2/baseline-memory.json'), resolve(dir, 'storage/dsh_bot_memory.json'));
const ctx = new Context(); let kernel;
try {
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: resolve(dir, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  // Keep this diagnostic on the public single layout even after the product switches layout.
  // The saved pre-change CPU profile is historical; rerunning uses the current kernel code.
  let start = performance.now();
  kernel = new MemoryKernel(await ctx.storageDomain.open({ ...memoryDomain, layout: 'single' }), () => {});
  await kernel.recover(); const recoveryMs = performance.now() - start;
  const stages = {}, restores = [];
  for (const name of ['ops', 'payloads', 'projections', 'migration_items']) {
    const table = kernel.domain.table(name);
    for (const method of ['put', 'entries']) {
      const original = table[method];
      table[method] = method === 'put' ? async function (...args) {
        const at = performance.now(); try { return await original.apply(this, args); }
        finally { stages[`${name}.${method}`] = (stages[`${name}.${method}`] ?? 0) + performance.now() - at; }
      } : function (...args) {
        const at = performance.now(); try { return original.apply(this, args); }
        finally { stages[`${name}.${method}`] = (stages[`${name}.${method}`] ?? 0) + performance.now() - at; }
      };
      restores.push(() => { table[method] = original; });
    }
  }
  const seed = [...kernel.snapshot.versions.values()][0];
  const id = randomUUID(), ref = randomUUID();
  const version = { ...seed, memoryId: id, versionId: randomUUID(), contentRef: ref, commitSeq: kernel.seq + 1 };
  const op = { opId: randomUUID(), seq: kernel.seq + 1, kind: 'accept', subjectIds: [id],
    versions: [version], payloadRefs: [ref], receiptRefs: [], expectedRevision: kernel.seq, forgetEpoch: kernel.epoch };
  start = performance.now(); applyOp(kernel.snapshot, op); const applyOpMs = performance.now() - start;
  start = performance.now();
  await kernel.commit({ ...op, payloads: { [ref]: { content: 'PROFILE_SYNTHETIC', valid: { from: null, to: null, basis: 'unknown' } } } });
  const commitMs = performance.now() - start;
  restores.forEach(restore => { restore(); });
  const result = { logOpsBefore: op.expectedRevision, recoveryMs, applyOpMs, commitMs, stages,
    remainingCpuMs: commitMs - Object.values(stages).reduce((a, b) => a + b, 0) };
  await writeFile(resolve(dir, 'timings.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await kernel?.close(); await ctx.fiber.dispose(); }
