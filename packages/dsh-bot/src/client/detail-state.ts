import type { Context } from '@deepseek-ai/cordis';

export interface ProactiveDetailTarget {
  kind: 'suggestion' | 'work';
  id: string;
}
export type BotDetailTarget = ProactiveDetailTarget | { kind: 'other-work' };
export interface BotDetailDestination {
  botCreatedAt?: number;
  section?: 'work' | 'memory';
  target?: BotDetailTarget;
}
export interface BotDetailRequest extends BotDetailDestination {
  botId: string;
  requestId: number;
}
export interface BotDetailSource {
  getSnapshot(): BotDetailRequest | undefined;
  subscribe(listener: () => void): () => void;
  open(botId: string, destination?: BotDetailDestination): void;
  consume(requestId: number): void;
}

/** A one-shot request survives panel navigation and is consumed only after the Bot loads. */
export function createBotDetailSource(ctx: Context): BotDetailSource {
  let snapshot: BotDetailRequest | undefined;
  let sequence = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  ctx.effect(
    () => () => {
      disposed = true;
      snapshot = undefined;
      listeners.clear();
    },
    'dsh-bot: detail navigation',
  );
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(botId, destination) {
      if (disposed) return;
      snapshot = { botId, ...destination, requestId: ++sequence };
      for (const listener of listeners) listener();
    },
    consume(requestId) {
      if (snapshot?.requestId !== requestId) return;
      snapshot = undefined;
      for (const listener of listeners) listener();
    },
  };
}
