import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { GroupDelivery, GroupTurn, GroupView } from '../shared/groups.js';

const count = z.number().finite().nonnegative();
const activitySchema = z.object({ turns: count, steps: count, decodeTokens: count, decodeMs: count });
const usageSchema = z.object({ uncachedInputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, outputTokens: count });
const modelSchema = z.object({ provider: z.string(), model: z.string() });
const modelSelectionSchema = z.object({ lastUsed: modelSchema.nullable(), next: modelSchema.nullable() });
const pressureSchema = z.object({ projectedTokens: count.optional(), pressureTokens: count.optional(), contextWindow: count.positive().optional() });
export type Usage = z.output<typeof usageSchema>;
export interface ChildStatistics {
  state: 'loading' | 'ready' | 'unavailable';
  activity?: z.output<typeof activitySchema>;
  usage?: Usage;
  pressure?: z.output<typeof pressureSchema>;
  binding?: SessionBinding;
  modelSelection?: z.output<typeof modelSelectionSchema>;
}
export const loadingStatistics: ChildStatistics = { state: 'loading' };
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const result = schema.safeParse(value); return result.success ? result.data : undefined;
};
export function readStatistics(binding: SessionBinding): ChildStatistics {
  const read = (key: string) => binding.session.projections.faceOf(key).getSnapshot();
  return { state: binding.session.getSnapshot().openState === 'error' ? 'unavailable' : 'ready', binding,
    activity: parsed(activitySchema, read('sessionStats')), usage: parsed(usageSchema, read('tokenUsage')),
    modelSelection: parsed(modelSelectionSchema, read('modelSelection')),
    pressure: parsed(pressureSchema, read('contextPressure')) };
}
export const tokenTotal = (usage: Usage) => usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
export const cachePercent = (usage: Usage) => {
  const input = tokenTotal(usage) - usage.outputTokens;
  return input > 0 ? usage.cacheReadTokens / input * 100 : undefined;
};
export const contextPercent = (snapshot: Pick<ChildStatistics, 'modelSelection' | 'pressure'>) => {
  const last = snapshot.modelSelection?.lastUsed, next = snapshot.modelSelection?.next;
  if (last && next && (last.provider !== next.provider || last.model !== next.model)) return undefined;
  const value = snapshot.pressure?.projectedTokens ?? snapshot.pressure?.pressureTokens;
  const window = snapshot.pressure?.contextWindow;
  return value !== undefined && window ? Math.min(100, value / window * 100) : undefined;
};
export function aggregateStatistics(rows: ChildStatistics[]) {
  const usages = rows.flatMap(row => row.state === 'ready' && row.usage ? [row.usage] : []);
  const activities = rows.flatMap(row => row.state === 'ready' && row.activity ? [row.activity] : []);
  return {
    readable: rows.filter(row => row.state === 'ready').length,
    reported: usages.filter(row => tokenTotal(row) > 0).length,
    usage: usages.length ? usages.reduce((a, b) => ({ uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
      cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
      outputTokens: a.outputTokens + b.outputTokens })) : undefined,
    activity: activities.length ? { turns: activities.reduce((n, row) => n + row.turns, 0), steps: activities.reduce((n, row) => n + row.steps, 0) } : undefined,
    activityComplete: activities.length === rows.length,
  };
}

/** Receipts are not workers. Reject a child claimed by different questions/members. */
export function statisticsDeliveries(view: Pick<GroupView, 'deliveries'>, turnId: string) {
  const workers = view.deliveries.filter(row => row.reasonCode !== 'message-published' && !row.joinedDeliveryId);
  const owners = new Map<string, Set<string>>();
  for (const row of workers) if (row.childSessionId) {
    const set = owners.get(row.childSessionId) ?? new Set<string>();
    set.add(JSON.stringify([row.turnId, row.memberId])); owners.set(row.childSessionId, set);
  }
  const rows = new Map<string, GroupDelivery>();
  for (const row of workers) if (row.turnId === turnId) rows.set(row.childSessionId ?? row.id, row);
  return [...rows.values()].map(delivery => ({ delivery, conflict: Boolean(delivery.childSessionId && (owners.get(delivery.childSessionId)?.size ?? 0) > 1) }));
}
const ACTIVE_TURN = ['accepted', 'running', 'paused'];
/**
 * Every started member session of the group, each once: a session claimed by several
 * questions is counted under its first question instead of being excluded. `live`
 * marks sessions whose numbers can still change.
 */
