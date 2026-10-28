import type { BotKey } from '../../shared/identity.js';
import type { MemoryKernel } from './op-log.js';
import { temporalFacts, type TimeQuery } from './temporal.js';
import { adjudicate } from './conflicts.js';
export { retrievalRank as rankFacts } from './retrieval-rank.js';

export function readableFacts(kernel: MemoryKernel, bot: BotKey, query: TimeQuery) {
  return adjudicate(temporalFacts(kernel, query), query.at, bot).filter(f => f.state === 'active');
}
