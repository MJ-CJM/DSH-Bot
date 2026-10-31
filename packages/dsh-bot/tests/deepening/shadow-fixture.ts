import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { policySchema } from '../../src/shared/notifications.js';
export const policy = (botId = 'alpha') => policySchema.parse({
  id: `synthetic-${botId}`, owner: { botId, botCreatedAt: 1 }, channel: 'in-app', enabled: true, timezone: 'UTC',
  dailyLimit: 5, cooldownSec: 60, quietHours: { start: '22:00', end: '08:00' }, authorization: { mode: 'ask' },
  revision: 1, schemaVersion: 1, createdAt: 0, updatedAt: 0, scopeDigest: 'synthetic', targetDigest: 'synthetic',
});
export async function shadowFixture() {
  const base = resolve('../../.dsh-dev/deepening'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(resolve(base, 'b8-shadow-')), ctx = new Context();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: resolve(dir, 'storage') }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  return { ctx, dir, close: async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }); } };
}
