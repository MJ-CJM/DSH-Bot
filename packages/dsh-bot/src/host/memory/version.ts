import { randomUUID } from 'node:crypto';
import { memoryVersionSchema, payloadSchema } from '../../shared/memory-v2.js';
import type { BotKey } from '../../shared/identity.js';
import type { MemoryRecord } from '../../shared/schema.js';
import type { MemoryKernel } from './op-log.js';

export function privateVersion(kernel: MemoryKernel, record: MemoryRecord, owner: BotKey,
  ids: { memoryId: string; versionId: string; contentRef: string; revision: number } = {
    memoryId: randomUUID(), versionId: randomUUID(), contentRef: randomUUID(), revision: 1 },
  channel: 'legacy' | 'model' | 'management' = 'legacy') {
  const { content, ...legacy } = record;
  const version = memoryVersionSchema.parse({ ...ids, schemaVersion: 2, userScope: kernel.scope.scope.id,
    commitSeq: kernel.seq + 1, kind: 'user_fact', legacyKind: record.kind,
    recordedAt: channel === 'legacy' ? record.createdAt : Date.now(),
    sourceRefs: record.source?.sessionId ? [{ sessionId: record.source.sessionId }] : [],
    provenance: { channel, bot: owner }, trust: 'candidate', status: 'active', scope: 'private', ownerBotKey: owner, shard: owner,
    labels: { readers: [owner], originTrust: 'candidate', sourceVersions: [], restrictions: ['no-egress'], grants: [] },
  });
  return { version, payload: payloadSchema.parse({ content, legacy, valid: { from: null, to: null, basis: 'unknown' } }) };
}
