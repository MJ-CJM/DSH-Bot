import { randomUUID } from 'node:crypto';
import { sameBot, type BotKey } from '../../shared/identity.js';
import type { MemoryKernel } from './op-log.js';

export const retiredShard = (kernel: MemoryKernel, bot: BotKey) => [...kernel.domain.table('ops').entries()]
  .some(([, op]) => op.kind === 'retire_shard' && !!op.owner && sameBot(op.owner, bot));
export async function retireShard(kernel: MemoryKernel, owner: BotKey): Promise<void> {
  if (retiredShard(kernel, owner)) return;
  await kernel.commit({ opId: randomUUID(), kind: 'retire_shard', owner, subjectIds: [],
    expectedRevision: kernel.seq, forgetEpoch: kernel.epoch });
}
