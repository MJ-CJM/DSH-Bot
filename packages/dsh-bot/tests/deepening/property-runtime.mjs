import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import { memoryDomain } from '../../lib/host/memory/domain-v2.js';
import { MemoryKernel } from '../../lib/host/memory/op-log.js';
import { rebuild } from '../../lib/host/memory/projection.js';
import { MemoryManagement } from '../../lib/host/memory/facade.js';
import { V2MemoryStore } from '../../lib/host/memory/store-v2.js';
import { botDomain } from '../../lib/host/stores/domain.js';
import { BotStore } from '../../lib/host/stores/bots.js';
import { ForgetPreviews } from '../../lib/host/memory/forget-preview.js';
import { ForgetRunner } from '../../lib/host/memory/forget-runner.js';
export const alpha = { botId: 'alpha', botCreatedAt: 1 }, beta = { botId: 'beta', botCreatedAt: 2 };
export async function propertyRuntime() {
  const ctx = new Context(), media = new Map();
  // UNIT persistence seam: JSON round trips, public Domain lifecycle, no socket or disk durability claim.
  const backend = { close: async () => {}, kv: { open: async descriptor => {
    if (!media.has(descriptor.name)) media.set(descriptor.name, Object.fromEntries(descriptor.tables.map(n => [n, {}])));
    const tables = media.get(descriptor.name);
    return { loadAll: async () => structuredClone({ tables, global: null }), close: async () => {}, setGlobal: async () => {},
      putRecord: async (name, key, value) => { tables[name][key] = JSON.parse(JSON.stringify(value)); },
      deleteRecord: async (name, key) => { delete tables[name][key]; } };
  } } };
  await ctx.plugin(Storage).await();
  const off = ctx.storage.backend.register('property-memory', backend);
  ctx.provide(storageBackendServiceKey('property-memory'), backend);
  await ctx.plugin(Domain, { backend: 'property-memory' }).await();
  const botData = await ctx.storageDomain.open(botDomain), bots = new BotStore(botData);
  await bots.create({ id: 'alpha', name: 'Alpha' }, 1); await bots.create({ id: 'beta', name: 'Beta' }, 2);
  let kernel;
  const open = async () => {
    kernel = new MemoryKernel(await ctx.storageDomain.open(memoryDomain), () => {}); await kernel.recover('UTC');
  };
  await open();
  return { ctx, bots, get kernel() { return kernel; },
    manage: () => new MemoryManagement(kernel, bots),
    privateStore: () => new V2MemoryStore(kernel, bots),
    async reopen() { await kernel.close(); await open(); },
    async close() { await kernel.close(); await botData.close(); off(); await ctx.fiber.dispose(); } };
}
export async function erase(runtime, id) {
  const inventory = async () => ({ sessionIds: [], historyNodes: 0, summaries: 0, copies: 0,
    pendingMessages: 0, conservative: true, rootInstructions: false, stamp: 'synthetic-empty-inventory' });
  const previews = new ForgetPreviews(runtime.kernel, inventory);
  // There are genuinely no Agents/copies in this UNIT fixture. Real inventory is covered by Host/crash suites.
  const runner = new ForgetRunner(runtime.kernel, previews, { drain: async () => {}, history: async () => [],
    captureHeads: async () => [], copies: async () => {}, verifyInventory: async () => [] });
  try {
    const preview = await previews.create({ memoryId: id, mode: 'version' });
    const status = await runner.choose({ previewRevision: preview.previewRevision, choice: 'clean' });
    assert.equal(status.strong, true);
  } finally { await runner.close(); }
}
export function replayEqual(kernel) { assert.deepEqual(rebuild(kernel.domain), kernel.snapshot); }
export const createInput = (runtime, content, scope = 'private', botId = 'alpha') => ({
  botId, scope, kind: 'user_fact', content, valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: runtime.kernel.seq,
});
export function accounting(runtime, owner, opId = randomUUID()) {
  const id = randomUUID(), ref = randomUUID();
  return { opId, kind: 'accept', expectedRevision: runtime.kernel.seq, forgetEpoch: runtime.kernel.epoch,
    subjectIds: [id], versions: [{ schemaVersion: 2, memoryId: id, versionId: randomUUID(), contentRef: ref,
      userScope: runtime.kernel.scope.scope.id, revision: 1, commitSeq: runtime.kernel.seq + 1, kind: 'user_fact',
      recordedAt: 1, sourceRefs: [], provenance: { channel: 'model', bot: owner }, scope: 'shared', shard: owner,
      trust: 'candidate', status: 'active', labels: { readers: 'shared', originTrust: 'candidate', sourceVersions: [],
        restrictions: ['no-egress'], grants: [] } }],
    payloads: { [ref]: { content: 'SYNTHETIC_ACCOUNTING', valid: { from: null, to: null, basis: 'unknown' } } } };
}
