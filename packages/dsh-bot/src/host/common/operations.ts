import { createHash } from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { z } from 'zod';
import { OPERATION_CODES, type OperationCode, type OperationErrorCode } from '../../shared/operation-errors.js';
export type { OperationCode } from '../../shared/operation-errors.js';
export class OperationError extends RemoteError<OperationErrorCode> {
  constructor(code: OperationCode) {
    super(OPERATION_CODES[code], `DSH-Bot: ${code}`, {});
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

type OperationErrors = { [K in OperationErrorCode]: Record<string, never> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap extends OperationErrors {}
}

export function need<T>(value: T | undefined): T {
  if (value === undefined) throw new OperationError('unavailable');
  return value;
}

const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  'DOMException',
  'AggregateError',
  'OperationError',
  'RemoteError',
]);
const SAFE_ERROR_CODES = new Set<string>([
  ...Object.values(OPERATION_CODES),
  'gateway/internal',
  'gateway/cancelled',
  'gateway/timeout',
  'gateway/unavailable',
  'gateway/input-invalid',
  'gateway/not-found',
  'gateway/unauthorized',
  'gateway/forbidden',
  'gateway/rate-limited',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'EBUSY',
  'EMFILE',
  'ENFILE',
  'EIO',
  'EAGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ECANCELED',
  'ABORT_ERR',
  'ERR_ABORTED',
  'ERR_STREAM_DESTROYED',
]);

/** Redacted diagnostic metadata for Host logs: never emits error.message, stack, or arbitrary strings. */
export function redactedErrorMetadata(error: unknown): { errorCode?: string; errorName: string } {
  const rawCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  const errorCode = rawCode && SAFE_ERROR_CODES.has(rawCode) ? rawCode : undefined;
  const errorName = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : 'unknown';
  return { ...(errorCode ? { errorCode } : {}), errorName };
}
