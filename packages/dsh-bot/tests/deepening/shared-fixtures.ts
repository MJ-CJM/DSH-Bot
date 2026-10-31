import { createHash } from 'node:crypto';
import { memoryVersionSchema, payloadSchema } from '../../src/shared/memory-v2.js';
import type { Fact } from '../../src/host/memory/temporal.js';
import { MemoryManagement } from '../../src/host/memory/facade.js';
import type { v2Fixture } from './v2-fixtures.js';
export const uid = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export const botKey = (botId = 'alpha') => ({ botId, botCreatedAt: botId === 'alpha' ? 1 : 2 });
export interface AnnotatedFact {
  id: string; content: string; scope: string; trust: string; from: number | null; to: number | null;
  basis: string; seq: number; kind: string; subject: string; factKey: string | null;
  qualifiers: Record<string, string>; owner?: string; localException?: boolean; status?: string;
}
export function annotatedFact(row: AnnotatedFact): Fact {
  const owner = botKey(row.owner), id = uid(row.id);
  return { version: memoryVersionSchema.parse({ schemaVersion: 2, memoryId: id, versionId: uid(`${id}:v`), contentRef: uid(`${id}:p`),
    userScope: uid('scope'), revision: 1, commitSeq: row.seq, kind: row.kind, recordedAt: 100,
    sourceRefs: [{ entryReceiptId: uid(`${id}:receipt`) }], provenance: { channel: 'management', bot: owner },
    trust: row.trust, status: row.status ?? 'active', scope: row.scope,
    ...(row.scope === 'private' ? { ownerBotKey: owner, shard: owner } : { shard: owner }),
    labels: { readers: row.scope === 'shared' ? 'shared' : [owner], originTrust: row.trust,
      sourceVersions: [], restrictions: ['no-egress'], grants: [] } }),
    payload: payloadSchema.parse({ content: row.content, subject: row.subject, factKey: row.factKey ?? undefined,
      qualifiers: row.qualifiers, localException: row.localException, valid: { from: row.from, to: row.to, basis: row.basis } }) };
}
export const management = (f: Awaited<ReturnType<typeof v2Fixture>>) => new MemoryManagement(f.kernel, f.bots);
export async function shared(f: Awaited<ReturnType<typeof v2Fixture>>, content: string, patch = {}) {
  return management(f).create({ botId: 'alpha', scope: 'shared', content, kind: 'user_fact', subject: 'user', factKey: 'city',
    valid: { from: 10, to: null, basis: 'explicit' }, expectedRevision: f.kernel.seq, ...patch });
}
