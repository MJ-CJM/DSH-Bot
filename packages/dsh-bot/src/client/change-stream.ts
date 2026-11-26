import type { Context } from '@deepseek-ai/cordis';
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import { botChangeSchema, type BotChange, type DshBotRemoteMethods } from '../shared/remote-contract.js';

interface StreamRunner {
  start(): void;
  stop(): Promise<void>;
  isOpen(): boolean;
}

function createStreamRunner(ctx: Context, changed: () => void, label?: string): StreamRunner {
  type Run = { abort: AbortController; handle: RemoteStreamHandle<BotChange, never>; done: Promise<void> };
  let current: Run | undefined;
  let disposed = false;
  const stop = async () => {
    const previous = current;
    current = undefined;
    if (!previous) return;
    previous.abort.abort();
    previous.handle.dispose();
    await previous.done;
  };
  if (label) {
    ctx.effect(
      () => async () => {
        disposed = true;
        await stop();
      },
      label,
    );
  }
  return {
    stop,
    isOpen: () => !disposed && current !== undefined,
    start() {
      if (disposed || current) return;
      const remote = ctx.get('remote.dshBot') as DshBotRemoteMethods | undefined;
      // Older hosts and lightweight Client doubles remain on polling.
      if (!remote?.watch) return;
      const abort = new AbortController();
      let handle: RemoteStreamHandle<BotChange, never>;
      try {
        handle = remote.watch(abort.signal);
      } catch {
        return;
      }
      const run: Run = { abort, handle, done: Promise.resolve() };
      current = run;
      run.done = (async () => {
        try {
          for await (const change of handle) {
            if (disposed || current !== run || abort.signal.aborted) break;
            // rc.2's raw stream path does not run result.decode (unlike unary).
            botChangeSchema.parse(change);
            changed();
          }
        } catch {
          // Stream failure does not discard good catalogs or replace their
          // inline query errors. The scheduler retries and continues polling.
        } finally {
          handle.dispose();
          if (current === run) current = undefined;
        }
      })();
    },
  };
}

/** Optional push invalidations over the public raw Remote stream. The shared
 * scheduler owns retry timing and foreground leases; this owns cancellation.
 * Every generation's opening triggers an authoritative refetch, so neither a
 * disconnected interval nor a coalesced burst needs a durable event cursor.
 */
export function createChangeStream(
  ctx: Context,
  changed: () => void,
): {
  start(): void;
  stop(): Promise<void>;
} {
  const runner = createStreamRunner(ctx, changed, 'dsh-bot: Client change stream');
  return { start: runner.start, stop: runner.stop };
}

export interface ChangeStreamLease {
  start(): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SharedChangeStream {
  lease(changed: () => void): ChangeStreamLease;
  restart(): Promise<void>;
  isActive(): boolean;
}

const sharedStreams = new WeakMap<Context, SharedChangeStream>();

/** One raw Remote change stream broadcaster per Client context shared across
 * polling-scheduler, Supergroup, and task-support consumers.
 */
export function sharedChangeStream(ctx: Context): SharedChangeStream {
  const existing = sharedStreams.get(ctx);
  if (existing) return existing;
  const activeLeases = new Set<() => void>();
  let disposed = false;
  const runner = createStreamRunner(ctx, () => {
    for (const listener of [...activeLeases]) listener();
  });
  ctx.effect(
    () => async () => {
      disposed = true;
      activeLeases.clear();
      sharedStreams.delete(ctx);
      await runner.stop();
    },
    'dsh-bot: shared Client change stream',
  );
  const shared: SharedChangeStream = {
    lease(changed) {
      let leaseDisposed = false;
      const listener = () => {
        if (!leaseDisposed) changed();
      };
      const stop = async () => {
        activeLeases.delete(listener);
        if (!activeLeases.size) await runner.stop();
      };
      return {
        start() {
          if (disposed || leaseDisposed) return;
          activeLeases.add(listener);
          runner.start();
        },
        stop,
        async dispose() {
          if (leaseDisposed) return;
          leaseDisposed = true;
          await stop();
        },
      };
    },
    async restart() {
      await runner.stop();
      if (!disposed && activeLeases.size) runner.start();
    },
    isActive: () => !disposed && runner.isOpen(),
  };
  sharedStreams.set(ctx, shared);
  return shared;
}
