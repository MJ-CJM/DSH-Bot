import { sameBot, type BotKey } from '../../shared/identity.js';
import type { MemoryVersion } from '../../shared/memory-v2.js';
import { effective, type Fact } from './temporal.js';

export interface JudgedFact extends Fact { state: MemoryVersion['status']; supersededBy?: string }
const trust = { candidate: 0, user_stated: 1, user_confirmed: 2 };
export function factKey({ payload: p, version: v }: Fact): string | undefined {
  if (v.kind === 'user_event' || !p.subject?.trim() || !p.factKey?.trim()) return;
  return JSON.stringify([p.subject, p.factKey, Object.entries(p.qualifiers ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
const readable = (f: Fact, bot?: BotKey) => f.version.scope === 'shared' ||
  !!bot && f.version.scope === 'private' && sameBot(f.version.ownerBotKey, bot) &&
  f.version.labels.readers !== 'shared' && f.version.labels.readers.some(b => sameBot(b, bot));
const known = (f: Fact) => f.payload.valid.basis !== 'unknown' && f.payload.valid.from !== null;
const rank = (a: Fact, b: Fact) => trust[b.version.trust] - trust[a.version.trust] ||
  (b.payload.valid.from ?? 0) - (a.payload.valid.from ?? 0) || b.version.commitSeq - a.version.commitSeq;

/** Pure, time-sliced adjudication. Permission filtering precedes grouping, so private disputes cannot leak. */
export function adjudicate(facts: readonly Fact[], at: number, bot?: BotKey, management = false): JudgedFact[] {
  const rows: JudgedFact[] = facts.filter(f => !f.version.labels.restrictions.some(r => r === 'revoked' || r === 'pending-cleanup') &&
    (management || readable(f, bot))).map(f => ({ ...f, state: f.version.status }));
  const groups = new Map<string, JudgedFact[]>();
  for (const row of rows) {
    if (row.state !== 'active') continue;
    if (!effective(row.payload, at)) { row.state = 'expired'; continue; }
    const key = factKey(row);
    if (!key) {
      if (row.version.scope === 'shared' && row.version.trust === 'candidate') row.state = 'proposed';
      continue;
    }
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const users = group.filter(f => f.version.trust !== 'candidate');
    const candidates = group.filter(f => f.version.trust === 'candidate');
    for (const c of candidates) {
      if (users.length) c.state = 'superseded';
      else if (new Set(candidates.map(f => f.payload.content)).size > 1) c.state = 'disputed';
      else if (c.version.scope === 'shared') c.state = 'proposed';
    }
    if (!users.length) continue;
    const local = users.filter(f => f.version.scope === 'private' &&
      (f.payload.localException || f.version.kind === 'bot_role' || f.version.kind === 'how_to_work'));
    // Local exceptions apply only inside their Bot's permission-filtered view.
    const eligible = local.length && !management ? local : users;
    const ranked = [...eligible].sort(rank);
    const winner = ranked[0];
    if (!winner) continue;
    const ambiguous = eligible.filter(f => f !== winner && f.payload.content !== winner.payload.content &&
      trust[f.version.trust] === trust[winner.version.trust] && (!known(f) || !known(winner)));
    if (ambiguous.length) {
      winner.state = 'disputed'; for (const row of ambiguous) row.state = 'disputed';
      for (const row of users) if (row.state !== 'disputed') row.state = 'superseded';
    } else for (const row of users) if (row !== winner) { row.state = 'superseded'; row.supersededBy = winner.version.memoryId; }
    for (const c of candidates) if (c.state === 'superseded') c.supersededBy = winner.version.memoryId;
  }
  return rows;
}

/** Partition known validity boundaries without assuming seq numbers are real-world time. */
export function temporalSlices(facts: readonly Fact[], bot?: BotKey) {
  const boundaries = [...new Set(facts.flatMap(f => [f.payload.valid.from, f.payload.valid.to])
    .filter((n): n is number => n !== null))].sort((a, b) => a - b);
  return boundaries.map((from, i) => ({ from, to: boundaries[i + 1] ?? null, rows: adjudicate(facts, from, bot) }));
}
