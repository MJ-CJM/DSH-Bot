import type { Context } from '@deepseek-ai/cordis';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';

const saveReceipt = z.strictObject({ id: z.string().min(1), deduplicated: z.boolean() });
type MemoryWriteStatus = 'saved' | 'failed' | 'unverified';

/** The durable tool result is authority; assistant text never counts as a save. */
export function readMemoryWriteStatus(events: readonly SessionEvent[], inputId: string): MemoryWriteStatus {
  const calls = new Set<string>();
  let turn: number | undefined;
  let matched = false;
  let failed = false;
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (matched) break;
      turn = event.data.turn;
    }
    if (event.type === 'turn/end' && event.data.turn === turn) {
      if (matched) break;
      turn = undefined;
    }
    if (event.type === 'user/message' && event.data.id === inputId) matched = true;
    if (!matched || turn === undefined) continue;
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === 'bot_memory_save') {
      calls.add(event.data.callId);
    }
    if (event.type !== 'tool/result' || event.data.turn !== turn || !calls.delete(event.data.message.toolCallId)) continue;
    const result = event.data.message;
    if (result.isError) {
      failed = true;
      continue;
    }
    if (result.content.length !== 1 || result.content[0]?.type !== 'text') continue;
    try {
      if (saveReceipt.safeParse(JSON.parse(result.content[0].text)).success) return 'saved';
    } catch { /* A malformed tool result is unverified. */ }
  }
  return failed ? 'failed' : 'unverified';
}

export async function groupMemoryWriteStatus(ctx: Context, childId: string, inputId: string,
  signal: AbortSignal): Promise<MemoryWriteStatus> {
  const id = SessionId(childId);
  const live = ctx.get('sessions')?.get?.(id) ?? ctx.agents.get(id)?.session;
  if (live) return readMemoryWriteStatus(live.snapshotEvents(), inputId);
  try {
    const handle = await ctx.get('sessionPersistence')?.open(id, 'read', { signal });
    if (!handle) return 'unverified';
    try { return readMemoryWriteStatus((await handle.read(undefined, undefined, { signal })).events, inputId); }
    finally { await handle.close(); }
  } catch {
    return 'unverified';
  }
}
