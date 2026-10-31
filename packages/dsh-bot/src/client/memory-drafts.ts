import type { ManagedMemoryRow } from '../shared/memory-management.js';

export interface ManagedDraft {
  id?: string; revision: number; content: string; kind: 'user_fact' | 'user_event' | 'bot_role' | 'how_to_work';
  subject: string; factKey: string; qualifiers: { id: number; key: string; value: string }[]; from: string; to: string;
}
let qualifierId = 0;
export const qualifierDraft = (key = '', value = '') => ({ id: ++qualifierId, key, value });
export const memoryDraft = (revision: number, row?: ManagedMemoryRow): ManagedDraft => ({
  id: row?.version.memoryId, revision, content: row?.payload.content ?? '', kind: row?.version.kind ?? 'user_fact',
  subject: row?.payload.subject ?? '', factKey: row?.payload.factKey ?? '',
  qualifiers: Object.entries(row?.payload.qualifiers ?? {}).map(([key, value]) => qualifierDraft(key, value)),
  from: row?.payload.valid.from === null || !row ? '' : new Date(row.payload.valid.from).toISOString(),
  to: row?.payload.valid.to === null || !row ? '' : new Date(row.payload.valid.to).toISOString(),
});
/** Reject incomplete/duplicate rows before converting them to the strict Remote's record. */
export function draftQualifiers(rows: ManagedDraft['qualifiers']): Record<string, string> {
  const entries = rows.map(({ key, value }) => [key.trim(), value.trim()] as const);
  if (entries.some(([key, value]) => !key || key.length > 64 || !value || value.length > 200) ||
    new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Invalid qualifier rows');
  return Object.fromEntries(entries);
}
/** Volatile per-scope drafts. Nothing containing memory text is written to browser storage. */
export function memoryDrafts() {
  const drafts = new Map<string, ManagedDraft>();
  return { get: (scope: string) => drafts.get(scope),
    put(scope: string, draft?: ManagedDraft) { if (draft) drafts.set(scope, draft); else drafts.delete(scope); },
    clear: () => drafts.clear() };
}
