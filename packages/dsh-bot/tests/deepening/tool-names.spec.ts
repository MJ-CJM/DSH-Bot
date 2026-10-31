import { describe, expect, it } from 'vitest';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createMemoryTools, MEMORY_TOOL_NAMES } from '../../src/host/memory/tools.js';
import { retiredMemoryGuidance } from '../../src/host/memory/tool-guidance.js';
import { migrateMemoryDeny } from '../../src/shared/memory-tool-names.js';
import { v2Fixture } from './v2-fixtures.js';

describe('I34 namespaced memory tools coexist with community legacy names', () => {
  it('dispatches both independent plugins; stale legacy calls get guidance after community unload; no aliases', async () => {
    const f = await v2Fixture();
    try {
      await f.ctx.plugin(SystemPrompt, {}).await(); await f.ctx.plugin(Tools, { mode: 'native' }).await();
      let injected = f.ctx;
      await f.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { injected = ctx; } }).await();
      const payload = { ctx: injected, session: { id: 'synthetic-tool-names' } };
      const agent = payload as Agent;
      const scope = createScope(injected, agent); payload.ctx = scope.ctx;
      const definitions = createMemoryTools(f.alpha, agent);
      expect(definitions.map(d => d.name)).toEqual(MEMORY_TOOL_NAMES);
      const owned = definitions.map(d => agent.ctx.tools.register(d));
      const community = agent.ctx.tools.register(defineTool({ name: 'memory_save', description: 'Synthetic community memory plugin',
        parameters: {}, output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'COMMUNITY_ONLY' }] },
        execute: async () => 'COMMUNITY_ONLY' }));
      const guidance = retiredMemoryGuidance(agent);
      const execute = (name: string, args: unknown) => agent.ctx.tools.execute({ name, arguments: args,
        callId: ToolCallId(`call-${name}`), signal: new AbortController().signal, agent });
      expect(await execute('memory_save', {})).toMatchObject({ isError: false, value: 'COMMUNITY_ONLY' });
      expect(await execute('bot_memory_save', { content: 'BOT_ONLY' })).toMatchObject({ isError: false });
      expect((await f.alpha.list()).map(r => r.content)).toEqual(['BOT_ONLY']);
      community();
      const result = await execute('memory_save', {});
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('bot_memory_save');
      expect(agent.ctx.tools.get('memory_save', agent)).toBeUndefined();
      guidance(); for (const release of owned) release(); await scope.dispose();
    } finally { await f.close(); }
  });
  it('persists exact deny migration while leaving qualified MCP/community names untouched, including cold reopen', async () => {
    const f = await v2Fixture();
    try {
      expect(migrateMemoryDeny(['memory_save', 'bot_memory_save', 'mcp__community__memory_save', 'community.memory_save']))
        .toEqual(['bot_memory_save', 'mcp__community__memory_save', 'community.memory_save']);
      // Seed an old saved config through the existing public table, then run the production startup migration.
      const bot = f.bots.get('alpha');
      await f.legacy.table('bots').put('alpha', { ...bot, tools: { deny: ['memory_search', 'mcp__x__memory_save'] } });
      await f.bots.migrateMemoryTools(); await f.bots.migrateMemoryTools();
      await f.reopen(); expect(f.bots.get('alpha').tools.deny).toEqual(['bot_memory_search', 'mcp__x__memory_save']);
    } finally { await f.close(); }
  });
});
