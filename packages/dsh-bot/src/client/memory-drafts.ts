import type { ManagedMemoryRow } from '../shared/memory-management.js';

export interface ManagedDraft {
  id?: string; revision: number; content: string; kind: 'user_fact' | 'user_event' | 'bot_role' | 'how_to_work';
  subject: string; factKey: string; qualifiers: string; from: string; to: string;
}
export const memoryDraft = (revision: number, row?: ManagedMemoryRow): ManagedDraft => ({
  id: row?.version.memoryId, revision, content: row?.payload.content ?? '', kind: row?.version.kind ?? 'user_fact',
  subject: row?.payload.subject ?? '', factKey: row?.payload.factKey ?? '',
  qualifiers: JSON.stringify(row?.payload.qualifiers ?? {}),
  from: row?.payload.valid.from === null || !row ? '' : new Date(row.payload.valid.from).toISOString(),
  to: row?.payload.valid.to === null || !row ? '' : new Date(row.payload.valid.to).toISOString(),
});
/** Volatile per-scope drafts. Nothing containing memory text is written to browser storage. */
export function memoryDrafts() {
  const drafts = new Map<string, ManagedDraft>();
  return { get: (scope: string) => drafts.get(scope),
    put(scope: string, draft?: ManagedDraft) { if (draft) drafts.set(scope, draft); else drafts.delete(scope); },
    clear: () => drafts.clear() };
}
