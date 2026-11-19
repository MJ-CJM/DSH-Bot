import { expect, test, vi } from 'vitest';
import { assertEvaluationHistory, evaluationEvents } from '../src/host/proactive/session-history.js';
import { ProactiveService } from '../src/host/proactive/service.js';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
const signal = () => new AbortController().signal;
test('reads rc2 inspect and rc3 passive events without resolving or activating an Agent', async () => {
  const events = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }] as SessionEvent[];
  const inspect = vi.fn(async () => ({ events }));
  expect(await evaluationEvents({ inspect }, 'exact-session', signal())).toEqual(events);
  expect(inspect).toHaveBeenCalledWith('exact-session');
  const read = vi.fn(async () => ({ records: events.map(event => ({ type: 'event', event })), hasMore: false }));
  expect(await evaluationEvents({ events: read }, 'exact-session', signal())).toEqual(events);
  expect(read).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'exact-session' }, maxMessages: 1000 }, expect.any(AbortSignal));
  await expect(evaluationEvents({ events: async () => ({ records: [], hasMore: true }) }, 'exact-session', signal())).rejects.toThrow('incomplete');
});
test('missing read capability fails before document admission or any model evaluation attempt', async () => {
  expect(() => assertEvaluationHistory({ resolveAgent() {} })).toThrow('native-history-unavailable');
  const change = vi.fn(), execution = { enqueue: vi.fn() };
  const service = { ctx: { sessionController: {} }, change, execution } as unknown as ProactiveService;
  await expect(ProactiveService.prototype.runMethodEvaluation.call(service, {} as never)).rejects.toThrow('native-history-unavailable');
  expect(change).not.toHaveBeenCalled(); expect(execution.enqueue).not.toHaveBeenCalled();
});
