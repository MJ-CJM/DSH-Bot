import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { expect } from 'vitest';
import { BotStore, MemoryStore, botDomain } from '../../src/host/store.js';
import { BotMemoryService } from '../../src/host/memory/service.js';
import { memorySchema, type MemoryRecord } from '../../src/shared/schema.js';

export const receiptRoot = resolve('../../.dsh-dev/deepening/b2/receipts');
export async function receipt(id: string, details: Record<string, unknown>) {
  await mkdir(receiptRoot, { recursive: true });
  await writeFile(resolve(receiptRoot, `${id}.json`), `${JSON.stringify({ id, evidenceLevel: 'UNIT', ...details }, null, 2)}\n`);
}
export async function clearReceipts(ids: string[]) {
  await Promise.all(ids.map(id => rm(resolve(receiptRoot, `${id}.json`), { force: true })));
}
export async function fixed(id: string, before: unknown, after: unknown, expected: unknown) {
  expect(before).not.toEqual(expected);
  expect(after).toEqual(expected);
  await receipt(id, { status: 'PASS', beforeFix: { status: 'FAIL', observed: before }, afterFix: { status: 'PASS', observed: after },
    expected, fixture: 'review-reconstruction (not an execution of a historical full package)' });
}
/** Only the final assertion is expected to fail. Setup/operation errors must leave no valid receipt. */
export async function open(id: string, observed: unknown, expected: unknown, contract?: string) {
  try { expect(observed).toEqual(expected); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== 'AssertionError') throw error;
    await receipt(id, { status: 'OPEN', beforeFix: { status: 'FAIL', observed }, afterFix: { status: 'NOT_RUN' },
      expected, ...(contract ? { contract } : {}), assertion: error.message,
      fixture: 'current v1 product; v2 semantics are not implemented' });
    throw error;
  }
}
export const memoryRecord = (id: string, fields: Partial<MemoryRecord> = {}) => memorySchema.parse({
  id, botId: 'alpha', content: id, kind: 'note', tags: [], pinned: false, createdAt: 1, updatedAt: 1, ...fields,
});

export async function memoryFixture() {
  const base = resolve('../../.dsh-dev/deepening/b2');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(resolve(base, 'memory-'));
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    const domain = await ctx.storageDomain.open(botDomain);
    ctx.effect(() => () => domain.close());
    const bots = new BotStore(domain);
    await bots.create({ id: 'alpha', name: 'Alpha' }, 1);
    await bots.create({ id: 'beta', name: 'Beta' }, 2);
    const store = new MemoryStore(domain);
    return { ctx, domain, bots, store, alpha: new BotMemoryService(store, 'alpha'), beta: new BotMemoryService(store, 'beta'),
      close: async () => { try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await ctx.fiber.dispose(); } finally { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}
