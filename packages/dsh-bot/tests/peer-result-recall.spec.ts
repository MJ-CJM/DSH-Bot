import { expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { markAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { DshBotRegistry } from '../src/host/registry.js';
import { registerResultRecall } from '../src/host/messaging/result-recall.js';

function recallFixture(text: string, visible = [1, 2], recipients = ['beta']) {
  const sessionId = 'owner-main';
  const human = (seq: number, body: string) => ({ seq, type: 'user/message',
    data: { id: String(seq), source: { kind: 'user' }, content: [{ type: 'text', text: body }] } });
  const peerResult = vi.fn(async () => ({ status: 'completed', content: 'DELIVERED_RESULT' }));
  const messaging = { isDisplayMessage: () => false, peerResult, store: { rows: () => recipients.map(peer => ({
    envelope: { id: `request-${peer}`, fromSessionId: sessionId, mode: 'ask', origin: { sessionId, userMessageId: '1' },
      to: { botId: peer }, toDisplay: { name: peer } },
  })) } };
  const on = vi.fn();
  const agent = { id: sessionId, ctx: { on, get: () => messaging }, session: {
    surface: { nodes: visible }, snapshotEvents: () => [human(1, 'ask beta'), human(2, text)],
  } } as unknown as Agent;
  registerResultRecall(agent, {} as DshBotRegistry);
  const hook = on.mock.calls[0]?.[1] as (options: GenerateOptions, next: () => AsyncGenerator<unknown>) => AsyncGenerator<unknown>;
  const model = vi.fn(async function* () { yield { type: 'model' }; });
  const run = async () => {
    const chunks = [];
    for await (const chunk of hook(markAgentLoopRequest({ sessionId } as GenerateOptions), model)) chunks.push(chunk);
    return chunks;
  };
  return { agent, model, peerResult, run };
}

it.each(['他上次查到了什么？', '他查到的结果是什么？', 'What did they find out?'])(
  'retrieves one visible delivered result directly for %s', async text => {
    const f = recallFixture(text);
    expect(await f.run()).toContainEqual({ type: 'text-delta', index: 0, text: 'beta\n\nDELIVERED_RESULT' });
    expect(f.peerResult).toHaveBeenCalledWith(f.agent, 'beta', 'request-beta');
    expect(f.model).not.toHaveBeenCalled();
  });

it('does not guess between two peers or show an undelivered answer', async () => {
  const two = recallFixture('他回复了什么？', [1, 2], ['beta', 'gamma']);
  expect(await two.run()).toContainEqual(expect.objectContaining({ type: 'text-delta', text: expect.stringContaining('多个提问') }));
  expect(two.peerResult).not.toHaveBeenCalled();
  expect(two.model).not.toHaveBeenCalled();
  const pending = recallFixture('他回复了什么？');
  pending.peerResult.mockResolvedValue({ status: 'pending', content: 'UNDELIVERED' });
  expect(JSON.stringify(await pending.run())).not.toContain('UNDELIVERED');
  expect(pending.model).not.toHaveBeenCalled();
});

it('does not reuse hidden requests, hidden questions or a request for a new check', async () => {
  for (const f of [recallFixture('他查到什么了？', [2]), recallFixture('他查到什么了？', [1]),
    recallFixture('请再问一下他现在的新进展')]) {
    expect(await f.run()).toEqual([{ type: 'model' }]);
    expect(f.peerResult).not.toHaveBeenCalled();
  }
});
