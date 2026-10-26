import { isDeepStrictEqual } from 'node:util';
import type { MemoryOp } from '../../shared/memory-ops.js';
import { memoryVersionSchema, type MemoryVersion } from '../../shared/memory-v2.js';
import type { MemoryDomain } from './domain-v2.js';

export interface Projection { seq: number; epoch: number; versions: ReadonlyMap<string, MemoryVersion>; forgotten: ReadonlySet<string> }
const immutable = () => { throw new Error('Published memory snapshot is immutable'); };
function freezeValue(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeValue(item);
  Object.freeze(value);
}
function publish(state: Projection): Projection {
  for (const v of state.versions.values()) freezeValue(v);
  Object.defineProperties(state.versions, { set: { value: immutable }, delete: { value: immutable }, clear: { value: immutable } });
  Object.defineProperties(state.forgotten, { add: { value: immutable }, delete: { value: immutable }, clear: { value: immutable } });
  Object.freeze(state.versions); Object.freeze(state.forgotten); return Object.freeze(state);
}
export const emptyProjection = (): Projection => publish({ seq: 0, epoch: 0, versions: new Map(), forgotten: new Set() });
export function applyOp(current: Projection, op: MemoryOp): Projection {
  if (op.seq !== current.seq + 1 || op.expectedRevision !== current.seq || op.forgetEpoch < current.epoch)
    throw new Error('Invalid memory log order');
  if (op.kind === 'forget' ? op.forgetEpoch !== current.epoch + 1 : op.forgetEpoch !== current.epoch)
    throw new Error('Invalid memory epoch');
  const versions = new Map(current.versions), forgotten = new Set(current.forgotten);
  for (const id of op.kind === 'forget' ? op.subjectIds : []) { forgotten.add(id); versions.delete(id); }
  if (op.kind === 'retire_shard' && op.owner) {
    for (const [id, v] of versions) if (v.scope === 'private' && isDeepStrictEqual(v.ownerBotKey, op.owner)) versions.delete(id);
  }
  for (const version of op.versions) {
    if (forgotten.has(version.memoryId) || version.commitSeq !== op.seq) throw new Error('Memory resurrection or bad commit sequence');
    versions.set(version.memoryId, structuredClone(version));
  }
  return publish({ seq: op.seq, epoch: op.forgetEpoch, versions, forgotten });
}
export function rebuild(domain: MemoryDomain): Projection {
  let state = emptyProjection();
  for (const [key, op] of [...domain.table('ops').entries()].sort((a, b) => a[1].seq - b[1].seq)) {
    if (key !== op.opId) throw new Error('Invalid memory op identity');
    state = applyOp(state, op);
  }
  const scope = domain.table('meta').get('scope')?.scope.id;
  for (const v of state.versions.values()) {
    if (v.userScope !== scope || !domain.table('payloads').get(v.contentRef)) throw new Error('Missing live memory payload/scope');
  }
  return state;
}
/** Projection rows are disposable caches. Recovery also removes abandoned payload attachments. */
export async function persistProjection(domain: MemoryDomain, state: Projection): Promise<void> {
  const cache = domain.table('projections');
  for (const [id] of cache.entries()) if (!state.versions.has(id)) await cache.delete(id);
  for (const [id, v] of state.versions) if (!isDeepStrictEqual(cache.get(id), v)) await cache.put(id, memoryVersionSchema.parse(v));
  const live = new Set([...domain.table('ops').entries()].flatMap(([, op]) => op.versions
    .filter(version => !state.forgotten.has(version.memoryId)).map(version => version.contentRef)));
  for (const [id] of domain.table('payloads').entries()) if (!live.has(id)) await domain.table('payloads').delete(id);
}
