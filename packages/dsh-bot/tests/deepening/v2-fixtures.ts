import { required } from '../fixtures/required.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { BotStore } from '../../src/host/stores/bots.js';
import { migrationBotDomain, type BotDomain } from '../../src/host/stores/domain.js';
import { openMemoryKernel } from '../../src/host/memory/open-v2.js';
import { migratePrivate } from '../../src/host/memory/migration.js';
import { V2MemoryStore } from '../../src/host/memory/store-v2.js';
import { BotMemoryService } from '../../src/host/memory/service.js';
import { privateVersion } from '../../src/host/memory/version.js';
import { memorySchema } from '../../src/shared/schema.js';

export async function v2Fixture(migrate = true) {
  const base = resolve('../../.dsh-dev/deepening/b3'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'unit-')), ctx = new Context();
  let opened: Awaited<ReturnType<typeof openMemoryKernel>> | undefined;
  try {
    await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: join(root, 'storage') }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    let legacy = await ctx.storageDomain.open(migrationBotDomain);
    let bots = new BotStore(legacy as unknown as BotDomain);
    await bots.create({ id: 'alpha', name: 'Alpha' }, 1); await bots.create({ id: 'beta', name: 'Beta' }, 2);
    opened = await openMemoryKernel(ctx, join(root, 'data'));
    if (migrate) await migratePrivate(legacy, opened.kernel);
    const services = () => {
      const store = new V2MemoryStore(required(opened).kernel, bots);
      return { store, alpha: new BotMemoryService(store, 'alpha'), beta: new BotMemoryService(store, 'beta') };
    };
    return { ctx, root, get legacy() { return legacy; }, get bots() { return bots; },
      get kernel() { return required(opened).kernel; }, ...services(),
      async reopen() {
        await required(opened).close(); await legacy.close();
        legacy = await ctx.storageDomain.open(migrationBotDomain); bots = new BotStore(legacy as unknown as BotDomain);
        opened = await openMemoryKernel(ctx, join(root, 'data'));
        return services();
      },
      async close() { try { await opened?.close(); await legacy.close(); await ctx.fiber.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); } },
    };
  } catch (error) {
    await opened?.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error;
  }
}
export function command(f: Awaited<ReturnType<typeof v2Fixture>>, content = 'SYNTHETIC_V2') {
  const id = randomUUID(), opId = randomUUID();
  const record = memorySchema.parse({ id, botId: 'alpha', content, kind: 'note', tags: [], pinned: false, createdAt: 2, updatedAt: 2 });
  const { version, payload } = privateVersion(f.kernel, record, { botId: 'alpha', botCreatedAt: 1 });
  return { opId, kind: 'propose' as const, subjectIds: [version.memoryId], expectedRevision: f.kernel.seq,
    forgetEpoch: f.kernel.epoch, versions: [version], payloads: { [version.contentRef]: payload } };
}
