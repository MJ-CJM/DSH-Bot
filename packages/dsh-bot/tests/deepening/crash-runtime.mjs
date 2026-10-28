import '../../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as Json from '@deepseek-ai/dsh-storage-json';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { openMemoryKernel } from '../../lib/host/memory/open-v2.js';
import { MemoryAdmission } from '../../lib/host/memory/admission.js';
import { migrationBotDomain } from '../../lib/host/stores/domain.js';
import { BotStore } from '../../lib/host/stores/bots.js';
import { crashMemory } from './crash-memory.mjs';
import { B6bAdapter, registerIsolatedAdapter } from './b6b-adapter.mjs';
const [window, phase, outputDir, nonce] = process.argv.slice(2);
assert.ok(resolve(outputDir).startsWith(`${resolve('.dsh-dev/deepening')}/`));
const config = { window, phase, outputDir, nonce, level: 'NPM_RC2_SERVICE_PROCESS / actual JSON' };
const ctx = new Context(); let opened, legacy;
try {
  await ctx.plugin(Storage).await(); await ctx.plugin(Json, { root: resolve(outputDir, 'storage') }).await();
  await ctx.plugin(Domain, { backend: 'json' }).await();
  legacy = await ctx.storageDomain.open(migrationBotDomain);
  const bots = new BotStore(legacy);
  if (!bots.list().length) await bots.create({ id: 'alpha', name: 'Alpha' }, 1);
  opened = await openMemoryKernel(ctx, resolve(outputDir, 'owner'), 'UTC');
  const detail = await crashMemory({ kernel: opened.kernel, legacy }, config);
  if (opened.kernel.blocked) {
    await ctx.plugin(LlmRuntime).await();
    const admission = new MemoryAdmission(ctx), adapter = new B6bAdapter();
    const off = registerIsolatedAdapter(ctx.llm, adapter); admission.start(opened.kernel);
    try {
      await assert.rejects(async () => {
        for await (const _ of ctx.llm.stream({ provider: 'dp-b6b', model: 'fixture', purpose: 'compaction',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'B7_CRASH_CANARY' }] }] })) {}
      }, /blocked/i);
      assert.equal(adapter.requests, 0); detail.blockedAdapterRequests = 0;
    } finally { await admission.close(); off(); }
  }
  await writeFile(resolve(outputDir, 'recovery.json'), JSON.stringify({ status: 'PASS', pid: process.pid, ...config, ...detail }, null, 2),
    { flag: 'wx' });
  console.log('DP_B7_DONE');
} finally { await opened?.close(); await legacy?.close(); await ctx.fiber.dispose(); }
