import type { BotKey } from '../../shared/identity.js';
import type { MemoryKernel } from './op-log.js';
import { temporalFacts, type TimeQuery } from './temporal.js';
import { adjudicate } from './conflicts.js';
import { tokenizeMemoryQuery } from '../stores/memory.js';

/** Stable lexical baseline: all query tokens must match, then exact phrase/coverage/density; no model calls. */
export function lexicalScore(content: string, query: string): number {
  const text = content.normalize('NFKC').toLowerCase(), tokens = tokenizeMemoryQuery(query);
  if (!tokens.length) return 0;
  if (!tokens.every(t => text.includes(t))) return -1;
  return Number(text.includes(query.normalize('NFKC').toLowerCase())) * 2 +
    tokens.reduce((n, t) => n + text.split(t).length - 1, 0) / Math.max(1, [...text].length);
}
export function readableFacts(kernel: MemoryKernel, bot: BotKey, query: TimeQuery) {
  return adjudicate(temporalFacts(kernel, query), query.at, bot).filter(f => f.state === 'active');
}
export function rankFacts<T extends { payload: { content: string }; version: { memoryId: string; commitSeq: number } }>(
  rows: readonly T[], query: string, limit = 200): T[] {
  return rows.map(row => ({ row, score: lexicalScore(row.payload.content, query) })).filter(r => r.score >= 0)
    .sort((a, b) => b.score - a.score || b.row.version.commitSeq - a.row.version.commitSeq ||
      a.row.version.memoryId.localeCompare(b.row.version.memoryId)).slice(0, limit).map(r => r.row);
}
