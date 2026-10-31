import { tokenizeMemoryQuery } from '../../src/host/stores/memory.js';
/** Stable lexical baseline: all query tokens must match, then exact phrase/coverage/density; no model calls. */
export function baselineScore(content: string, query: string): number {
  const text = content.normalize('NFKC').toLowerCase(), tokens = tokenizeMemoryQuery(query);
  if (!tokens.length) return 0;
  if (!tokens.every(t => text.includes(t))) return -1;
  return Number(text.includes(query.normalize('NFKC').toLowerCase())) * 2 +
    tokens.reduce((n, t) => n + text.split(t).length - 1, 0) / Math.max(1, [...text].length);
}
export function baselineRank<T extends { payload: { content: string }; version: { memoryId: string; commitSeq: number } }>(
  rows: readonly T[], query: string): T[] {
  return rows.map(row => ({ row, score: baselineScore(row.payload.content, query) })).filter(r => r.score >= 0)
    .sort((a, b) => b.score - a.score || b.row.version.commitSeq - a.row.version.commitSeq ||
      a.row.version.memoryId.localeCompare(b.row.version.memoryId)).map(r => r.row);
}
