import { validateCharge } from './quota-replay.js';
import type { AutoSharePolicy, QuotaCharge } from '../../shared/data-flow.js';
import type { MemoryOp } from '../../shared/memory-ops.js';
import type { MemoryVersion } from '../../shared/memory-v2.js';
import type { MemoryDomain } from './domain-v2.js';
import { PersistentMap, PersistentSet } from './persistent-map.js';

export interface Projection { seq: number; epoch: number; versions: PersistentMap<MemoryVersion>;
  forgotten: PersistentSet; retired: PersistentSet; autoPolicy?: AutoSharePolicy;
  quota: PersistentMap<QuotaCharge>; grantUses: PersistentSet }
function freezeValue(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeValue(item);
  Object.freeze(value);
}
function publish(state: Projection): Projection {
  // Reused subtrees and values are already frozen; publication never visits the full map.
  return Object.freeze(state);
}
export const emptyProjection = (): Projection => publish({ seq: 0, epoch: 0,
  quota: new PersistentMap(), grantUses: new PersistentSet(), versions: new PersistentMap(), forgotten: new PersistentSet(), retired: new PersistentSet() });
export function applyOp(current: Projection, op: MemoryOp): Projection {
  if (op.seq !== current.seq + 1 || op.expectedRevision !== current.seq || op.forgetEpoch < current.epoch)
    throw new Error('Invalid memory log order');
  if (op.kind === 'forget' ? op.forgetEpoch !== current.epoch + 1 : op.forgetEpoch !== current.epoch)
    throw new Error('Invalid memory epoch');
  if (op.autoPolicy && (op.kind !== 'policy' || op.autoPolicy.revision !== (current.autoPolicy?.revision ?? 1) + 1))
    throw new Error('Invalid automatic sharing policy');
  validateCharge(current, op);
  if (op.grantUse && current.grantUses.has(op.grantUse)) throw new Error('Grant already consumed');
  const autoPolicy = op.autoPolicy ?? current.autoPolicy; freezeValue(autoPolicy); freezeValue(op.quotaCharge);
  const quota = op.quotaCharge ? current.quota.with(op.opId, op.quotaCharge) : current.quota;
  const grantUses = op.grantUse ? current.grantUses.with(op.grantUse) : current.grantUses;
  let versions = current.versions;
  let forgotten = current.forgotten, retired = current.retired;
  for (const id of op.kind === 'forget' ? op.subjectIds : []) { forgotten = forgotten.with(id); versions = versions.without(id); }
  if (op.kind === 'retire_shard' && op.owner) {
    retired = retired.with(JSON.stringify(op.owner));
  }
  for (const version of op.versions) {
    if (forgotten.has(version.memoryId) || version.commitSeq !== op.seq) throw new Error('Memory resurrection or bad commit sequence');
    const value = structuredClone(version); freezeValue(value);
    versions = versions.with(version.memoryId, value);
  }
  return publish({ seq: op.seq, epoch: op.forgetEpoch, versions, forgotten, retired, autoPolicy, quota, grantUses });
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
/** Constant-size disposable watermark, never authority for recovery. Replay does bounded work per version after sorting ops. */
export async function persistWatermark(domain: MemoryDomain, state: Projection): Promise<void> {
  await domain.table('projections').put('snapshot', { seq: state.seq });
}
/** Recovery/forget maintenance only: remove abandoned and erased attachments, including old revisions. */
export async function persistProjection(domain: MemoryDomain, state: Projection): Promise<void> {
  const cache = domain.table('projections');
  await persistWatermark(domain, state);
  for (const [id] of cache.entries()) if (id !== 'snapshot') await cache.delete(id);
  const live = new Set([...domain.table('ops').entries()].flatMap(([, op]) => op.versions
    .filter(version => !state.forgotten.has(version.memoryId)).map(version => version.contentRef)));
  for (const [id] of domain.table('payloads').entries()) if (!live.has(id)) await domain.table('payloads').delete(id);
  for (const [id, item] of domain.table('migration_items').entries())
    if (state.forgotten.has(item.memoryId)) await domain.table('migration_items').delete(id);
}
