import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { BOT_ID_PATTERN } from '../shared/ids.js';
import type {} from './registry.js';
import { DshBotError } from './errors.js';

export const name = 'dsh-bot-context';
export const inject = ['dshBots', 'tools', 'llm'];

export interface Config {
  botId: string;
}

export const Config: Schema<Config> = Schema.object({
  botId: Schema.string().pattern(BOT_ID_PATTERN).required(),
});

/** Identity belongs to one live agent, without mutating DSH's Agent object. */
export interface BotBinding {
  readonly botId: string;
}

const bindings = new WeakMap<Agent, BotBinding>();

/** Public Host-side identity lookup for later Bot memory/tool contributions. */
export function getBotBinding(agent: Agent): BotBinding | undefined {
  return bindings.get(agent);
}

/** Mounted inside a preset; its closure is retained with that preset generation. */
export function apply(ctx: Context, config: Config): void {
  const { botId } = Config(config);
  // Never enqueue a Remote-style get here: preset activation is itself awaited
  // by registry writes. Copy now so retained generations keep their old policy.
  const bot = ctx.dshBots.presetBot(botId);
  const deny = [...bot.tools.deny];
  const model = bot.model ? {
    provider: bot.model.provider,
    model: bot.model.model,
    ...(bot.model.reasoningEffort === undefined
      ? {} : { reasoningEffort: ReasoningEffortId(bot.model.reasoningEffort) }),
  } : undefined;
  const binding = Object.freeze({ botId });

  const shouldUseBotModel = (agent: Agent) => {
    const pending = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.pending;
    return agent.session.requestHeader() === undefined && pending == null;
  };
  const validateModel = async () => {
    if (!model) return;
    try {
      if (!ctx.llm.listProviders().some((provider) => provider.id === model.provider)) {
        throw new Error(`Provider '${model.provider}' is unavailable`);
      }
      if (!(await ctx.llm.listModels(model.provider)).some((entry) => entry.id === model.model)) {
        throw new Error(`Model '${model.model}' is not advertised by provider '${model.provider}'`);
      }
    } catch (cause) {
      throw new DshBotError('bot/preset-failed',
        `Bot '${botId}' model '${model.provider}/${model.model}' is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause });
    }
  };

  // A retained preset generation owns this map. Retiring a generation does not
  // unload it while Agents still reference it; explicit plugin unload does.
  ctx.effect(() => {
    const agents = new Map<Agent, () => void>();
    let stopped = false;
    const offCreated = ctx.on('agent/created', async ({ agent }) => {
      if (bindings.has(agent)) throw new Error(`Agent ${agent.id} already has a Bot binding`);
      if (model && shouldUseBotModel(agent)) await validateModel();
      if (stopped) throw new DshBotError('bot/unavailable', `Bot '${botId}' context is unloading`);
      const dispose = agent.ctx.effect(() => {
        const releases: Array<() => void> = [];
        const cleanup = () => {
          agents.delete(agent);
          bindings.delete(agent);
          const errors: unknown[] = [];
          for (const release of releases.splice(0).reverse()) {
            try { release(); } catch (error) { errors.push(error); }
          }
          if (errors.length) throw new AggregateError(errors, 'Bot agent cleanup failed');
        };
        try {
          // Do not silently ignore unknown, same-layer or reserved tool names.
          if (deny.length) releases.push(agent.ctx.tools.restrict({ deny }));
          bindings.set(agent, binding);
          if (model) {
            // Only alter route variables, never text/tools or other assembly
            // fields. Session history and explicit selection remain authoritative.
            let useBotModel = false;
            releases.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
              useBotModel = false;
              const selected = shouldUseBotModel(agent);
              if (selected) await validateModel();
              const assembled = await next();
              useBotModel = selected && !stopped;
              if (!useBotModel) return assembled;
              return { ...assembled, variables: { ...assembled.variables, provider: model.provider, model: model.model } };
            }, { prepend: true }));
            releases.push(agent.ctx.on('agent/request', async (_payload, next) => {
              const resolved = await next();
              if (!useBotModel) return resolved;
              await validateModel();
              if (stopped) return resolved;
              const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
              return { ...rest, ...model };
            }, { prepend: true }));
          }
          return cleanup;
        } catch (error) {
          cleanup();
          throw error;
        }
      }, `dsh-bot: agent ${botId}`);
      agents.set(agent, dispose);
    });
    return () => {
      stopped = true;
      offCreated();
      const errors: unknown[] = [];
      for (const dispose of [...agents.values()]) {
        try { dispose(); } catch (error) { errors.push(error); }
      }
      agents.clear();
      if (errors.length) throw new AggregateError(errors, 'Bot preset cleanup failed');
    };
  }, `dsh-bot: preset ${botId}`);
}
