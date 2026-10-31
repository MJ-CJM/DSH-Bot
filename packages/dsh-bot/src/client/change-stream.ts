import type { Context } from '@deepseek-ai/cordis';
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol';
import { botChangeSchema, type BotChange, type DshBotRemoteMethods } from '../shared/remote-contract.js';

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
  ctx.effect(
    () => async () => {
      disposed = true;
      await stop();
    },
    'dsh-bot: Client change stream',
  );
  return {
    stop,
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
