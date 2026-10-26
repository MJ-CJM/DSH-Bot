import type { MemoryStore } from '../stores/memory.js';
export type MemoryPort = Pick<MemoryStore, 'add' | 'saveUnique' | 'update' | 'remove' | 'listByBot' | 'countByBot' | 'removeByBot'> & {
  forBot?(id: string): MemoryPort;
  captureEpoch?(): number;
  assertEpoch?(epoch: number): void;
};
