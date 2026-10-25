import { z } from 'zod';
import { DshBotError, parseInput } from '../errors.js';
import {
  activityListOptionsSchema,
  activityRecordSchema,
  activitySessionIdSchema,
  isActivityUnread,
} from '../../shared/activity.js';
import type {
  ActivityListOptions,
  ActivityListResult,
  ActivityRecord,
  ActivitySession,
} from '../../shared/activity.js';
import { createActivityPreview } from '../activity/preview.js';
import { timestampSchema } from '../../shared/schema.js';

import { type BotDomain, type StoredActivity, storedActivitySchema, failure, write, compareId } from './domain.js';
export interface ActivityStoreOptions {
  activityMaxSessionsPerBot?: number;
  activityMaxSessionsTotal?: number;
}
export interface ActivityRecordInput {
  sessionId: string;
  botId: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  title?: string;
  /** First actual human message (or screened summary) from a public projection,
   * never a later message inferred from a row that lacks this metadata. */
  firstUserText?: string;
  seq?: number;
  /** Guards queued events from an Agent belonging to a deleted Bot incarnation. */
  expectedBotCreatedAt?: number;
}
const activityOrder = (a: ActivityRecord, b: ActivityRecord) =>
  b.updatedAt - a.updatedAt || compareId(a.sessionId, b.sessionId);
function activityRecord(record: StoredActivity): ActivityRecord {
  // Deliberate allowlist: neither lastEventSeq nor future storage-only fields
  // can escape through list, record or either markRead return branch.
  return {
    sessionId: record.sessionId,
    botId: record.botId,
    updatedAt: record.updatedAt,
    lastMessage: { role: record.lastMessage.role, preview: record.lastMessage.preview, at: record.lastMessage.at },
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.firstUserPreview === undefined ? {} : { firstUserPreview: record.firstUserPreview }),
    ...(record.lastReadAt === undefined ? {} : { lastReadAt: record.lastReadAt }),
  };
}
const publicActivity = (record: StoredActivity): ActivitySession => ({
  ...activityRecord(record),
  unread: isActivityUnread(record),
});

/** Stores only completed-message summaries. The event adapter owns completion
 * coalescing; all writes share the Bot/Memory domain queue and delete boundary.
 */
export class ActivityStore {
  private readonly perBot: number;
  private readonly total: number;

  constructor(
    private readonly domain: BotDomain,
    options: ActivityStoreOptions = {},
  ) {
    const cap = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
    this.perBot = parseInput(cap, options.activityMaxSessionsPerBot ?? 50);
    this.total = parseInput(cap, options.activityMaxSessionsTotal ?? 1000);
  }

  list(options: ActivityListOptions = {}): ActivityListResult {
    const filter = parseInput(activityListOptionsSchema, options);
    try {
      const bots = [...this.domain.table('bots').entries()]
        .map(([, bot]) => bot)
        .filter((bot) => filter.botId === undefined || bot.id === filter.botId)
        .sort((a, b) => compareId(a.id, b.id));
      const owners = new Set(bots.map((bot) => bot.id));
      const sessions = [...this.domain.table('activities').entries()]
        .map(([, record]) => record)
        .filter((record) => owners.has(record.botId))
        .sort(activityOrder)
        .map(publicActivity);
      return {
        sessions,
        bots: bots.map((bot) => {
          const owned = sessions.filter((record) => record.botId === bot.id);
          const latest = owned[0];
          return {
            botId: bot.id,
            lastActivityAt: latest?.updatedAt ?? 0,
            unreadCount: owned.filter((record) => record.unread).length,
            ...(latest ? { latest: { sessionId: latest.sessionId, ...latest.lastMessage } } : {}),
          };
        }),
      };
    } catch (error) {
      const wrapped = failure(error);
      if (wrapped.code === 'store/unavailable') return { sessions: [], bots: [] };
      throw wrapped;
    }
  }

