import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { BotStatus, DshBotRemoteMethods } from '../shared/remote-contract.js';
import type { BotRecord } from '../shared/schema.js';

export type BotPresetStatus = BotStatus;
export interface BotCatalogEntry { bot: BotRecord; status?: BotPresetStatus }
export interface CatalogError { code?: string; message: string }
export interface CatalogSnapshot {
  readonly entries: readonly BotCatalogEntry[];
  readonly loading: boolean;
  /** A failed refresh retains the last successful entries and this diagnostic. */
  readonly error?: CatalogError;
  readonly loaded: boolean;
  readonly pollIntervalMs: number;
}
export interface BotCatalog {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CatalogSnapshot;
  /** Always supersedes older reads, including reads started before a mutation. */
  refresh(): Promise<void>;
  setPollIntervalMs(value: number): void;
  dispose(): void;
}
export interface BotCatalogOptions { pollIntervalMs?: number }
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 60_000;

function validatePollInterval(value: number): void {
  if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
    throw new RangeError(`pollIntervalMs must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}`);
  }
}

function diagnostic(error: unknown): CatalogError {
  if (typeof error === 'object' && error !== null) {
    const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    return { message, ...(code ? { code } : {}) };
  }
  return { message: typeof error === 'string' ? error : '' };
}

/** The unary Remote contract has no cancellation argument. Abort stops local
 * waiting, and epoch checks discard late carrier responses without claiming to
 * cancel a Host operation. Both success and failure handlers remain attached.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then((result) => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/** Framework-independent catalog; its active resources follow the first/last
 * subscriber, while the owning Cordis effect permanently disposes the store.
 * There is deliberately no custom changed-event subscription: rc.2 does not
 * forward third-party events. Mutation callers must await refresh() afterward.
 */
export function createBotCatalog(ctx: Context, options: BotCatalogOptions = {}): BotCatalog {
  let pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  validatePollInterval(pollIntervalMs);
  let snapshot: CatalogSnapshot = { entries: [], loading: true, loaded: false, pollIntervalMs };
  const listeners = new Set<() => void>();
  let epoch = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeReset: (() => void) | undefined;
  const page = typeof document === 'undefined' ? undefined : document;
  const visible = () => page?.visibilityState !== 'hidden';
  const publish = (next: CatalogSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const cancelRead = () => {
    epoch++;
    controller?.abort();
    controller = undefined;
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    cancelRead();
    const current = epoch;
    const request = new AbortController();
    controller = request;
    publish({ ...snapshot, loading: true });
    try {
      if (request.signal.aborted || disposed) return;
      const remote = ctx.get('remote.dshBot') as DshBotRemoteMethods | undefined;
      if (!remote) throw { code: 'bot/unavailable', message: '' };
      const result = await untilAborted(Promise.all([remote.list(), remote.status()]), request.signal);
      if (!result || disposed || request.signal.aborted || current !== epoch) return;
      const [bots, statuses] = result;
      if (!bots.ok) throw bots.error;
      if (!statuses.ok) throw statuses.error;
      const byId = new Map(statuses.value.map((status) => [status.id, status]));
      publish({
        entries: bots.value.map((bot) => ({ bot, status: byId.get(bot.id) })),
        loading: false,
        loaded: true,
        pollIntervalMs,
      });
    } catch (error: unknown) {
      if (disposed || request.signal.aborted || current !== epoch) return;
      publish({ ...snapshot, loading: false, error: diagnostic(error) });
    } finally {
      if (controller === request) controller = undefined;
    }
  };
  const schedulePoll = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (!listeners.size || disposed) return;
    timer = setInterval(() => {
      // Slow reads finish instead of being starved by periodic invalidation.
      if (visible() && !controller) void refresh();
    }, pollIntervalMs);
  };
  const onVisibility = () => { if (visible()) void refresh(); };
  const stop = () => {
    cancelRead();
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    unsubscribeReset?.();
    unsubscribeReset = undefined;
    page?.removeEventListener('visibilitychange', onVisibility);
    snapshot = { ...snapshot, loading: false };
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    listeners.clear();
  };
  const disposeOwner = ctx.effect(() => dispose, 'dsh-bot: catalog');
  return {
    getSnapshot: () => snapshot,
    refresh,
    setPollIntervalMs(value) {
      validatePollInterval(value);
      if (disposed || value === pollIntervalMs) return;
      pollIntervalMs = value;
      schedulePoll();
      publish({ ...snapshot, pollIntervalMs });
    },
    dispose: () => { void disposeOwner(); },
    subscribe(listener) {
      if (disposed) return () => {};
      // A wrapper gives repeated subscriptions with the same callback their own lease.
      const subscription = () => listener();
      listeners.add(subscription);
      if (listeners.size === 1) {
        unsubscribeReset = ctx.on('connection/reset', () => { void refresh(); });
        page?.addEventListener('visibilitychange', onVisibility);
        schedulePoll();
        void refresh();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(subscription);
        if (listeners.size === 0) stop();
      };
    },
  };
}
