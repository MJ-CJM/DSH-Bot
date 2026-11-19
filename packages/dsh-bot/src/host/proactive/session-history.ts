import type { SessionEvent } from '@deepseek-ai/dsh-session';

/** Public controller contracts: rc.2 inspect and rc.3 passive events. Neither activates an Agent. */
interface PublicHistory {
  inspect?(id: string): Promise<{ events: SessionEvent[] }>;
  events?(request: { address: { kind: 'session'; sessionId: string }; maxMessages: number }, signal: AbortSignal): Promise<{
    records: { type: 'event'; event: SessionEvent }[]; hasMore: boolean;
  }>;
}
export function assertEvaluationHistory(controller: unknown) {
  const history = controller as PublicHistory | undefined;
  if (typeof history?.inspect !== 'function' && typeof history?.events !== 'function')
    throw new Error('native-history-unavailable');
}
export async function evaluationEvents(controller: unknown, id: string, signal: AbortSignal): Promise<SessionEvent[]> {
  assertEvaluationHistory(controller); signal.throwIfAborted();
  const history = controller as PublicHistory;
  if (typeof history.inspect === 'function') return (await history.inspect(id)).events;
  const read = history.events;
  if (!read) throw new Error('native-history-unavailable');
  const page = await read.call(history, { address: { kind: 'session', sessionId: id }, maxMessages: 1000 }, signal);
  if (page.hasMore || page.records.some(row => row.type !== 'event' || !row.event)) throw new Error('native-history-incomplete');
  return page.records.map(row => row.event);
}
