import type { MemoryListOptions, MemoryRecord } from '../../shared/schema.js';
import type { MemoryStore } from '../stores/memory.js';
export type MemoryPort = Pick<MemoryStore, 'add' | 'saveUnique' | 'update' | 'remove' | 'listByBot' | 'countByBot' | 'removeByBot'> & {
  readableByBot?(id: string, options: MemoryListOptions): (MemoryRecord & { scope?: 'private' | 'shared' })[];
  forBot?(id: string): MemoryPort;
  captureEpoch?(): number;
  assertEpoch?(epoch: number): void;
};
