import { createSharedMemoryCatalog } from './shared-memory-state.js';
import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { DshBotRemoteMethods } from '../shared/remote-contract.js';
import type { MemoryPanelProps } from './components/MemoryPanel.js';
import { createMemoryCatalog, type MemoryCatalog, type MemoryCatalogOptions } from './memory-state.js';

export function memoryPanelFactory(ctx: Context, memories: Set<MemoryCatalog>, options: () => MemoryCatalogOptions,
  remote: () => DshBotRemoteMethods['memory'], onOpenSession: MemoryPanelProps['onOpenSession']) {
  const unwrap = <T,>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
  return (id: string): Omit<MemoryPanelProps, 'bot' | 't'> & { dispose(): void } => {
    const memory = createMemoryCatalog(ctx, id, options());
    memories.add(memory);
    const shared = createSharedMemoryCatalog(ctx, id, options());
    const write = async (operation: () => Promise<RemoteResult<unknown>>) => {
      unwrap(await operation()); await memory.refresh();
    };
    return {
      catalog: memory,
      shared: { catalog: shared, remote, refresh: async () => { await Promise.all([shared.refresh(), memory.refresh()]); } },
      dispose: () => { memories.delete(memory); memory.dispose(); shared.dispose(); },
      onSave: input => write(() => remote().save(id, input)),
      onUpdate: (memoryId, patch) => write(() => remote().update(id, memoryId, patch)),
      onRemove: memoryId => write(() => remote().delete(id, memoryId)),
      forgetting: {
        preview: async selection => unwrap(await remote().previewForget(id, selection)),
        choose: async choice => {
          const result = unwrap(await remote().chooseForget(choice)); await memory.refresh(); return result;
        },
        retry: cleanupId => write(() => remote().retryCleanup(cleanupId)),
      },
      onOpenSession,
    };
  };
}
