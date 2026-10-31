import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { defineTool, type ToolExecution, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { botIdSchema } from '../../shared/ids.js';
import {
  AVATAR_COLOR_TOKENS,
  AVATAR_VARIANTS,
  type BotPatch,
  type BotRecord,
  botCreateSchema,
  botPatchSchema,
  botRemoveOptionsSchema,
} from '../../shared/schema.js';
import { DshBotError, parseInput } from '../errors.js';
import type { DshBotRegistry } from '../registry.js';

export const BOT_MANAGE_TOOL_NAME = 'bot_manage';
type Registry = Pick<DshBotRegistry, 'list' | 'get' | 'create' | 'update' | 'remove' | 'config'> & {
  memoryFor(botId: string): Pick<ReturnType<DshBotRegistry['memoryFor']>, 'count'>;
};
const activeTools = new WeakMap<Agent, () => void>();

type Dictionary = typeof en.tools;
function translate(
  dictionary: Dictionary,
  key: keyof Dictionary,
  values: Record<string, string | number> = {},
): string {
  return dictionary[key].replace(/\{(\w+)\}/gu, (_match, name: string) => {
    if (!(name in values)) throw new Error(`Missing Bot management locale variable: ${name}`);
    return String(values[name]);
  });
}

// Model projection only: never return large inline avatar payloads. Prefix and
// suffix share one preview budget, measured in Unicode code points.
function modelView(bot: BotRecord, previewChars?: number) {
  const { onboarding: _onboarding, ...fields } = bot;
  const persona: BotRecord['persona'] & { truncated?: boolean } = { ...bot.persona };
  if (previewChars !== undefined) {
    let remaining = previewChars;
    for (const field of ['prefix', 'suffix'] as const) {
      const text = persona[field];
      if (text === undefined) continue;
      const points = [...text];
      const excerpt = points.slice(0, remaining);
      persona[field] = excerpt.join('');
      remaining -= excerpt.length;
      if (points.length > excerpt.length) persona.truncated = true;
    }
  }
  return { ...fields, persona, ...(bot.avatar?.startsWith('data:') ? { avatar: '[data-url avatar]' } : {}) };
}

const botViewSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    avatar: { type: 'string', description: 'Emoji or [data-url avatar]; inline image payloads are omitted.' },
    avatarColor: { type: 'string', enum: AVATAR_COLOR_TOKENS },
    avatarVariant: { type: 'string', enum: [...AVATAR_VARIANTS, 'auto'] },
    description: { type: 'string', required: true },
    persona: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        prefix: { type: 'string', required: true },
        suffix: { type: 'string' },
        complete: { type: 'boolean' },
        truncated: {
          type: 'boolean',
          description: 'True when list shortened prefix/suffix; use get for the full persona.',
        },
      },
    },
    template: { type: 'string', enum: ['standard', 'minimal'], required: true },
    model: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', required: true },
        model: { type: 'string', required: true },
        reasoningEffort: { type: 'string' },
      },
    },
    tools: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        deny: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    skills: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        extraDirs: { type: 'array', items: { type: 'string' }, required: true },
      },
    },
    memory: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        enabled: { type: 'boolean', required: true },
        injectLimit: { type: 'integer', required: true },
      },
    },
    defaultCwd: { type: 'string' },
    order: { type: 'number' },
    mcpServers: { type: 'array', items: { type: 'json' }, required: true },
    channels: { type: 'array', items: { type: 'json' }, required: true },
    createdAt: { type: 'integer', required: true },
    updatedAt: { type: 'integer', required: true },
    schemaVersion: { type: 'integer', const: 1, required: true },
  },
} as const satisfies ValueSchemaSpec;

// Keep the same business schemas as the Remote/UI path. The author schema is
// a model-facing guide; this discriminated union also closes its open root.
const argumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({ action: z.literal('get'), id: botIdSchema }),
  z.strictObject({ action: z.literal('create'), input: botCreateSchema }),
  z.strictObject({ action: z.literal('update'), id: botIdSchema, input: botPatchSchema.refine(
    input => (input.expectedCreatedAt === undefined) === (input.expectedUpdatedAt === undefined),
    'Pass both expectedCreatedAt and expectedUpdatedAt from get, or omit both for legacy review',
  ) }),
  // Private-home deletion is an explicit UI choice, outside the existing
  // management tool's approved memory-only deletion scope.
  z.strictObject({
    action: z.literal('delete'),
    id: botIdSchema,
    input: botRemoveOptionsSchema.omit({ deleteHome: true }).optional(),
  }),
]);

