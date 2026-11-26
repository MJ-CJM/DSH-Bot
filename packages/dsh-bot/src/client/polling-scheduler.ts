import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { sharedChangeStream } from './change-stream.js';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 60_000;
export interface PollingOptions {
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}
export function validatePollInterval(value: number): void {
  if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
    throw new RangeError(`pollIntervalMs must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}`);
  }
}

interface Source {
  refresh(supersede: boolean): Promise<boolean | undefined>;
  polling: boolean;
}
interface Scheduler {
  register(source: Source): () => void;
  reschedule(): void;
  interact(): void;
  changed(): void;
  setPollIntervalMs(value: number): void;
}
const schedulers = new WeakMap<Context, Scheduler>();

/** One timer and one set of browser listeners per Client context. Every source
 * lease is released by its catalog's Cordis effect, including passive observers.
 */
export function sharedPollingScheduler(ctx: Context, options: PollingOptions): Scheduler {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maximum = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
  validatePollInterval(interval);
  validatePollInterval(maximum);
  const existing = schedulers.get(ctx);
  if (existing) return existing;
  let base = interval;
  let delay = base;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextFireAt: number | undefined;
  let streamAllowed = false;
  let revision = 0;
  let refreshing = false;
  let interactedDuringRefresh = false;
  let unsubscribeReset: (() => void) | undefined;
  const sources = new Set<Source>();
  const page = typeof document === 'undefined' ? undefined : document;
  const view = typeof window === 'undefined' ? undefined : window;
  let focused = page?.hasFocus?.() ?? true;
  const foreground = () => page?.visibilityState !== 'hidden' && focused;
  const polling = () => foreground() && [...sources].some((source) => source.polling);
  const sharedStream = sharedChangeStream(ctx);
  const stream = sharedStream.lease(() => {
    interact();
    void refresh(true);
  });
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    nextFireAt = undefined;
  };
  const arm = (waitMs: number) => {
    clear();
    if (!polling()) {
      streamAllowed = false;
      void stream.stop();
      return;
    }
    if (!streamAllowed) {
      streamAllowed = true;
      stream.start();
    }
    const clamped = Math.max(0, waitMs);
    nextFireAt = Date.now() + clamped;
    // Retry a disconnected stream only at a polling boundary, never in an
    // immediate opening -> refetch -> failed-stream -> opening loop.
    timer = setTimeout(() => {
      timer = undefined;
      nextFireAt = undefined;
      stream.start();
      void refresh(false);
    }, clamped);
  };
  const schedule = () => {
    arm(delay);
  };
  const refresh = async (supersede: boolean) => {
    clear();
    const current = ++revision;
    refreshing = true;
    interactedDuringRefresh = false;
    const selected = [...sources].filter((source) => supersede || source.polling);
    const settled = await Promise.allSettled(
      selected.map((source) => Promise.resolve().then(() => source.refresh(supersede))),
    );
    if (current !== revision) return;
    refreshing = false;
    const results = settled.map((entry) => (entry.status === 'fulfilled' ? entry.value : undefined));
    if (supersede || interactedDuringRefresh || results.some((changed) => changed === true)) delay = base;
    else if (results.some((changed) => changed === false)) delay = Math.min(Math.max(base, maximum), delay + base);
    interactedDuringRefresh = false;
    schedule();
  };
  const reset = () => {
    revision++;
    refreshing = false;
    interactedDuringRefresh = false;
    delay = base;
    schedule();
  };
  const interact = () => {
    delay = base;
    if (!polling()) {
      clear();
      streamAllowed = false;
      void stream.stop();
      return;
    }
    if (refreshing) {
      interactedDuringRefresh = true;
      return;
    }
    // Never postpone an imminent poll while the user is actively typing/clicking;
    // only pull a backed-off timer forward or arm when no timer is scheduled.
    const target = Date.now() + base;
    if (timer === undefined || nextFireAt === undefined || nextFireAt > target) {
      arm(base);
    }
  };
  const wake = () => {
    if (foreground()) {
      interact();
      void refresh(true);
    } else {
      revision++;
      refreshing = false;
      interactedDuringRefresh = false;
      clear();
      streamAllowed = false;
      void stream.stop();
    }
  };
  const onVisibility = () => {
    focused = page?.hasFocus?.() ?? focused;
    wake();
  };
  const onFocus = () => {
    focused = true;
    wake();
  };
  const onBlur = () => {
    focused = false;
    revision++;
    refreshing = false;
    interactedDuringRefresh = false;
    clear();
    streamAllowed = false;
    void stream.stop();
  };
  const start = () => {
    focused = page?.hasFocus?.() ?? true;
    page?.addEventListener('visibilitychange', onVisibility);
    view?.addEventListener('focus', onFocus);
    view?.addEventListener('blur', onBlur);
    page?.addEventListener('pointerdown', interact);
    page?.addEventListener('keydown', interact);
    // Reconnection is an explicit invalidation, including for passive stores.
    unsubscribeReset = ctx.on('connection/reset', () => {
      void sharedStream.restart();
      interact();
      void refresh(true);
    });
  };
  const stop = () => {
    revision++;
    refreshing = false;
    interactedDuringRefresh = false;
    clear();
    streamAllowed = false;
    void stream.stop();
    unsubscribeReset?.();
    unsubscribeReset = undefined;
    page?.removeEventListener('visibilitychange', onVisibility);
    view?.removeEventListener('focus', onFocus);
    view?.removeEventListener('blur', onBlur);
    page?.removeEventListener('pointerdown', interact);
    page?.removeEventListener('keydown', interact);
  };
  const scheduler: Scheduler = {
    register(source) {
      sources.add(source);
      if (sources.size === 1) start();
      schedule();
      return () => {
        sources.delete(source);
        if (sources.size) schedule();
        else stop();
      };
    },
    reschedule: schedule,
    interact,
    changed: reset,
    setPollIntervalMs(value) {
      validatePollInterval(value);
      base = value;
      reset();
    },
  };
  schedulers.set(ctx, scheduler);
  return scheduler;
}
