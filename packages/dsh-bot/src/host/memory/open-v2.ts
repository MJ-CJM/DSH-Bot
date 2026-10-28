import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { openMemoryDomain } from './layout-upgrade.js';
import { acquireMemoryOwner } from './owner-lease.js';
import { MemoryKernel } from './op-log.js';

export async function openMemoryKernel(ctx: Context, dataDir: string, timeZone?: string) {
  const lease = await acquireMemoryOwner(join(dataDir, 'memory-owner'));
  try {
    const domain = await openMemoryDomain(ctx);
    const kernel = new MemoryKernel(domain, lease.assertOwner);
    try { await kernel.recover(timeZone); }
    catch (error) { await domain.close(); throw error; }
    let closing: Promise<void> | undefined;
    return { kernel, assertOwner: lease.assertOwner, close: () => (closing ??= (async () => {
      await kernel.close(); await lease.close();
    })()) };
  } catch (error) { await lease.close(); throw error; }
}
