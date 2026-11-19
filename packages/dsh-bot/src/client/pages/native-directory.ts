import type { ActivitySession } from '../../shared/activity.js';
import type { GroupSummary } from '../../shared/groups.js';
import type { BotCatalogEntry } from '../state.js';
import { conversationKey, recentPreferences, updateRecentPreference } from './recent-conversations.js';

export type DirectoryIdentity = { kind: 'bot' | 'group'; id: string; createdAt: number };
export const directoryKey = (row: DirectoryIdentity) => conversationKey(row.kind, row.id, row.createdAt);
export type NativeDirectoryRow = DirectoryIdentity & {
  key: string; name: string; at: number; unread: number; preview?: string; search: string;
  entry?: BotCatalogEntry; group?: GroupSummary;
};
const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
/** Previews and unread belong only to a proven incarnation's primary conversation. */
export function nativeDirectoryRows(entries: readonly BotCatalogEntry[], groups: readonly GroupSummary[], activity: readonly ActivitySession[]): NativeDirectoryRow[] {
  return [...entries.map(entry => {
    const { bot, status } = entry;
    const primary = activity.find(row => row.sessionId === status?.mainSessionId && row.botId === bot.id && row.botCreatedAt === bot.createdAt);
    const identity = { kind: 'bot' as const, id: bot.id, createdAt: bot.createdAt };
    return { ...identity, key: directoryKey(identity), name: bot.name, entry, at: primary?.lastMessage.at ?? bot.createdAt,
      unread: primary?.unread ? 1 : 0, preview: primary?.lastMessage.preview, search: `${bot.name} ${bot.id} ${bot.description}` };
  }), ...groups.filter(row => !row.group.archived).map(group => {
    const identity = { kind: 'group' as const, id: group.group.id, createdAt: group.group.createdAt };
    return { ...identity, key: directoryKey(identity), name: group.group.name, group,
      at: group.latest?.at ?? group.group.createdAt, unread: group.unread ? 1 : 0,
      search: `${group.group.name} ${group.group.id} ${(group.members ?? []).filter(member => member.removedAt === undefined).map(member => member.bot.botId).join(' ')}` };
  })];
}
export function filterNativeDirectory(rows: readonly NativeDirectoryRow[], query: string, hidden?: boolean): NativeDirectoryRow[] {
  const tokens = fold(query.trim()).split(/\s+/u).filter(Boolean);
  return rows.filter(row => (hidden === undefined || Boolean(recentPreferences.get(row.key)?.hidden) === hidden)
    && tokens.every(token => fold(row.search).includes(token)))
    .sort((a, b) => Number(Boolean(recentPreferences.get(b.key)?.pinned)) - Number(Boolean(recentPreferences.get(a.key)?.pinned))
      || Math.max(b.at, recentPreferences.get(b.key)?.openedAt ?? 0) - Math.max(a.at, recentPreferences.get(a.key)?.openedAt ?? 0)
      || a.key.localeCompare(b.key));
}

type WindowStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface DirectoryWindowState { query?: string; filter?: string; selected?: string }
const windowKey = (path: string, section: string) => `dsh-bot:directory:v1:${path}:${section}`;
export function readDirectoryWindow(storage: WindowStorage | undefined, path: string, section: string): DirectoryWindowState {
  try {
    const value: unknown = JSON.parse(storage?.getItem(windowKey(path, section)) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(['query', 'filter', 'selected'].flatMap(key => key in value && typeof value[key as keyof typeof value] === 'string'
      ? [[key, value[key as keyof typeof value]]] : []));
  } catch { return {}; }
}
export function writeDirectoryWindow(storage: WindowStorage | undefined, path: string, section: string, value: DirectoryWindowState): void {
  try { storage?.setItem(windowKey(path, section), JSON.stringify(value)); } catch { /* Optional display state. */ }
}
/** One-window migration: only exact live identities, no messages, reads, settings, or navigation. */
export function migrateLegacyDirectory(storage: WindowStorage | undefined, path: string, identities: readonly DirectoryIdentity[]): string | undefined {
  if (!storage) return;
  const marker = windowKey(path, 'legacy-migrated');
  try {
    if (storage.getItem(marker) === 'true') return;
    const raw: unknown = JSON.parse(storage.getItem('dsh-bot.bot-mode.v1') ?? '{}');
    if (!raw || typeof raw !== 'object') return;
    const live = new Set(identities.map(directoryKey));
    const identity = (value: unknown): DirectoryIdentity | undefined => {
      if (!value || typeof value !== 'object') return;
      const row = value as Partial<DirectoryIdentity>;
      return (row.kind === 'bot' || row.kind === 'group') && typeof row.id === 'string' && row.id.length > 0
        && typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) && row.createdAt > 0 ? row as DirectoryIdentity : undefined;
    };
    const legacy = raw as { pinned?: unknown; selected?: unknown };
    if (Array.isArray(legacy.pinned)) for (const key of legacy.pinned.slice(-2000)) {
      if (typeof key !== 'string') continue;
      let tuple: unknown; try { tuple = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(tuple) || tuple.length !== 3) continue;
      const row = identity({ kind: tuple[0], id: tuple[1], createdAt: tuple[2] });
      if (row && live.has(directoryKey(row)) && !recentPreferences.has(directoryKey(row))) updateRecentPreference(directoryKey(row), { pinned: true });
    }
    const selected = identity(legacy.selected);
    const selectedKey = selected && live.has(directoryKey(selected)) ? directoryKey(selected) : undefined;
    if (selectedKey) writeDirectoryWindow(storage, path, 'selection', { selected: selectedKey });
    storage.setItem(marker, 'true');
    return selectedKey;
  } catch { /* Disabled/corrupt preferences do not block native navigation. */ }
}

export function directoryWindow() {
  try { return { storage: window.sessionStorage, path: window.location.pathname }; }
  catch { return { storage: undefined, path: '' }; }
}
