import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { createChangeStream } from './change-stream.js';

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 1_000;
export const MAX_POLL_INTERVAL_MS = 60_000;
export interface PollingOptions { pollIntervalMs?: number; maxPollIntervalMs?: number }
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
  let streamAllowed = false;
  let revision = 0;
  let unsubscribeReset: (() => void) | undefined;
  const sources = new Set<Source>();
  const page = typeof document === 'undefined' ? undefined : document;
  const view = typeof window === 'undefined' ? undefined : window;
  let focused = page?.hasFocus?.() ?? true;
  const foreground = () => page?.visibilityState !== 'hidden' && focused;
  const polling = () => foreground() && [...sources].some((source) => source.polling);
  const stream = createChangeStream(ctx, () => { interact(); void refresh(true); });
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!polling()) { streamAllowed = false; void stream.stop(); return; }
    if (!streamAllowed) { streamAllowed = true; stream.start(); }
    // Retry a disconnected stream only at a polling boundary, never in an
    // immediate opening -> refetch -> failed-stream -> opening loop.
    timer = setTimeout(() => { timer = undefined; stream.start(); void refresh(false); }, delay);
  };
  const refresh = async (supersede: boolean) => {
    clear();
    const current = ++revision;
    const selected = [...sources].filter((source) => supersede || source.polling);
    const results = await Promise.all(selected.map((source) => source.refresh(supersede)));
    if (current !== revision) return;
    if (supersede || results.some((changed) => changed === true)) delay = base;
    else if (results.some((changed) => changed === false)) delay = Math.min(Math.max(base, maximum), delay + base);
    schedule();
  };
  const interact = () => { revision++; delay = base; schedule(); };
  const wake = () => { if (foreground()) { interact(); void refresh(true); } else { revision++; clear(); streamAllowed = false; void stream.stop(); } };
  const onVisibility = () => { focused = page?.hasFocus?.() ?? focused; wake(); };
  const onFocus = () => { focused = true; wake(); };
  const onBlur = () => { focused = false; revision++; clear(); streamAllowed = false; void stream.stop(); };
  const start = () => {
    focused = page?.hasFocus?.() ?? true;
    page?.addEventListener('visibilitychange', onVisibility);
    view?.addEventListener('focus', onFocus);
    view?.addEventListener('blur', onBlur);
    page?.addEventListener('pointerdown', interact);
    page?.addEventListener('keydown', interact);
    // Reconnection is an explicit invalidation, including for passive stores.
    unsubscribeReset = ctx.on('connection/reset', () => {
      void stream.stop().then(() => { if (polling()) stream.start(); });
      interact(); void refresh(true);
    });
  };
  const stop = () => {
    revision++;
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
      return () => { sources.delete(source); if (sources.size) schedule(); else stop(); };
    },
    reschedule: schedule,
    interact,
    changed: interact,
    setPollIntervalMs(value) { validatePollInterval(value); base = value; interact(); },
  };
  schedulers.set(ctx, scheduler);
  return scheduler;
}
