import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { z } from 'zod';
import type {} from '../shared/remote-contract.js';

export type DshBotErrorCode = 'bot/not-found' | 'bot/conflict' | 'bot/invalid'
  | 'memory/not-found' | 'memory/too-large' | 'memory/rejected' | 'store/unavailable' | 'activity/not-found'
  | 'bot/preset-failed' | 'bot/rollback-failed' | 'bot/unavailable' | 'bot/home-cleanup-failed';

/** Preserve the Store's error vocabulary while using DSH's actual wire error. */
export class DshBotError extends RemoteError<DshBotErrorCode> {
  override readonly name = 'DshBotError';
  constructor(code: DshBotErrorCode, message: string, options?: ErrorOptions) {
    super(code, message, {}, options);
  }
}

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const tooLarge = result.error.issues.some((issue) => issue.code === 'custom' && issue.params?.code === 'memory/too-large');
  throw new DshBotError(tooLarge ? 'memory/too-large' : 'bot/invalid', result.error.message, { cause: result.error });
}
