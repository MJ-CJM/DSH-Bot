import { sameBot } from '../../shared/identity.js';
import type { MemoryOp } from '../../shared/memory-ops.js';
import type { Projection } from './projection.js';
/** Also enforced during recovery: quotas cannot depend on disposable caches or a caller's counter. */
export function validateCharge(state: Projection, op: MemoryOp): void {
  const c = op.quotaCharge; if (!c) return;
  const p = state.autoPolicy, version = op.versions[0];
  if (!p?.enabled || op.kind !== 'accept' || op.versions.length !== 1 || !op.owner || op.owner.botId !== c.botId ||
    !version || version.scope !== 'shared' || version.shard === 'user' || !sameBot(version.shard, op.owner) ||
    !sameBot(version.provenance.bot, op.owner) || state.retired.has(JSON.stringify(op.owner)))
    throw new Error('Invalid automatic sharing charge');
  const previous = [...state.quota.values()];
  const latest = previous.reduce<typeof c | undefined>((a, b) => !a || a.at < b.at ? b : a, undefined);
  if (latest && (c.at < latest.at || (c.at < latest.end ? c.bucket !== latest.bucket || c.end !== latest.end ||
    c.timeZone !== latest.timeZone : c.bucket < latest.end))) throw new Error('Automatic quota clock/bucket regressed');
  const bucket = previous.filter(v => v.bucket === c.bucket);
  if (bucket.length >= p.domainDaily || bucket.filter(v => v.botId === c.botId).length >= p.botDaily)
    throw new Error('Automatic quota exceeded in operation log');
}
