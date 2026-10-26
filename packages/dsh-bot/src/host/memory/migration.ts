import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fenceSchema, migrationSchema, migrationItemSchema, type Migration } from '../../shared/memory-ops.js';
import { memorySchema } from '../../shared/schema.js';
import type { MigrationBotDomain } from '../stores/domain.js';
import type { MemoryKernel } from './op-log.js';
import { privateVersion } from './version.js';
import { rebuild } from './projection.js';

export const FENCE_KEY = '__dsh_bot_memory_v2_fence__';
export function assertCompatibleRecovery(kernel: MemoryKernel, capabilities: { fence: boolean; tombstone: boolean; epoch: boolean }): void {
  if (!capabilities.fence || !capabilities.tombstone || !capabilities.epoch) throw new Error('Incompatible memory recovery package');
  if (kernel.frozen || kernel.stopped) throw new Error('Memory reconciliation required before recovery');
  // Barriers are deliberately retained. This check cannot authorize history/copy cleanup.
}
/** Restartable private migration using only public table methods. The old table never becomes writable again. */
export async function migratePrivate(legacy: MigrationBotDomain, kernel: MemoryKernel) {
  const table = legacy.table('memories');
  let manifest = kernel.domain.table('migration').get('active');
  const fence = table.get(FENCE_KEY);
  if (fence && !fenceSchema.safeParse(fence).success) throw new Error('Reserved memory Fence key conflict');
  if (fence && (!manifest || !('migrationId' in fence) || fence.migrationId !== manifest.id))
    throw new Error('Memory Fence has no matching migration manifest');
  const rows = [...table.entries()].filter(([id]) => id !== FENCE_KEY).map(([key, row]) => {
    const record = memorySchema.parse(row);
    if (key !== record.id) throw new Error('Legacy memory identity mismatch');
    return record;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const digest = () => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (manifest?.phase === 'done' && rows.length) throw new Error('Legacy data reintroduced after cutover; recovery blocked');
  if (!manifest) {
    manifest = migrationSchema.parse({ id: randomUUID(), sourceSchema: 1, targetSchema: 2, sourceDigest: digest(), phase: 'prepare',
      counts: { source: rows.length, copied: 0, quarantined: 0 }, cutoverSeq: 0, forgetEpoch: kernel.epoch });
    await kernel.domain.table('migration').put('active', manifest);
  }
  const save = async (phase: Migration['phase']) => {
    manifest = migrationSchema.parse({ ...manifest, phase });
    await kernel.domain.table('migration').put('active', manifest);
  };
  if (['prepare', 'copy', 'verify'].includes(manifest.phase)) {
    if (manifest.sourceDigest !== digest()) throw new Error('Legacy migration source changed; writes remain blocked');
    await save('copy');
    for (const record of rows) {
      let item = kernel.domain.table('migration_items').get(record.id);
      const bot = legacy.table('bots').get(record.botId);
      // v1 has no BotKey lifecycle receipt. Timestamp ordering alone cannot prove ownership.
      // Preserve every row in quarantine until explicit management assigns it to a verified lifecycle.
      if (!item) {
        item = migrationItemSchema.parse({ legacyId: record.id, memoryId: randomUUID(), versionId: randomUUID(),
          opId: randomUUID(), contentRef: randomUUID(), quarantine: true });
        await kernel.domain.table('migration_items').put(record.id, item);
      }
      const old = kernel.domain.table('ops').get(item.opId);
      if (!old) {
        const owner = { botId: record.botId, botCreatedAt: bot?.createdAt ?? 0 };
        const { version, payload } = privateVersion(kernel, record, owner, {
          memoryId: item.memoryId, versionId: item.versionId, contentRef: item.contentRef, revision: 1 });
        if (item.quarantine) version.status = 'proposed';
        await kernel.commit({ opId: item.opId, kind: 'migration', subjectIds: [item.memoryId], expectedRevision: kernel.seq,
          forgetEpoch: kernel.epoch, versions: [version], payloads: { [item.contentRef]: payload } });
      }
    }
    await save('verify');
    const projection = rebuild(kernel.domain);
    if (!isDeepStrictEqual(projection, kernel.snapshot)) throw new Error('Migration projection rebuild differs');
    const items = [...kernel.domain.table('migration_items').entries()];
    if (items.length !== rows.length) throw new Error('Migration row counts differ');
    for (const record of rows) {
      const item = kernel.domain.table('migration_items').get(record.id);
      if (!item) throw new Error('Missing migration identity map');
      const v = projection.versions.get(item.memoryId);
      const p = v && kernel.domain.table('payloads').get(v.contentRef);
      if (!p || !isDeepStrictEqual({ ...p.legacy, content: p.content }, record)) throw new Error('Migration row verification failed');
    }
    manifest.counts = { source: rows.length, copied: rows.length, quarantined: items.filter(([, i]) => i.quarantine).length };
    await table.put(FENCE_KEY, fenceSchema.parse({ schemaVersion: 2, kind: 'migration-fence', migrationId: manifest.id }));
    manifest.cutoverSeq = kernel.seq;
    await save('cutover');
  }
  if (manifest.phase === 'cutover') await save('legacy-clean');
  if (manifest.phase === 'legacy-clean') {
    if (!fenceSchema.safeParse(table.get(FENCE_KEY)).success) throw new Error('Missing migration Fence');
    for (const [id] of table.entries()) if (id !== FENCE_KEY) await table.delete(id);
    delete manifest.sourceDigest;
    await save('done');
  }
  if (!fenceSchema.safeParse(table.get(FENCE_KEY)).success) throw new Error('Fence lost after migration');
  return structuredClone(manifest);
}
