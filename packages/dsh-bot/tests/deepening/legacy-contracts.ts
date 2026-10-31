import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { MemoryRecord } from '../../src/shared/schema.js';

/** Deliberately defective, minimal review reconstructions. Never imported by product code.
 * H01: V032-bot-to-bot.md:169 (probe is not injection).
 * H02: V032-bot-to-bot.md:16 (native next appends runtime context).
 * H14-H16: P1-T06.md:7-11 (slice packing, absent atomic dedup/secret gate).
 * H17: src/shared/activity-preview.ts:18-19 (current intraword safeguard; reconstructed old regex).
 * These reproduce documented failure mechanisms, not byte-identical old releases.
 */
export const legacyWakeInput = (messages: UserMessage[]) =>
  messages.filter(message => message.source.kind !== 'dsh-bot-message-wake');

export function legacyPack(rows: MemoryRecord[], budget: number): string {
  return rows.map(row => JSON.stringify(row.content)).join('\n').slice(0, budget);
}
export function legacySave(rows: MemoryRecord[], record: MemoryRecord) {
  rows.push(record); // No normalized-content uniqueness check in the write slot.
  return record.id;
}
export function legacyAcceptsModelText(_text: string) { return true; }
export const legacyPreview = (text: string) => text.replace(/(_{1,2})(?=\S)([\s\S]*?\S)\1/gu, '$2');
