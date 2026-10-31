import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import type { BotStatus, DshBotRemoteMethods } from '../shared/remote-contract.js';
import type { BotRecord } from '../shared/schema.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  sharedPollingScheduler,
  validatePollInterval,
  type PollingOptions,
} from './polling-scheduler.js';
import { structuralEqual } from './structural-equal.js';
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
} from './polling-scheduler.js';

export type BotPresetStatus = BotStatus;
export interface BotCatalogEntry {
  bot: BotRecord;
  status?: BotPresetStatus;
}
export interface CatalogError {
  code?: string;
  message: string;
}
export interface CatalogSnapshot extends PollingSnapshot {
  readonly entries: readonly BotCatalogEntry[];
  readonly presetIdPrefix?: string;
}
export interface PollingSnapshot {
  readonly loading: boolean;
  /** A failed refresh retains the last successful entries and this diagnostic. */
  readonly error?: CatalogError;
  readonly loaded: boolean;
  readonly pollIntervalMs: number;
}
export interface BotCatalog {
  subscribe(listener: () => void): () => void;
  observe(listener: () => void): () => void;
  getSnapshot(): CatalogSnapshot;
  /** Always supersedes older reads, including reads started before a mutation. */
  refresh(): Promise<void>;
  setPollIntervalMs(value: number): void;
  dispose(): void;
}
export interface BotCatalogOptions extends PollingOptions {}

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
    pending.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Framework-independent catalog; its active resources follow the first/last
 * subscriber, while the owning Cordis effect permanently disposes the store.
 * Mutation callers await refresh() to supersede reads predating their writes.
 */
export interface PollingCatalog<Payload> {
  subscribe(listener: () => void): () => void;
  observe(listener: () => void): () => void;
  getSnapshot(): Payload & PollingSnapshot;
  refresh(): Promise<void>;
  setPollIntervalMs(value: number): void;
  reset(value: Payload): void;
  dispose(): void;
}

export function createPollingCatalog<Payload>(
  ctx: Context,
  initial: Payload,
  load: () => Promise<Payload>,
  options: BotCatalogOptions = {},
): PollingCatalog<Payload> {
  let pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  validatePollInterval(pollIntervalMs);
  const scheduler = sharedPollingScheduler(ctx, options);
  let snapshot: Payload & PollingSnapshot = { ...initial, loading: true, loaded: false, pollIntervalMs };
  const listeners = new Set<() => void>();
  const pollers = new Set<() => void>();
  let epoch = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let releaseScheduler: (() => void) | undefined;
  const publish = (next: Payload & PollingSnapshot) => {
    if (structuralEqual(snapshot, next)) return false;
    snapshot = next;
    for (const listener of listeners) listener();
    return true;
  };
  const cancelRead = () => {
    epoch++;
    controller?.abort();
    controller = undefined;
  };
  const read = async (): Promise<boolean | undefined> => {
    if (disposed) return undefined;
    cancelRead();
    const current = epoch;
    const request = new AbortController();
    controller = request;
    // Background fetches leave successful data and its UI state untouched.
    if (!snapshot.loaded && !snapshot.error) publish({ ...snapshot, loading: true });
    try {
      if (request.signal.aborted || disposed) return;
      const result = await untilAborted(load(), request.signal);
      if (!result || disposed || request.signal.aborted || current !== epoch) return;
      return publish({ ...result, loading: false, loaded: true, pollIntervalMs });
    } catch (error: unknown) {
      if (disposed || request.signal.aborted || current !== epoch) return;
      return publish({ ...snapshot, loading: false, error: diagnostic(error) });
    } finally {
      if (controller === request) controller = undefined;
    }
  };
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    scheduler.interact();
    if (await read()) scheduler.changed();
  };
  const source = {
    polling: false,
    // Slow requests finish instead of being starved by periodic invalidation.
    refresh: (supersede: boolean) => (!supersede && controller ? Promise.resolve(undefined) : read()),
  };
  const stop = () => {
    cancelRead();
    releaseScheduler?.();
    releaseScheduler = undefined;
    if (snapshot.loading) snapshot = { ...snapshot, loading: false };
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    listeners.clear();
    pollers.clear();
  };
  const subscribe = (listener: () => void, polling: boolean) => {
    if (disposed) return () => {};
    const subscription = () => listener();
    listeners.add(subscription);
    if (polling) pollers.add(subscription);
    source.polling = pollers.size > 0;
    if (listeners.size === 1) {
      releaseScheduler = scheduler.register(source);
    } else scheduler.reschedule();
    // A newly mounted page/badge gets a current view, even when another consumer remains.
    if (listeners.size === 1 || (polling && pollers.size === 1)) void refresh();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(subscription);
      pollers.delete(subscription);
      source.polling = pollers.size > 0;
      if (listeners.size === 0) stop();
      else scheduler.reschedule();
    };
  };
  const disposeOwner = ctx.effect(() => dispose, 'dsh-bot: catalog');
  return {
    getSnapshot: () => snapshot,
    refresh,
    reset(value) {
      if (disposed) return;
      cancelRead();
      publish({ ...value, loading: true, loaded: false, pollIntervalMs });
    },
    setPollIntervalMs(value) {
      validatePollInterval(value);
      if (disposed || value === pollIntervalMs) return;
      pollIntervalMs = value;
      scheduler.setPollIntervalMs(value);
      publish({ ...snapshot, pollIntervalMs });
    },
    dispose: () => {
      void disposeOwner();
    },
    subscribe: (listener) => subscribe(listener, true),
    observe: (listener) => subscribe(listener, false),
  };
}

export function createBotCatalog(ctx: Context, options: BotCatalogOptions = {}): BotCatalog {
  return createPollingCatalog<{ entries: readonly BotCatalogEntry[]; presetIdPrefix?: string }>(
    ctx,
    { entries: [] },
    async () => {
      const remote = ctx.get('remote.dshBot') as DshBotRemoteMethods | undefined;
      if (!remote) throw { code: 'bot/unavailable', message: '' };
      const [bots, statuses, info] = await Promise.all([remote.list(), remote.status(), remote.catalogInfo()]);
      if (!bots.ok) throw bots.error;
      if (!statuses.ok) throw statuses.error;
      if (!info.ok) throw info.error;
      const byId = new Map(statuses.value.map((status) => [status.id, status]));
      return {
        presetIdPrefix: info.value.presetIdPrefix,
        entries: bots.value.map((bot) => ({ bot, status: byId.get(bot.id) })),
      };
    },
    options,
  );
}
