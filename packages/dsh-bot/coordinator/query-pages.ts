import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { maxFrameBytes, maxReadBytes, protocolVersion, readPageBytes, replySchema, type Reply } from '../src/shared/proactive/protocol.js';
import { Rejection } from './rejection.js';

type Page = Extract<Reply, { kind: 'read-page' }>;
type ReadRef = Pick<Page, 'readId' | 'readVersion' | 'offset'>;
interface Snapshot {
  bytes: Buffer;
  version: string;
  sequence: number;
  expiresAt: number;
}
const maxSnapshots = 4;
const maxSnapshotBytes = 2 * maxReadBytes;
const lifetimeMs = 30_000;

/** Collection limits reject a read; never truncate cleanup or poison the core.
 * Other schema errors retain the existing broken-invariant failure path. */
export function validateReadReply(value: unknown): Reply {
  const parsed = replySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.every(issue => issue.code === 'too_big')) throw new Rejection('unsupported');
  throw parsed.error;
}

/** Ephemeral transport snapshots only. No task state and no filesystem copies.
 * A mutation invalidates all snapshots before it runs (including forget/revoke).
 * The authenticated channel and store binding also apply to every continuation.
 */
export class QueryPages {
  readonly #reads = new Map<string, Snapshot>();
  constructor(private readonly now: () => number = Date.now) {}

  clear() { this.#reads.clear(); }

  private expire() {
    for (const [id, read] of this.#reads) if (read.expiresAt <= this.now()) this.#reads.delete(id);
  }

  encode(reply: Reply, sequence: number): Reply {
    const bytes = Buffer.from(JSON.stringify(reply));
    if (bytes.length <= maxFrameBytes) return reply;
    if (bytes.length > maxReadBytes) throw new Rejection('unsupported');
    this.expire();
    let retained = [...this.#reads.values()].reduce((sum, read) => sum + read.bytes.length, 0);
    while (this.#reads.size >= maxSnapshots || retained + bytes.length > maxSnapshotBytes) {
      const oldest = this.#reads.entries().next().value;
      if (!oldest) break;
      retained -= oldest[1].bytes.length;
      this.#reads.delete(oldest[0]);
    }
    const id = randomUUID();
    const value = { bytes, version: createHash('sha256').update(bytes).digest('hex'), sequence, expiresAt: this.now() + lifetimeMs };
    this.#reads.set(id, value);
    return this.part(id, value, 0, reply.correlationId);
  }

  read(input: ReadRef, sequence: number, correlationId: string): Page {
    this.expire();
    const value = this.#reads.get(input.readId);
    if (!value || value.sequence !== sequence || value.version !== input.readVersion) throw new Rejection('stale');
    if (input.offset % readPageBytes !== 0 || input.offset >= value.bytes.length) throw new Rejection('invalid');
    return this.part(input.readId, value, input.offset, correlationId);
  }

  private part(id: string, value: Snapshot, offset: number, correlationId: string): Page {
    const end = Math.min(offset + readPageBytes, value.bytes.length);
    return {
      protocolVersion, correlationId, kind: 'read-page', readId: id,
      readVersion: value.version, readSeq: value.sequence, totalBytes: value.bytes.length,
      offset, data: value.bytes.subarray(offset, end).toString('base64'),
      ...(end < value.bytes.length ? { nextOffset: end } : {}),
    };
  }
}

/** Boot-local continuations are bound to owner, filters, store and commit sequence.
 * There is no retained payload or durable cursor state to forget. */
export class ActivityCursor {
  readonly #key = randomBytes(32);
  constructor(private readonly now: () => number = Date.now) {}
  encode(binding: string, offset: number): string {
    const payload = Buffer.from(JSON.stringify({ binding, offset, until: this.now() + 60_000 })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.#key).update(payload).digest('hex')}`;
  }
  decode(token: string | undefined, binding: string): number {
    if (!token) return 0;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !/^[a-f0-9]{64}$/.test(signature)) throw new Rejection('stale');
    const expected = createHmac('sha256', this.#key).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Rejection('stale');
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (value.binding !== binding || value.until <= this.now() || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
      return value.offset;
    } catch { throw new Rejection('stale'); }
  }
}
