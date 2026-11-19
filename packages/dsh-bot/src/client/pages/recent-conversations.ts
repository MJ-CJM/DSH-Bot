import { botCreateSchema, type BotCreateInput, type BotRecord } from '../../shared/schema.js';
/** A response-lost create can only be claimed when every submitted/defaulted field matches. */
export function matchesCreation(input: BotCreateInput, bot: BotRecord): boolean {
  const expected = botCreateSchema.parse(input);
  return Object.entries(expected).every(([key, value]) => JSON.stringify(value) === JSON.stringify(bot[key as keyof BotRecord]));
}
export type RecentPreference = { pinned?: boolean; hidden?: boolean; openedAt?: number };
// UI-only preferences never call pause/delete and are scoped to this loaded client module.
export const recentPreferences = new Map<string, RecentPreference>();
export function conversationKey(kind: 'bot' | 'group', id: string, createdAt: number): string {
  return `${kind}:${id}:${createdAt}`;
}
let preferenceStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
let preferenceNamespace = '';
/** Browser-origin storage, additionally separated by the public application path.
 * Only identity and two boolean display preferences are stored, never chat data. */
export function restoreRecentPreferences(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, applicationPath: string): () => void {
  preferenceStorage = storage; preferenceNamespace = `dsh-bot:recent:v1:${applicationPath}`;
  recentPreferences.clear();
  try {
    const value: unknown = JSON.parse(storage?.getItem(preferenceNamespace) ?? '[]');
    if (Array.isArray(value)) for (const row of value.slice(-2000)) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !/^(?:bot|group):[^\n]+:\d+(?:\.\d+)?$/u.test(row[0])) continue;
      const flags: unknown = row[1];
      if (typeof flags === 'object' && flags !== null) {
        recentPreferences.set(row[0], { pinned: 'pinned' in flags && flags.pinned === true, hidden: 'hidden' in flags && flags.hidden === true,
          ...('openedAt' in flags && typeof flags.openedAt === 'number' && Number.isFinite(flags.openedAt) && flags.openedAt > 0 ? { openedAt: flags.openedAt } : {}) });
      }
    }
  } catch { /* Disabled/corrupt browser storage degrades to this client lifetime. */ }
  return () => { preferenceStorage = undefined; recentPreferences.clear(); };
}
export function setRecentPreference(key: string, field: 'pinned' | 'hidden'): void {
  const current = recentPreferences.get(key) ?? {};
  updateRecentPreference(key, { [field]: !current[field] });
}
export function updateRecentPreference(key: string, value: RecentPreference): void {
  recentPreferences.set(key, { ...recentPreferences.get(key), ...value });
  try { preferenceStorage?.setItem(preferenceNamespace, JSON.stringify([...recentPreferences].slice(-2000))); }
  catch { /* Quota/private mode does not interrupt navigation or work. */ }
}
