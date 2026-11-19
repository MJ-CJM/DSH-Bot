import { expect, it } from 'vitest';
import { ConcurrentGroups } from '../src/host/groups/concurrent.js';
import { digest, Serial } from '../src/host/common/operations.js';
import type { GroupState } from '../src/host/groups/state.js';
import type { GroupMessages } from '../src/host/groups/messages.js';
import type { GroupRoots } from '../src/host/groups/roots.js';
import type { GroupTurnRunner } from '../src/host/groups/turn-runner.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { WorkerBinding } from '../src/host/groups/worker-tool.js';

it('preserves refused and uncertain worker message receipts on repeated calls', async () => {
  const bot = { botId: 'alpha', botCreatedAt: 1 }, agent = { session: { id: 'child' } } as Agent;
  const binding = { turnId: 'turn', deliveryId: 'worker', isActive: () => true } as WorkerBinding;
  const input = { action: 'send' as const, requestReply: false, text: 'blocked private reply' }, call = 'repeat';
  const id = `group-message:${digest(['worker', call])}`;
  const receipt = { id, state: 'failed', reasonCode: 'export-blocked', requestDigest: digest(input), triggerMessageId: 'never-appended' };
  const deliveries = new Map<string, unknown>([['worker', { id: 'worker', state: 'running', memberId: 'a', bot }], [id, receipt]]);
  const state = { queue: new Serial(), table: (name: string) => name === 'turns' ? new Map([['turn', { id: 'turn', group: {} }]]) : deliveries,
    record: () => ({ id: 'group' }), workers: new Map([['child', binding]]), members: () => [{ id: 'a', enabled: true, bot }],
    roots: new Map([['group', {}]]), bot: async () => ({ name: 'Alpha' }) } as unknown as GroupState;
  const runner = new ConcurrentGroups(state, {} as GroupRoots, { messages: () => [] } as unknown as GroupMessages, {} as GroupTurnRunner);
  for (let i = 0; i < 2; i++) await expect(runner.message(agent, binding, input, call, new AbortController().signal)).rejects.toMatchObject({ reasonCode: 'export-blocked' });
  receipt.state = 'unknown';
  await expect(runner.message(agent, binding, input, call, new AbortController().signal)).resolves.toMatchObject({ status: 'unknown' });
  expect(deliveries.size).toBe(2);
});
