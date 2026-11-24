import { expect, it } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope } from '@deepseek-ai/dsh-scope';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { createMemoryTools } from '../../src/host/memory/tools.js';
import { v2Fixture } from './v2-fixtures.js';
import { shared } from './shared-fixtures.js';

it('searches only published sources by default on a relay and records only material returned by each read', async () => {
  const f = await v2Fixture();
  try {
    const { id: own } = await f.alpha.save({ content: 'PRIVATE fixture Alpha' });
    await f.beta.save({ content: 'PRIVATE fixture Beta' });
    const published = await shared(f, 'Published fixture topic');
    await f.ctx.plugin(SystemPrompt, {}).await();
    await f.ctx.plugin(Tools, { mode: 'native' }).await();
    let injected = f.ctx;
    await f.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { injected = ctx; } }).await();
    const payload = { ctx: injected, session: { id: 'relay-memory-fixture' } };
    const agent = payload as Agent;
    const scope = createScope(injected, agent);
    payload.ctx = scope.ctx;
    const observed: string[][] = [];
    try {
      for (const tool of createMemoryTools(f.alpha, agent, async rows => { observed.push(rows.map(row => row.id)); }, true))
        agent.ctx.effect(() => agent.ctx.tools.register(tool));
      const execute = (name: string, args: unknown) => agent.ctx.tools.execute({ name, arguments: args, agent,
        callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
      expect(await execute('bot_memory_list', { limit: 1 })).toMatchObject({ isError: false, value: [{ id: published }] });
      expect(await execute('bot_memory_search', { query: 'PRIVATE' })).toMatchObject({ isError: false, value: [] });
      expect(await execute('bot_memory_search', { query: 'PRIVATE', includePrivate: true })).toMatchObject({
        isError: false, value: [{ id: own }],
      });
      expect(observed).toEqual([[published], [], [own]]);
      expect(await f.alpha.list()).toContainEqual(expect.objectContaining({ id: own }));
    } finally { await scope.dispose(); }
  } finally { await f.close(); }
});
