import type { ProactiveWork } from './work.js';

/** Observational projection, not a causal improvement score. Latest assignment
 * per enrolled Ticket; no success-only filtering and no invented measurements. */
export function taskOutcomes(rows: readonly ProactiveWork[], complete: boolean) {
  const tickets = new Map<string, ProactiveWork>();
  for (const row of rows) {
    const previous = tickets.get(row.ticketId);
    if (!previous || row.generation > previous.generation || (row.generation === previous.generation && row.revision > previous.revision)) tickets.set(row.ticketId, row);
  }
  const groups = new Map<string, { mode: 'manual' | 'proactive' | 'unmeasured'; collaboration: 'group' | 'solo'; model: string; kind: string; enrolled: number; accepted: number; failed: number; cancelled: number; unknown: number; pending: number; reworks: number; knownTokens: number; unmeasuredCosts: number }>();
  for (const row of tickets.values()) {
    const mode = row.admission ?? 'unmeasured', collaboration = row.groupRepair || row.groupReview ? 'group' : 'solo';
    const model = `${row.target.provider}/${row.target.model}`, kind = row.taskKind ?? 'unmeasured';
    const key = JSON.stringify([mode, collaboration, model, kind]);
    const group = groups.get(key) ?? { mode, collaboration, model, kind, enrolled: 0, accepted: 0, failed: 0, cancelled: 0, unknown: 0, pending: 0, reworks: 0, knownTokens: 0, unmeasuredCosts: 0 };
    group.enrolled++;
    if (row.state === 'accepted') group.accepted++;
    else if (row.state === 'failed' || row.state === 'denied') group.failed++;
    else if (row.state === 'cancelled') group.cancelled++;
    else if (row.state === 'unknown') group.unknown++;
    else group.pending++;
    group.reworks += row.generation - 1;
    if (row.taskCost) { group.knownTokens += row.taskCost.knownNativeTokens; group.unmeasuredCosts += row.taskCost.unknownMeasurements; }
    else { group.unmeasuredCosts++; }
    groups.set(key, group);
  }
  return { complete, enrolled: tickets.size, cohorts: [...groups.values()],
    unmeasured: ['human-time', 'interventions', 'repeated-explanations', 'suggestion-precision', 'suggestion-recall', 'notification-annoyance', 'causal-benefit'] as const };
}
