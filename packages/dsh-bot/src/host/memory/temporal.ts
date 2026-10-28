import type { MemoryVersion, MemoryPayload } from '../../shared/memory-v2.js';
import type { MemoryKernel } from './op-log.js';

export interface Fact { version: MemoryVersion; payload: MemoryPayload }
export interface TimeQuery { at: number; recordedBefore?: number; commitBefore?: number }
export const effective = (p: MemoryPayload, at: number) =>
  (p.valid.from === null || p.valid.from <= at) && (p.valid.to === null || at < p.valid.to);
/** Recorded time is a knowledge cutoff; valid time is the independently queried real-world interval. */
export function temporalView(kernel: MemoryKernel, query: TimeQuery): { facts: Fact[]; boundary: number } {
  const state = kernel.snapshot, histories = new Map<string, MemoryVersion[]>();
  for (const [, op] of kernel.domain.table('ops').entries()) {
    if (op.seq > (query.commitBefore ?? Infinity)) continue;
    for (const v of op.versions) if (v.recordedAt <= (query.recordedBefore ?? Infinity)) {
      const rows = histories.get(v.memoryId) ?? []; rows.push(v); histories.set(v.memoryId, rows);
    }
  }
  const facts: Fact[] = []; let boundary = Infinity;
  for (const [id, versions] of histories) {
    if (state.forgotten.has(id)) continue;
    versions.sort((a, b) => b.commitSeq - a.commitSeq);
    const latest = versions[0]; if (!latest) continue;
    if (latest.scope === 'private' && state.retired.has(JSON.stringify(latest.ownerBotKey))) continue;
    if (latest.labels.restrictions.some(r => r === 'revoked' || r === 'pending-cleanup')) continue;
    let selected: Fact | undefined;
    for (const version of versions) {
      const payload = kernel.domain.table('payloads').get(version.contentRef);
      if (!payload) throw new Error('Memory payload missing');
      for (const at of [payload.valid.from, payload.valid.to]) if (at !== null && at > query.at) boundary = Math.min(boundary, at);
      // Rejection/dispute/assignment is a current decision; it cannot reveal a previously active value.
      if (!selected && (latest.status !== 'active' || version.status === 'active' && effective(payload, query.at)))
        selected = { version: latest.status !== 'active' ? latest : version,
          payload };
    }
    if (!selected) {
      const payload = kernel.domain.table('payloads').get(latest.contentRef);
      if (payload) selected = { version: latest, payload };
    }
    if (selected) facts.push(selected);
  }
  return { facts, boundary };
}
export const temporalFacts = (kernel: MemoryKernel, query: TimeQuery): Fact[] => temporalView(kernel, query).facts;