function toolError(error: unknown): never {
  // ToolRuntime only preserves structured error identity from HarnessError.
  // Retain the registry's vocabulary without carrying causes/raw inputs along.
  if (error instanceof DshBotError) throw new HarnessError(error.message, error.code);
  throw error;
}

function readArguments(exec: ToolExecution, owner: Agent) {
  try {
    if (exec.agent !== owner) throw new DshBotError('bot/invalid', 'Bot management tool belongs to another agent');
    exec.signal.throwIfAborted();
    return parseInput(argumentsSchema, exec.arguments);
  } catch (error) {
    return toolError(error);
  }
}

/** One agent owns both the policy gate and the tool; the caller retains the disposer. */
export function registerBotManageTool(
  owner: Agent,
  registry: Registry,
  onDisposed?: () => void,
  currentBotId?: string,
): () => void {
  // Blank preset selection can transfer this package's tool between retained
  // Bot generations and standard. Never replace another plugin's definition.
  activeTools.get(owner)?.();
  let dispose: (() => void) | undefined;
  dispose = owner.ctx.effect(() => {
    const releases: Array<() => void> = [];
    let active = true;
    // The native execution token binds the exact reviewed patch to one call.
    // Legacy callers acquire their snapshot here, never at post-approval execution.
    const reviewedUpdates = new Map<ToolExecution['token'], BotPatch>();
    const cleanup = () => {
      active = false;
      reviewedUpdates.clear();
      if (activeTools.get(owner) === dispose) activeTools.delete(owner);
      onDisposed?.();
      const errors: unknown[] = [];
      for (const release of releases.splice(0).reverse()) {
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Bot management tool cleanup failed');
    };
    try {
      releases.push(
        owner.ctx.on(
          'tools/pre-execute',
          async (exec, next) => {
            if (exec.name !== BOT_MANAGE_TOOL_NAME) return next();
            const args = readArguments(exec, owner);
            const decision = await next();
            if (
              args.action === 'list' ||
              args.action === 'get' ||
              decision.kind === 'deny' ||
              decision.kind === 'cancel'
            )
              return decision;
            try {
              let reviewed: BotPatch | undefined;
              if (args.action === 'update') {
                const snapshot = await registry.get(args.id);
                if (!active) throw new DshBotError('bot/unavailable', 'Bot management is unloading');
                if ((args.input.expectedCreatedAt !== undefined && args.input.expectedCreatedAt !== snapshot.createdAt)
                  || (args.input.expectedUpdatedAt !== undefined && args.input.expectedUpdatedAt !== snapshot.updatedAt)) {
                  throw new DshBotError('bot/conflict', 'Bot changed; get its current details and review the update again');
                }
                reviewed = {
                  ...args.input,
                  // A role-only edit preserves the existing suffix and complete mode.
                  ...(args.input.persona ? { persona: { ...snapshot.persona, ...args.input.persona } } : {}),
                  expectedCreatedAt: snapshot.createdAt,
                  expectedUpdatedAt: snapshot.updatedAt,
                };
                reviewedUpdates.set(exec.token, reviewed);
              }
              const deleteMemories = args.action === 'delete' && (args.input?.deleteMemories ?? true);
              const count = deleteMemories ? await registry.memoryFor(args.id).count(exec.signal) : 0;
              exec.signal.throwIfAborted();
              if (!active) throw new DshBotError('bot/unavailable', 'Bot management is unloading');
              const describe = (dictionary: Dictionary, locale: 'en' | 'zh') => {
                const self = args.action !== 'create' && args.id === currentBotId;
                let operation = translate(dictionary, `bot_manage.approval.${args.action}`, {
                  id: JSON.stringify(args.action === 'create' ? args.input.id : args.id),
                  name: args.action === 'create' ? JSON.stringify(args.input.name) : '',
                  fields: args.action === 'update'
                    ? JSON.stringify(Object.keys(args.input).filter(key => !key.startsWith('expected')).sort()) : '',
                  selfWarning: self
                    ? translate(
                        dictionary,
                        args.action === 'delete' ? 'bot_manage.approval.selfDelete' : 'bot_manage.approval.selfUpdate',
                      )
                    : '',
                  memoryWarning:
                    args.action === 'delete'
                      ? translate(
                          dictionary,
                          deleteMemories ? 'bot_manage.approval.deleteMemories' : 'bot_manage.approval.keepMemories',
                          { count },
                        )
                      : '',
                });
                if (reviewed?.persona) {
                  operation += translate(dictionary, 'bot_manage.approval.personaPreview', {
                    prefix: JSON.stringify(reviewed.persona.prefix),
                    persona: JSON.stringify(reviewed.persona),
                    createdAt: reviewed.expectedCreatedAt ?? '',
                    updatedAt: reviewed.expectedUpdatedAt ?? '',
                  });
                }
                // Enrich an existing ask too, so another policy cannot accidentally
                // omit the target, deletion count or self-modification warning.
                const upstream =
                  decision.kind === 'ask' ? (decision.displayReason?.[locale] ?? decision.reason) : undefined;
                return upstream
                  ? translate(dictionary, 'bot_manage.approval.combined', { operation, upstream })
                  : operation;
              };
              const displayReason = { en: describe(en.tools, 'en'), zh: describe(zh.tools, 'zh') };
              return { kind: 'ask', reason: displayReason.en, displayReason };
            } catch (error) {
              return toolError(error);
            }
          },
          { prepend: true },
        ),
      );
      releases.push(owner.ctx.on('tools/result', exec => { reviewedUpdates.delete(exec.token); }));
      releases.push(
        owner.ctx.tools.register(
          defineTool({
            name: BOT_MANAGE_TOOL_NAME,
            description:
              'List, inspect, create, update or delete Bots using the shared Bot registry. Writes require user approval. To set an explicitly requested lasting role, first get the current Bot, then update persona.prefix with both expectedCreatedAt and expectedUpdatedAt copied from that get. Omitted suffix/complete are preserved. On bot/conflict get again and submit the new draft for fresh approval; only report saved after tool success. A name guess or one-time task is not a lasting role. Legacy updates without versions are protected only from approval preparation onward, not from any earlier unknown read. Use memory tools for preferences or facts. Committed persona text and complete mode apply when the next prompt assembly starts in live sessions, without replacing their history; a step already assembling or running keeps its snapshot. Other configuration updates affect new or cold-restored sessions. Deletion removes the preset and, by default, its memories; old sessions cannot adopt a recreated Bot generation.',
            parameters: {
              action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], required: true },
              id: {
                type: 'string',
                description:
                  'Required for get/update/delete. For create put id inside input. Lowercase letters, digits and hyphens; 2–32 characters.',
              },
              input: {
                type: 'object',
                additionalProperties: true,
                description:
                  'create: Bot fields including required id and name. update: a partial Bot patch; include both snapshot timestamps from get. Omitted persona suffix/complete are preserved; other top-level fields are replaced. id is immutable. delete: only optional deleteMemories (default true). Omit for list/get. Optional avatar/avatarColor/avatarVariant/model/defaultCwd/order can be cleared with null on update.',
                properties: {
                  expectedCreatedAt: { type: 'integer', description: 'For update: copy createdAt from the preceding get, together with expectedUpdatedAt.' },
                  expectedUpdatedAt: { type: 'integer', description: 'For update: copy updatedAt from the same get. A stale snapshot fails without saving.' },
                  id: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  avatar: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  avatarColor: { oneOf: [{ type: 'string', enum: AVATAR_COLOR_TOKENS }, { type: 'null' }] },
                  avatarVariant: { oneOf: [{ type: 'string', enum: [...AVATAR_VARIANTS, 'auto'] }, { type: 'null' }] },
                  template: { type: 'string', enum: ['standard', 'minimal'] },
                  persona: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      prefix: { type: 'string', required: true },
                      suffix: { type: 'string' },
                      complete: { type: 'boolean' },
                    },
                  },
                  model: {
                    oneOf: [
                      {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          provider: { type: 'string', required: true },
                          model: { type: 'string', required: true },
                          reasoningEffort: { type: 'string' },
                        },
                      },
                      { type: 'null' },
                    ],
                  },
                  tools: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      deny: { type: 'array', items: { type: 'string' }, required: true },
                    },
                  },
                  skills: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      extraDirs: { type: 'array', items: { type: 'string' }, required: true },
                    },
                  },
                  memory: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      enabled: { type: 'boolean', required: true },
                      injectLimit: { type: 'integer', required: true },
                    },
                  },
                  defaultCwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  order: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  mcpServers: {
                    type: 'array',
                    description: 'Stored MCP reference configuration; P1 does not activate connectors.',
                  },
                  channels: {
                    type: 'array',
                    description: 'Stored channel bindings; P1 does not activate notifications.',
                  },
                  deleteMemories: { type: 'boolean', description: 'Only for delete; defaults to true.' },
                },
              },
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'], required: true },
                  bots: { type: 'array', items: botViewSchema, required: true },
                },
              },
              render: (_args, value) => [
                {
                  type: 'text',
                  text: `${value.action === 'list' ? `Found ${value.bots.length} Bot(s).` : `Bot ${value.action} completed.`}\n${JSON.stringify(value)}`,
                },
              ],
            },
            async execute(_args, exec) {
              const args = readArguments(exec, owner);
              try {
                if (!active) throw new DshBotError('bot/unavailable', 'Bot management is unloading');
                switch (args.action) {
                  case 'list':
                    return {
                      action: args.action,
                      bots: (await registry.list()).map((bot) =>
                        modelView(bot, registry.config.botManagePersonaPreviewChars),
                      ),
                    };
                  case 'get':
                    return { action: args.action, bots: [modelView(await registry.get(args.id))] };
                  case 'create':
                    return { action: args.action, bots: [modelView(await registry.create(args.input))] };
                  case 'update': {
                    const reviewed = reviewedUpdates.get(exec.token);
                    reviewedUpdates.delete(exec.token);
                    if (!reviewed) throw new DshBotError('bot/conflict', 'No reviewed update snapshot; request fresh approval');
                    exec.signal.throwIfAborted();
                    return { action: args.action, bots: [modelView(await registry.update(args.id, reviewed))] };
                  }
                  case 'delete':
                    await registry.remove(args.id, args.input);
                    return { action: args.action, bots: [] };
                }
              } catch (error) {
                return toolError(error);
              }
            },
          }),
        ),
      );
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  }, 'dsh-bot: bot_manage');
  activeTools.set(owner, dispose);
  return dispose;
}

