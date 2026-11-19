import type { MemoryVersion } from '../../shared/memory-v2.js';
import type { MemoryKernel } from './op-log.js';
import { sameBot } from '../../shared/identity.js';
import { canReadLabel } from '../data-flow/labels.js';
/** Only exact current memory versions are supported. No async I/O or transcript assumptions. */
export function consolidationReadable(kernel: MemoryKernel, version: MemoryVersion, now = Date.now(), seen = new Set<string>()): boolean {
  const proof = version.consolidation;
  if (!proof) return true;
  if (seen.has(version.versionId)) return false;
  seen.add(version.versionId);
  if (version.scope !== 'private' || kernel.snapshot.retired.has(JSON.stringify(version.ownerBotKey)) ||
    version.status === 'proposed' && now >= proof.expiresAt) return false;
  return proof.sourceIds.every(id => {
    const source = [...kernel.snapshot.versions.values()].find(v => v.versionId === id);
    if (!source || source.status !== 'active' || source.scope !== 'private' || !sameBot(source.ownerBotKey, version.ownerBotKey) ||
      !canReadLabel(source.labels, version.ownerBotKey) || source.labels.restrictions.some(r => ['revoked', 'secret', 'pending-cleanup'].includes(r))) return false;
    const payload = kernel.domain.table('payloads').get(source.contentRef);
    return !!payload && (payload.valid.from === null || payload.valid.from <= now) &&
      (payload.valid.to === null || payload.valid.to > now) && consolidationReadable(kernel, source, now, new Set(seen));
  });
}
