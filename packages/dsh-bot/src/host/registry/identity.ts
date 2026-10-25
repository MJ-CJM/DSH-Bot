import { isDeepStrictEqual } from 'node:util';
import type { BotRecord } from '../../shared/schema.js';
export function sameBotConfig(left: BotRecord, right: BotRecord): boolean {
  const { createdAt: _lc, updatedAt: _lu, ...l } = left;
  const { createdAt: _rc, updatedAt: _ru, ...r } = right;
  return isDeepStrictEqual(l, r);
}
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

