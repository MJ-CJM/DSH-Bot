import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolRunContext, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { DshBotError } from '../errors.js';
import type { BotMemoryService } from './service.js';

export const MEMORY_TOOL_NAMES: readonly string[] = ['memory_save', 'memory_search', 'memory_list', 'memory_forget'];

const recordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    botId: { type: 'string', required: true },
    kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'note'], required: true },
    content: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    pinned: { type: 'boolean', required: true },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string' },
        at: { type: 'integer', required: true },
        by: { type: 'string', enum: ['model', 'user'], required: true },
      },
    },
  },
} as const satisfies ValueSchemaSpec;

const listOutput = {
  schema: { type: 'array', items: recordSchema } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

/** Definitions bind both the trusted Bot service and the owning Agent, never model arguments. */
export function createMemoryTools(memory: BotMemoryService, owner: Agent) {
  const authorize = (exec: ToolRunContext) => {
    if (exec.agent !== owner) throw new DshBotError('bot/invalid', 'Memory tool belongs to another agent');
    exec.signal.throwIfAborted();
  };
  return [
    defineTool({
      name: 'memory_save',
      description:
        'Save explicit user preferences or durable facts for this Bot. Do not save one-off information, secrets, or API keys.',
      parameters: {
        content: {
          type: 'string',
          required: true,
          description: 'A durable fact or explicit preference; at most 2048 UTF-8 bytes.',
        },
        kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'note'] },
        tags: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            deduplicated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        authorize(exec);
        try {
          return await memory.save(args, { sessionId: owner.session.id, at: Date.now(), by: 'model' }, exec.signal);
        } catch (error) {
          // rc.2 ToolRuntime preserves structured codes only from HarnessError.
          if (error instanceof DshBotError && error.code === 'memory/rejected') {
            throw new HarnessError(error.message, error.code);
          }
          throw error;
        }
      },
    }),
    defineTool({
      name: 'memory_search',
      description: "Search this Bot's saved preferences and durable facts before asking the user again.",
      parameters: {
        query: { type: 'string', required: true },
        limit: { type: 'integer', description: 'Maximum results, from 1 to 200.' },
      },
      output: listOutput,
      async execute(args, exec) {
        authorize(exec);
        return memory.search(args, exec.signal);
      },
    }),
    defineTool({
      name: 'memory_list',
      description: "List this Bot's durable memories, optionally filtered by tag or pinned status.",
      parameters: {
        tag: { type: 'string' },
        pinned: { type: 'boolean' },
        limit: { type: 'integer', description: 'Maximum results, from 1 to 200.' },
      },
      output: listOutput,
      async execute(args, exec) {
        authorize(exec);
        return memory.list(args, exec.signal);
      },
    }),
    defineTool({
      name: 'memory_forget',
      description: 'Delete a memory belonging to this Bot when the user asks to forget it or it is no longer valid.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'null' }, render: () => [{ type: 'text', text: 'Memory deleted.' }] },
      async execute(args, exec) {
        authorize(exec);
        await memory.forget(args, exec.signal);
        return null;
      },
    }),
  ];
}
