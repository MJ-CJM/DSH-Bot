import { createHash } from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { z } from 'zod';
export type OperationCode =
  | 'invalid'
  | 'conflict'
  | 'not-found'
  | 'unavailable'
  | 'unsupported'
  | 'approval-denied'
  | 'recovery-needed';
export class OperationError extends RemoteError<`p34/${OperationCode}`> {
  constructor(code: OperationCode) {
    super(`p34/${code}`, `P34: ${code}`, {});
  }
}
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new OperationError('invalid');
  return result.data;
}
// Inputs have a fixed schema/key order before hashing; never hash secret values.
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new OperationError('unavailable'));
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async close() {
    this.stopped = true;
    await this.tail;
  }
}

type OperationErrors = { [K in `p34/${OperationCode}`]: Record<string, never> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap extends OperationErrors {}
}

export function need<T>(value: T | undefined): T {
  if (value === undefined) throw new OperationError('unavailable');
  return value;
}
