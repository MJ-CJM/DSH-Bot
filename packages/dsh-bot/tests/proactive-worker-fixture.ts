import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect } from 'vitest';
import { digest, frame, frames } from '../src/host/proactive/wire.js';
import { readQuery } from '../src/host/proactive/read-query.js';
import { replySchema, type CommandBody, type RequestBody, type Reply } from '../src/shared/proactive/protocol.js';
import type { FollowUpBootstrap } from '../src/shared/proactive/follow-up.js';

/** Real packaged coordinator; no transport/core replacement. */
export async function proactiveWorker(notice = false) {
  const root = await mkdtemp(resolve('../../.dsh-dev/proactive-a-'));
  const channel = randomBytes(32).toString('hex');
  const start = () => spawn(process.execPath, [resolve('lib/proactive-coordinator/main.mjs'), join(root, 'store')], {
    env: { LANG: 'C', DSH_BOT_IPC_KEY: channel }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let child = start();
  let exited = once(child, 'exit');
  let output = frames(child.stdout);
  const replies: Reply[] = [];
  const raw = async (body: RequestBody) => {
    const correlationId = randomUUID();
    child.stdin.write(frame({ protocolVersion: 1, correlationId, channel, ...body }));
    const reply = replySchema.parse((await output.next()).value);
    expect(reply.correlationId).toBe(correlationId);
    replies.push(reply);
    return reply;
  };
  const installationId = randomUUID();
  const hello = await raw({ kind: 'hello', installationId, expectedStoreId: null, budget: 100,
    notice, noticeConfig: { mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000 } });
  if (hello.kind !== 'hello') throw new Error('Worker startup failed');
  const storeId = hello.storeId;
  type ReadBody = RequestBody extends infer T ? T extends { storeId: string } ? Omit<T, 'storeId'> : never : never;
  const read = (body: ReadBody) => readQuery({ ...body, storeId } as RequestBody, raw);
  const change = (commandId: string, body: CommandBody) => raw({ kind: 'command', command: {
    storeId, commandId, actorRef: 'local-host', payloadDigest: digest(body), body,
  } });
  const submit = async (body: CommandBody) => {
    const result = await change(randomUUID(), body);
    expect(result).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    return result;
  };
  return { root, storeId, replies, raw, read, submit, change,
    async restart(options: { bootstrap?: FollowUpBootstrap; prepare?(): void; expectRejection?: boolean } = {}) {
      child.stdin.end(); await exited; await output.return(undefined);
      options.prepare?.();
      child = start(); exited = once(child, 'exit'); output = frames(child.stdout);
      const reply = await raw({ kind: 'hello', installationId, expectedStoreId: storeId, budget: 100, notice,
        noticeConfig: { mergeWindowMs: 0, maxBatchItems: 8, maxPending: 1000 },
        ...(options.bootstrap ? { followUpBootstrap: options.bootstrap } : {}) });
      expect(reply).toMatchObject(options.expectRejection ? { kind: 'rejected' } : { kind: 'hello', storeId });
      return reply;
    },
    async close() { child.stdin.end(); await exited; await output.return(undefined); await rm(root, { recursive: true, force: true }); },
  };
}
