import type { BotRecord } from '../../src/shared/schema.js';

/** Committed records and generation checks match the Host-only registry API. */
export function personaRegistryDouble(records: () => readonly BotRecord[]) {
  const listeners = new Set<() => void>();
  return {
    personaSnapshot(botId: string, createdAt: number): BotRecord['persona'] | undefined {
      const bot = records().find(row => row.id === botId && row.createdAt === createdAt);
      return bot ? { ...bot.persona } : undefined;
    },
    subscribePersonaChanges(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notifyPersonaChanges() { for (const listener of listeners) listener(); },
    personaListenerCount: () => listeners.size,
  };
}
