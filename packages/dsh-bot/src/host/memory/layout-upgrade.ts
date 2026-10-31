import type { Context } from '@deepseek-ai/cordis';
import { memoryDomain, type MemoryDomain } from './domain-v2.js';

/** Native per-record bootstrap leaves the single document behind and may stop halfway.
 * Recopy from its public single-layout domain until `copied` is durable; only then erase
 * legacy rows through public table APIs. `ready` prevents reading the old medium again.
 * The caller holds the existing owner lease throughout. No kernel is exposed before ready.
 */
export async function openMemoryDomain(ctx: Context): Promise<MemoryDomain> {
  let target = await ctx.storageDomain.open(memoryDomain);
  try {
    if (target.table('layout').get('upgrade')?.phase === 'ready') return target;
    const copied = target.table('layout').get('upgrade')?.phase === 'copied';
    await target.close();
    const source = await ctx.storageDomain.open({ ...memoryDomain, layout: 'single' });
    // Capture a consistent source before reopening the same public domain name.
    const rows = new Map(Object.keys(memoryDomain.tables).filter(name => name !== 'layout')
      .map(name => [name, [...source.table(name as keyof typeof memoryDomain.tables).entries()]]));
    await source.close();
    target = await ctx.storageDomain.open(memoryDomain);
    if (!copied) {
      for (const [name, records] of rows) {
        // The union is erased only at this schema-identical table-copy boundary.
        const table = target.table(name as keyof typeof memoryDomain.tables);
        for (const [key, value] of records) await table.put(key, value as never);
      }
      await target.table('layout').put('upgrade', { phase: 'copied' });
    }
    await target.close();
    const legacy = await ctx.storageDomain.open({ ...memoryDomain, layout: 'single' });
    try {
      for (const name of Object.keys(memoryDomain.tables)) {
        const table = legacy.table(name as keyof typeof memoryDomain.tables);
        for (const key of table.keys()) await table.delete(key);
      }
    } finally { await legacy.close(); }
    target = await ctx.storageDomain.open(memoryDomain);
    await target.table('layout').put('upgrade', { phase: 'ready' });
    return target;
  } catch (error) { await target.close(); throw error; }
}
