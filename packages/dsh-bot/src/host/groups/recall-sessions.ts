import { Session, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { GROUP_ROOT_PRESET } from '../../shared/groups.js';

export type UserEvent = Extract<SessionEvent, { type: 'user/message' }>;
type ReadBudget = { maxSessionBytes: number; maxSessionEvents: number };

/** Some public exact reads have no abort argument. Stop waiting and do not start another read. */
export async function untilAbort<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop = () => {};
  const abort = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
  });
  try { return await Promise.race([run(), abort]); }
  finally { signal.removeEventListener('abort', stop); }
}

/** An unpublished fallback for minimal hosts. Opening a read handle does not restore an Agent. */
async function inspect<T>(ctx: Context, id: SessionId, signal: AbortSignal, accepts: (header: SessionHeader) => boolean,
  read: (session: Session) => T): Promise<T> {
  const live = ctx.get('sessions')?.get(id);
  if (live) {
    if (!accepts(live.header)) throw new Error('Group history identity unavailable');
    return read(live);
  }
  const persistence = ctx.get('sessionPersistence');
  if (!persistence) throw new Error('Group history unavailable');
  const handle = await persistence.open(id, 'read', { signal });
  try {
    if (!accepts(handle.header)) throw new Error('Group history identity unavailable');
    const snapshot = await handle.read(undefined, undefined, { signal });
    signal.throwIfAborted();
    const attached = ctx.get('sessions')?.get(id);
    return read(attached ?? Session.create(handle.id, snapshot.events, handle.header, handle.inheritedEventCount));
  } finally { await handle.close(); }
}

async function preflight(ctx: Context, id: SessionId, budget: ReadBudget, signal: AbortSignal, accepts: (header: SessionHeader) => boolean) {
  const live = ctx.get('sessions')?.get(id);
  const stored = live ? undefined : await ctx.get('sessionPersistence')?.stat(id, { signal });
  const header = live?.header ?? stored?.header;
  if (header && !accepts(header)) throw new Error('Group history identity unavailable');
  if ((live?.seq ?? stored?.eventCount ?? 0) > budget.maxSessionEvents || (stored?.sizeBytes ?? 0) > budget.maxSessionBytes)
    throw new Error('Group history exceeds read budget');
}

const rootHeader = (header: SessionHeader, id: SessionId) => header.id === id && header.agentPreset === GROUP_ROOT_PRESET &&
  !header.parentSession && !header.isSeeded;

export async function readRootMessages(ctx: Context, sessionId: string, wanted: ReadonlySet<string>, budget: ReadBudget, signal: AbortSignal) {
  const id = SessionId(sessionId);
  const query = ctx.get('sessionQuery');
  const accepts = (header: SessionHeader) => rootHeader(header, id);
  const exact = (header: SessionHeader, events: Iterable<SessionEvent>): Map<string, UserEvent> => {
    if (!accepts(header)) throw new Error('Group root identity unavailable');
    const result = new Map<string, UserEvent>();
    const duplicates = new Set<string>();
    for (const event of events) {
      if (event.type !== 'user/message' || !wanted.has(event.data.id) || duplicates.has(event.data.id)) continue;
      if (result.delete(event.data.id)) duplicates.add(event.data.id);
      else result.set(event.data.id, event);
    }
    return result;
  };
  return untilAbort(async () => {
    await preflight(ctx, id, budget, signal, accepts);
    signal.throwIfAborted();
    if (query) {
      const surface = await query.readSurface(id);
      if ((surface.capturedThroughSeq ?? -1) + 1 > budget.maxSessionEvents) throw new Error('Group history exceeds read budget');
      return exact(surface.session, surface.events);
    }
    return inspect(ctx, id, signal, accepts, session => {
      if (session.seq > budget.maxSessionEvents) throw new Error('Group history exceeds read budget');
      return exact(session.header, session.surface.nodes.flatMap(seq => session.eventAt(seq) ?? []));
    });
  }, signal);
}

/** Close the window between the detached async surface observation and the final live disclosure. */
export function checkLiveRoot(ctx: Context, sessionId: string, check: (read: (seq: number) => UserEvent | undefined) => boolean) {
  const id = SessionId(sessionId);
  const live = ctx.get('sessions')?.get(id);
  if (!live) return true;
  if (!rootHeader(live.header, id)) return false;
  return check(value => {
    const seq = SessionSeq(value);
    if (!live.surface.nodes.includes(seq)) return;
    const event = live.eventAt(seq);
    if (event?.type === 'user/message') return event;
  });
}

/** The child supplies only proof that the recorded input reached a real step. */
export async function readChildInput(ctx: Context, binding: {
  childSessionId: string; rootSessionId: string; presetId: string; childMessageId?: string;
}, matches: (event: UserEvent) => boolean, budget: ReadBudget, signal: AbortSignal): Promise<UserEvent | undefined> {
  const id = SessionId(binding.childSessionId);
  const query = ctx.get('sessionQuery');
  const accepts = (header: SessionHeader) => header.id === id && header.parentSession === binding.rootSessionId && header.agentPreset === binding.presetId &&
    header.origin === 'subagent' && !header.isSeeded;
  const entered = (events: readonly SessionEvent[]) => {
    if (events.length > budget.maxSessionEvents) return;
    let inStep = false;
    for (const event of events) {
      if (event.type === 'step/start') inStep = true;
      else if (event.type === 'step/end' || event.type === 'turn/end' || event.type === 'turn/start') inStep = false;
      else if (inStep && event.type === 'user/message') {
        // Older one-shot deliveries did not store the native message ID. Only
        // their first claimed native user input can establish the binding.
        const exact = binding.childMessageId === undefined ? event.data.source.kind === 'user' : binding.childMessageId === event.data.id;
        if (exact) return matches(event) ? event : undefined;
      }
    }
  };
  return untilAbort(async () => {
    await preflight(ctx, id, budget, signal, accepts);
    signal.throwIfAborted();
    if (query) {
      const observation = await query.observeSession(id, { signal, projectionMode: 'none' });
      try { return accepts(observation.header) ? entered(observation.events) : undefined; }
      finally { observation[Symbol.dispose](); }
    }
    return inspect(ctx, id, signal, accepts, session => accepts(session.header) ? entered(session.snapshotEvents()) : undefined);
  }, signal);
}
