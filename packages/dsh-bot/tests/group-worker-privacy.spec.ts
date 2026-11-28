import { expect, it, vi } from 'vitest';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { GroupState } from '../src/host/groups/state.js';
import type { GroupTurnRunner } from '../src/host/groups/turn-runner.js';
import { installWorkerTools, workerReservations, type WorkerBinding } from '../src/host/groups/worker-tool.js';
import { registerWorkerCapability } from '../src/host/groups/worker-capabilities.js';
import { alpha, beta, withIntegrations } from './integration-support.js';

it('isolates group members, guests and resumed sessions in the native tool runtime', () => withIntegrations(async f => {
  const root = SessionId('group-root-privacy-fixture');
  const group = { id: 'group', createdAt: 1, rootSessionId: root };
  const workers = new Map<string, WorkerBinding>();
  const turns = new Map<string, object>();
  const deliveries = new Map<string, object>();
  const state = { ctx: f.ctx, registry: f.registry, workers, stopped: false, cancelledTurns: new Set(),
    bot: () => f.registry.get(alpha.botId),
    table: (name: string) => name === 'groups' ? new Map([[group.id, group]]) : name === 'turns' ? turns : deliveries,
  } as unknown as GroupState;
  const stop = installWorkerTools(state, {} as GroupTurnRunner);
  const called = vi.fn(async () => 'fixture');
  // Inert sentinels make the access decision observable without opening any files or starting a shell.
  const capability = (name: string) => defineTool({ name, description: 'inert fixture', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: called });
  const generalTools = ['bash', 'read', 'grep', 'fixture_session_reader', 'fixture_connector'];
  for (const name of generalTools) f.ctx.tools.register(capability(name));
  try {
    for (const mode of ['member', 'guest', 'memory', 'resumed', 'failed-start'] as const) {
      const child = f.createAgent(mode);
      child.value.session = Session.create(SessionId(mode), undefined, { version: 4, id: SessionId(mode), createdAt: 1,
        isSeeded: false, parentSession: root, agentPreset: 'bot-alpha' });
      await child.scope.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { child.value.ctx = ctx; } }).await();
      const agent = child.agent;
      const binding = { childId: agent.id, rootId: root, turnId: mode, deliveryId: mode,
        presetId: 'bot-alpha', ...(mode === 'guest' ? { guestQuestion: true as const } : {}), audience: [alpha, beta], isActive: () => true };
      if (mode !== 'resumed') {
        workers.set(agent.id, binding); workerReservations.set(agent.id, binding);
        if (mode !== 'failed-start') turns.set(mode, { group: { groupId: group.id, groupCreatedAt: 1 },
          ...(mode === 'guest' ? { guestQuestion: { bot: alpha, name: 'Alpha' } } : {}), memoryStatusOnly: mode === 'memory' });
        deliveries.set(mode, { bot: alpha });
      }
      try {
        // Same-scope tools survive tools.restrict(). Only the exact registered owner's definition may execute.
        agent.ctx.tools.register(capability('fixture_local_fs'));
        agent.ctx.tools.register(capability('bot_memory_search'));
        for (const name of ['bot_memory_list', 'bot_memory_save', 'bot_follow_up'])
          registerWorkerCapability(agent, capability(name));
        await f.ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: mode === 'resumed' ? 'resume' : 'startup' });
        const execute = (name: string) => f.ctx.tools.execute({ agent, name, arguments: {},
          callId: ToolCallId(crypto.randomUUID()), signal: new AbortController().signal });
        called.mockClear();
        for (const name of generalTools) {
          if (!['member', 'guest'].includes(mode) || !['bash', 'read', 'grep'].includes(name))
            expect(agent.ctx.tools.get(name, agent), name).toBeUndefined();
          expect((await execute(name)).isError, name).toBe(true);
        }
        for (const name of ['fixture_local_fs', 'bot_memory_search'])
          expect((await execute(name)).isError, name).toBe(true);
        expect(called).not.toHaveBeenCalled();
        const live = mode !== 'resumed' && mode !== 'failed-start';
        expect((await execute('bot_memory_list')).isError).toBe(!live);
        expect((await execute('bot_memory_save')).isError).toBe(mode !== 'member' && mode !== 'memory');
        expect((await execute('bot_follow_up')).isError).toBe(mode !== 'member');
        expect(Boolean(agent.ctx.tools.get('group_message', agent))).toBe(mode === 'member');
        workers.delete(agent.id); workerReservations.delete(agent.id);
        expect((await execute('bot_memory_list')).isError).toBe(true);
      } finally {
        workers.delete(agent.id); workerReservations.delete(agent.id); child.scope.dispose();
      }
    }
    const main = f.createAgent('human-main');
    try { expect(f.ctx.tools.get('bash', main.agent)).toBeDefined(); } finally { main.scope.dispose(); }
  } finally { stop(); }
}));