export function groupStatisticsWorkers(view: Pick<GroupView, 'deliveries' | 'turns'>) {
  const active = new Set(view.turns.filter(turn => ACTIVE_TURN.includes(turn.state)).map(turn => turn.id));
  const rows = new Map<string, { delivery: GroupDelivery; childId: string; live: boolean }>();
  for (const delivery of view.deliveries) {
    const childId = delivery.childSessionId;
    if (!childId || delivery.reasonCode === 'message-published' || delivery.joinedDeliveryId || ['pending', 'starting'].includes(delivery.state) || rows.has(childId)) continue;
    rows.set(childId, { delivery, childId, live: active.has(delivery.turnId) || ['running', 'unknown'].includes(delivery.state) });
  }
  return [...rows.values()];
}
/**
 * One reading of a settled session: subscribe (which retains the native session), take
 * the first non-loading snapshot, then unsubscribe so the lease is released at once.
 */
export function readStatisticsOnce(source: StatisticsSource, signal: AbortSignal, timeoutMs = 20_000): Promise<ChildStatistics> {
  return new Promise(resolve => {
    let off: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const finish = (value: ChildStatistics) => {
      if (done) return; done = true;
      if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', abort); off?.(); resolve(value);
    };
    const abort = () => finish(loadingStatistics);
    const check = () => { const value = source.getSnapshot(); if (value.state !== 'loading') finish(value); };
    if (signal.aborted) { resolve(loadingStatistics); return; }
    signal.addEventListener('abort', abort);
    timer = setTimeout(() => finish({ state: 'unavailable' }), timeoutMs);
    off = source.subscribe(check);
    if (done) off(); else check();
  });
}
export function defaultStatisticsTurn(turns: GroupTurn[]) {
  const recent = [...turns].sort((a, b) => b.createdAt - a.createdAt);
  return recent.find(turn => ['accepted', 'running', 'paused'].includes(turn.state)) ?? recent[0];
}

export interface StatisticsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ChildStatistics;
}
/** One exact native reference per parent/child, shared by process, footer and details.
 * Idle handles retain only their identity until plugin disposal, never a binding or subscription.
 * Stable handles also prevent duplicate leases when React replays an effect. */
export class GroupStatsSource {
  private entries = new Map<string, StatisticsSource & { dispose(): void }>();
  private disposed = false;
  constructor(private readonly sessions: () => ISessions) {}
  source(parentId: string, childId: string): StatisticsSource {
    const key = JSON.stringify([parentId, childId]);
    const existing = this.entries.get(key); if (existing) return existing;
    let snapshot = loadingStatistics, reference: SessionReference | undefined, generation = 0, queued = false;
    const listeners = new Set<() => void>();
    let frame: number | undefined;
    let unsubscribers: Array<() => void> = [];
    const emit = () => { for (const listener of listeners) listener(); };
    const stop = () => {
      generation++; queued = false;
      if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined;
      for (const off of unsubscribers) off(); unsubscribers = [];
      reference?.release(); reference = undefined; snapshot = loadingStatistics;
      // Keep the lightweight handle stable for concurrent/reactivated consumers.
    };
    const start = () => {
      if (this.disposed) return;
      this.entries.set(key, source);
      const ticket = ++generation;
      try {
        const ref = this.sessions().retain({ parentSessionId: parentId as SessionId, childSessionId: childId as SessionId, mode: 'unknown' }, { source: 'dshBotGroupStatistics' });
        reference = ref;
        void ref.ready.then(() => {
          if (ticket !== generation || this.disposed) return;
          const refresh = () => { snapshot = readStatistics(ref.binding); emit(); };
          const update = () => {
            if (queued) return; queued = true;
            const flush = () => { frame = undefined; if (ticket !== generation || this.disposed) return; queued = false; refresh(); };
            if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(flush); else queueMicrotask(flush);
          };
          unsubscribers = ['sessionStats', 'tokenUsage', 'contextPressure', 'modelSelection'].map(key => ref.binding.session.projections.faceOf(key).subscribe(update));
          let openState = ref.binding.session.getSnapshot().openState;
          unsubscribers.push(ref.binding.session.subscribe(() => {
            const next = ref.binding.session.getSnapshot().openState;
            if (next !== openState) { openState = next; update(); }
          }));
          refresh();
        }).catch(() => { if (ticket === generation && !this.disposed) { snapshot = { state: 'unavailable' }; emit(); } });
      } catch { snapshot = { state: 'unavailable' }; emit(); }
    };
    const source = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
      listeners.add(listener); if (listeners.size === 1) start();
      let live = true;
      return () => { if (!live) return; live = false; listeners.delete(listener); if (!listeners.size) stop(); };
    }, dispose: () => { stop(); listeners.clear(); } };
    this.entries.set(key, source); return source;
  }
  dispose() { this.disposed = true; for (const entry of [...this.entries.values()]) entry.dispose(); this.entries.clear(); }
}
declare module '@deepseek-ai/dsh-api-session-controller/client' { interface SessionReferenceSourceMap { dshBotGroupStatistics: unknown } }
export function createGroupStatsSource(ctx: Context) {
  const source = new GroupStatsSource(() => ctx.get('sessions') as unknown as ISessions);
  ctx.effect(() => () => source.dispose(), 'dsh-bot: group statistics lifetime'); return source;
}