  async record(input: ActivityRecordInput): Promise<ActivityRecord | undefined> {
    // Do not pass raw text/title to validation errors or the persistence layer.
    if (
      typeof input.text !== 'string' ||
      (input.title !== undefined && typeof input.title !== 'string') ||
      (input.firstUserText !== undefined && typeof input.firstUserText !== 'string')
    ) {
      throw new DshBotError('bot/invalid', 'Activity text and title must be strings');
    }
    const fields = parseInput(activityRecordSchema, {
      sessionId: input.sessionId,
      botId: input.botId,
      updatedAt: input.at,
      lastMessage: { role: input.role, preview: createActivityPreview(input.text), at: input.at },
      ...(input.title === undefined ? {} : { title: createActivityPreview(input.title) }),
    });
    const expected = parseInput(timestampSchema.optional(), input.expectedBotCreatedAt);
    const seq = parseInput(timestampSchema.optional(), input.seq);
    const firstUserPreview = input.firstUserText === undefined ? undefined : createActivityPreview(input.firstUserText);
    return write(this.domain, async () => {
      const bot = this.domain.table('bots').get(fields.botId);
      // A deleted Bot cannot be resurrected by a still-live Agent or late event.
      if (!bot || (expected !== undefined && bot.createdAt !== expected)) return;
      const table = this.domain.table('activities');
      const previous = table.get(fields.sessionId);
      if (previous && previous.botId !== fields.botId) return;
      if (previous) {
        const stale =
          seq !== undefined && previous.lastEventSeq !== undefined
            ? seq <= previous.lastEventSeq
            : previous.updatedAt > fields.updatedAt ||
              (previous.updatedAt === fields.updatedAt &&
                previous.lastMessage.role === fields.lastMessage.role &&
                previous.lastMessage.preview === fields.lastMessage.preview);
        if (stale) return activityRecord(previous);
      }
      // Public event times have millisecond resolution. Logical advancement
      // preserves completion order and read->reply unread status within one ms.
      const at = Math.max(
        fields.lastMessage.at,
        previous ? previous.lastMessage.at + 1 : 0,
        previous?.lastReadAt === undefined ? 0 : previous.lastReadAt + 1,
      );
      const record = parseInput(storedActivitySchema, {
        ...previous,
        ...fields,
        updatedAt: at,
        lastMessage: { ...fields.lastMessage, at },
        ...(previous?.firstUserPreview !== undefined
          ? { firstUserPreview: previous.firstUserPreview }
          : firstUserPreview !== undefined
            ? { firstUserPreview }
            : {}),
        ...(seq === undefined ? {} : { lastEventSeq: seq }),
      });
      // Evict before adding so even partial backend failures cannot exceed caps.
      const retained = await this.pruneRows(record);
      if (!retained) return;
      await table.put(record.sessionId, record);
      return activityRecord(record);
    });
  }

  async markRead(sessionId: string): Promise<ActivitySession> {
    const key = parseInput(activitySessionIdSchema, sessionId);
    return write(
      this.domain,
      async () => {
        const table = this.domain.table('activities');
        const previous = table.get(key);
        if (!previous || !this.domain.table('bots').get(previous.botId)) {
          throw new DshBotError('activity/not-found', 'Bot session activity was not found');
        }
        // Marking read does not change recency or eviction order. Clock rollback
        // never makes a read timestamp go backwards; same-clock retries do no I/O.
        const now = Math.max(Date.now(), previous.lastMessage.at, previous.lastReadAt ?? 0);
        if (previous.lastReadAt === now) return publicActivity(previous);
        const record = parseInput(storedActivitySchema, { ...previous, lastReadAt: now });
        await table.put(key, record);
        return publicActivity(record);
      },
      'activity/not-found',
    );
  }

  /** Apply changed caps after reopening, without rewriting retained summaries. */
  async prune(): Promise<void> {
    await write(this.domain, async () => {
      await this.pruneRows();
    });
  }

  private async pruneRows(incoming?: StoredActivity): Promise<boolean> {
    const table = this.domain.table('activities');
    const rows = [...table.entries()]
      .map(([, record]) => record)
      .filter((record) => record.sessionId !== incoming?.sessionId);
    if (incoming) rows.push(incoming);
    rows.sort(activityOrder);
    const counts = new Map<string, number>();
    const keep = new Set<string>();
    for (const row of rows) {
      const count = counts.get(row.botId) ?? 0;
      if (keep.size >= this.total || count >= this.perBot) continue;
      keep.add(row.sessionId);
      counts.set(row.botId, count + 1);
    }
    for (const [id] of table.entries()) {
      if (!keep.has(id)) await table.delete(id);
    }
    return incoming === undefined || keep.has(incoming.sessionId);
  }
}
