import { createHash } from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { z } from 'zod';
export type P34Code = 'invalid' | 'conflict' | 'not-found' | 'unavailable' | 'unsupported' | 'approval-denied' | 'recovery-needed';
export class P34Error extends RemoteError<`p34/${P34Code}`> {
  constructor(code: P34Code) { super(`p34/${code}`, `P34: ${code}`, {}); }
}
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value); if (!result.success) throw new P34Error('invalid'); return result.data;
}
// Inputs have a fixed schema/key order before hashing; never hash secret values.
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new P34Error('unavailable'));
    const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next;
  }
  async close() { this.stopped = true; await this.tail; }
}

type P34Errors = { [K in `p34/${P34Code}`]: Record<string, never> };
declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteErrorDetailsMap extends P34Errors {} }

export function need<T>(value: T | undefined): T { if (value === undefined) throw new P34Error('unavailable'); return value; }
