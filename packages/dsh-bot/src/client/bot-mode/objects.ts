import type { BotCatalogEntry } from '../state.js';
import type { ActivitySnapshot } from '../activity-state.js';
import type { SupergroupWork } from '../../shared/supergroup.js';
import type { GroupSummary } from '../../shared/groups.js';
import { isHiddenActivityPreview } from '../../shared/activity.js';

export interface ObjectIdentity { kind: 'bot' | 'group'; id: string; createdAt: number }
export interface BotModeObject extends ObjectIdentity {
  ended?: boolean; hasActivity?: boolean; goal?: string; workState?: SupergroupWork['state']; key: string; name: string; sessionId?: string; at: number; unread: number; preview: string;
  bot?: BotCatalogEntry['bot']; group?: GroupSummary;
}
export const objectKey = (object: ObjectIdentity) => JSON.stringify([object.kind, object.id, object.createdAt]);
/** Only the authoritative primary binding is a Bot route. Activity and presets
 * never prove ownership of arbitrary history or a recreated Bot generation. */
export function projectObjects(entries: readonly BotCatalogEntry[], groups: readonly GroupSummary[], activity: Pick<ActivitySnapshot, 'sessions'>): BotModeObject[] {
  return [
    ...entries.map(({ bot, status }): BotModeObject => {
      const primary = activity.sessions.find(row => row.sessionId === status?.mainSessionId && row.botId === bot.id && row.botCreatedAt === bot.createdAt);
      const identity = { kind: 'bot' as const, id: bot.id, createdAt: bot.createdAt };
      return { ...identity, key: objectKey(identity), name: bot.name, bot, sessionId: status?.mainSessionId,
        hasActivity: Boolean(primary), at: primary?.lastMessage.at ?? bot.createdAt, unread: primary?.unread ? 1 : 0,
        preview: isHiddenActivityPreview(primary?.lastMessage.preview) ? '' : primary?.lastMessage.preview ?? '' };
    }),
    ...groups.filter(row => !row.group.archived).map((group): BotModeObject => {
      const identity = { kind: 'group' as const, id: group.group.id, createdAt: group.group.createdAt };
      return { ...identity, key: objectKey(identity), name: group.group.name, sessionId: group.group.rootSessionId,
        hasActivity: Boolean(group.latest), at: group.latest?.at ?? group.group.createdAt, unread: group.unread ? 1 : 0, preview: '', group };
    }),
  ];
}
export function findObjectForSession(objects: readonly BotModeObject[], sessionId: string | undefined): BotModeObject | undefined {
  if (!sessionId) return;
  const matches = objects.filter(row => row.sessionId === sessionId);
  return matches.length === 1 ? matches[0] : undefined;
}
export function sortObjects(objects: readonly BotModeObject[], query: string, pinned: readonly string[]): BotModeObject[] {
  const needle = query.trim().toLocaleLowerCase();
  return objects.filter(row => !needle || row.name.toLocaleLowerCase().includes(needle) || row.preview.toLocaleLowerCase().includes(needle) || row.bot?.description.toLocaleLowerCase().includes(needle) || row.id.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(pinned.includes(b.key)) - Number(pinned.includes(a.key)) || b.at - a.at || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
export interface ModePreferences { selected?: ObjectIdentity; pinned: string[]; read: Record<string, number> }
export function readPreferences(storage: Pick<Storage, 'getItem'> | undefined, key: string): ModePreferences {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') throw new Error();
    const row = value as Partial<ModePreferences>;
    const selected = row.selected;
    return { pinned: Array.isArray(row.pinned) ? row.pinned.filter((key): key is string => typeof key === 'string') : [],
      read: Object.fromEntries(Object.entries(row.read ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))),
      ...(selected && (selected.kind === 'bot' || selected.kind === 'group') && typeof selected.id === 'string' && typeof selected.createdAt === 'number' ? { selected } : {}) };
  } catch { return { pinned: [], read: {} }; }
}

/** Presentation-only retention; never archives or changes work state. Pinned and
 * searched objects stay immediately visible regardless of their age. */
export const RECENT_GROUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export function splitObjectSections(objects: readonly BotModeObject[], pinned: readonly string[], query = '', now = Date.now()) {
  const earlier = (row: BotModeObject) => row.kind === 'group' && row.ended === true && row.at < now - RECENT_GROUP_WINDOW_MS && !pinned.includes(row.key) && !query.trim();
  return { recent: objects.filter(row => !earlier(row)), earlier: objects.filter(earlier) };
}
export function hasDuplicateName(object: BotModeObject, objects: readonly BotModeObject[]) {
  return objects.some(row => row.key !== object.key && row.name === object.name);
}
/** Responsibilities disambiguate names only when they actually differ. */
export function distinctDescription(object: BotModeObject, objects: readonly BotModeObject[]) {
  const description = object.bot?.description.trim();
  return description && !objects.some(row => row.key !== object.key && row.name === object.name && row.bot?.description.trim() === description) ? description : undefined;
}
