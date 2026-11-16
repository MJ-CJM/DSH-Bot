import { createContext, useContext, useState } from 'react';
import type { BotRecord } from '../../shared/schema.js';

type Selection = { bot: BotRecord | undefined; select(id: string): void };
export const SettingsBotContext = createContext<Selection | undefined>(undefined);

/** Selection is an incarnation, not a reusable Bot ID. Deleted Bots require explicit re-selection. */
export function useBotSelection(bots: readonly BotRecord[], initial?: { id: string; createdAt: number }): Selection {
  const [identity, setIdentity] = useState<{ id: string; createdAt: number } | undefined>(initial);
  const bot = identity ? bots.find(b => b.id === identity.id && b.createdAt === identity.createdAt) : bots[0];
  // Pin the first accepted identity even when the catalog arrives after mount.
  if (!identity && bot) setIdentity({ id: bot.id, createdAt: bot.createdAt });
  return { bot, select(id) { const next = bots.find(b => b.id === id); if (next) setIdentity({ id: next.id, createdAt: next.createdAt }); } };
}
export function useSettingsBot(bots: readonly BotRecord[]): Selection {
  const shared = useContext(SettingsBotContext);
  const local = useBotSelection(bots);
  return shared ?? local;
}