function registerMatchingAgents(ctx: Context, matches: (agent: Agent) => boolean, currentBotId?: string): void {
  ctx.effect(() => {
    const agents = new Map<Agent, () => void>();
    const refresh = (agent: Agent) => {
      if (!matches(agent)) {
        agents.get(agent)?.();
        return;
      }
      if (!agents.has(agent))
        agents.set(
          agent,
          registerBotManageTool(
            agent,
            ctx.dshBots,
            () => {
              agents.delete(agent);
            },
            currentBotId,
          ),
        );
    };
    const offCreated = ctx.on('agent/created', ({ agent }) => {
      refresh(agent);
    });
    const offSelected = ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId);
      if (agent) refresh(agent);
    });
    return () => {
      offCreated();
      offSelected();
      const errors: unknown[] = [];
      for (const dispose of [...agents.values()]) {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      agents.clear();
      if (errors.length) throw new AggregateError(errors, 'Bot management lifecycle cleanup failed');
    };
  }, 'dsh-bot: preset bot_manage');
}

/** Optional Host contribution: no global tool and no mutation of the standard preset. */
export function registerStandardBotManage(ctx: Context): void {
  // The creation header is immutable even when a blank session changes preset.
  registerMatchingAgents(ctx, (agent) => ctx.agentPresets.composedPreset(agent.ctx) === 'standard');
}

/** Follow the exact Bot generation, including blank-session preset changes. */
export function registerBotPresetManage(ctx: Context, botId: string): void {
  const presetScope = scopeOf(ctx);
  if (!presetScope) throw new Error('Bot management requires a preset scope');
  registerMatchingAgents(ctx, (agent) => scopeChainOf(scopeOf(agent.ctx)).includes(presetScope), botId);
}
