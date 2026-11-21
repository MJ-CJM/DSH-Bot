import { protectOnboarding } from './onboarding/guard.js';
import { protectDelegateContinuation } from './delegate/continuation.js';
import { outlets, protectDataFlow } from './data-flow/tool-guard.js';
import { getGroupWorkerBinding, isSupergroupWorker } from './groups/worker-tool.js';
import { getScopedCollaborationBinding, protectScopedCollaboration } from './supergroup/collaboration.js';
import { BOT_GROUP_RECALL_TOOL_NAME, installLiveGroupRecall, protectGroupRecall } from './groups/recall-tool.js';
import { registerMessageTool } from './messaging/tool.js';
import { registerResultRecall } from './messaging/result-recall.js';
import { registerDisplayTurn } from './messaging/display-turn.js';
import { registerNotifyTool } from './notifications/tool.js';
import { BOT_FOLLOW_UP_TOOL_NAME, registerFollowUpTool } from './proactive/follow-up-tool.js';
import type {} from './connectors/service.js';
import type { Context } from '@deepseek-ai/cordis';
import { dirname } from 'node:path';
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent';
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import en from '../../locale/en.json' with { type: 'json' };
import { BOT_ID_PATTERN } from '../shared/ids.js';
import type {} from './registry.js';
import { DshBotError } from './errors.js';
import { registerMemoryContext } from './memory/context.js';
import { rootInstructionNotice } from './memory/root-instructions.js';
import { installLivePersona } from './live-persona.js';
import { createMemoryTools, MEMORY_TOOL_NAMES } from './memory/tools.js';
import { retiredMemoryGuidance } from './memory/tool-guidance.js';
import { BOT_MANAGE_TOOL_NAME, registerBotPresetManage } from './tools/bot-manage.js';
import { registerBotPresetActivity } from './activity/tracker.js';
import { BOT_DELEGATE_TOOL_NAME, registerDelegateTool } from './delegate/tool.js';
import { registerSupergroupTool } from './supergroup/tool.js';

// Compatibility only: do not pass retired local tools to native restrict(),
// which rejects unknown names. Keep unrelated unknown names strict.
const RETIRED_ROUTINE_TOOL_NAMES: readonly string[] = [
  'routine_create',
  'routine_list',
  'routine_update',
  'routine_delete',
  'routine_run_now',
];

export const name = 'dsh-bot-context';
export const inject = ['dshBots', 'tools', 'llm', 'systemPrompt', 'agents'];

export interface Config {
  botId: string;
}

export const Config: Schema<Config> = Schema.object({
  botId: Schema.string().pattern(BOT_ID_PATTERN).required(),
});

export { getBotBinding, type BotBinding } from './data-flow/agent-binding.js';
import { bindings, type BotBinding } from './data-flow/agent-binding.js';

const blankPreparations = new WeakMap<object, (agent: Agent, expected: BotBinding) => Promise<void>>();
export function blankBotPreparation(agent: Agent) {
  for (const scope of scopeChainOf(scopeOf(agent.ctx))) {
    const prepare = blankPreparations.get(scope);
    if (prepare) return prepare;
  }
}

/** Mounted inside a preset; its closure is retained with that preset generation. */
export function apply(ctx: Context, config: Config): void {
  const { botId } = Config(config);
  // Never enqueue a Remote-style get here: preset activation is itself awaited
  // by registry writes. Copy now so retained generations keep their old policy.
  const bot = ctx.dshBots.presetBot(botId);
  registerBotPresetActivity(ctx, botId, bot.createdAt);
  const memoryPolicy = { ...bot.memory };
  const { memorySectionOrder } = ctx.dshBots.config;
  const deniedMemory = new Set(bot.tools.deny.filter((name) => MEMORY_TOOL_NAMES.includes(name)));
  const denyBotManage = bot.tools.deny.includes(BOT_MANAGE_TOOL_NAME);
  if (!denyBotManage) registerBotPresetManage(ctx, botId);
  const deny = bot.tools.deny.filter(
    (name) =>
      !deniedMemory.has(name) &&
      name !== BOT_MANAGE_TOOL_NAME &&
      name !== BOT_DELEGATE_TOOL_NAME &&
      name !== BOT_FOLLOW_UP_TOOL_NAME &&
      name !== BOT_GROUP_RECALL_TOOL_NAME &&
      name !== 'bot_notify' &&
      name !== 'bot_message' &&
      name !== 'group_message' &&
      name !== 'bot_supergroup' &&
      !RETIRED_ROUTINE_TOOL_NAMES.includes(name),
  );
  const model = bot.model
    ? {
        provider: bot.model.provider,
        model: bot.model.model,
        ...(bot.model.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(bot.model.reasoningEffort) }),
      }
    : undefined;
  const binding = Object.freeze({ botId, botCreatedAt: bot.createdAt });

  const shouldUseBotModel = (agent: Agent) => {
    // Only a reserved group child with matching lineage/preset can override this Bot default.
    if (getGroupWorkerBinding(agent)?.modelSelection) return false;
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
      throw new DshBotError(
        'bot/preset-failed',
        `Bot '${botId}' model '${model.provider}/${model.model}' is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  };

  // A retained preset generation owns this map. Retiring a generation does not
  // unload it while Agents still reference it; explicit plugin unload does.
  ctx.effect(() => {
    const agents = new Map<Agent, (leavingBlank?: boolean) => Promise<void>>();
    const presetScope = scopeOf(ctx);
    if (!presetScope) throw new Error('Bot context requires a preset scope');
    const ownsPreset = (agent: Agent) => scopeChainOf(scopeOf(agent.ctx)).includes(presetScope);
    let stopped = false;
    const prepare = async (agent: Agent, source: SessionStartSource) => {
      if (bindings.has(agent)) throw new Error(`Agent ${agent.id} already has a Bot binding`);
      const readOnlyGroupFollowUp = Boolean(getGroupWorkerBinding(agent)?.restrictedInputId);
      const scoped = getScopedCollaborationBinding(agent);
      const cleanTask = Boolean(scoped || isSupergroupWorker(agent));
      const collaborationTools = scoped?.phase !== 'draft';
      if (model && shouldUseBotModel(agent)) await validateModel();
      if (stopped) throw new DshBotError('bot/unavailable', `Bot '${botId}' context is unloading`);
      const admission = ctx.dshBots.memoryAdmission;
      admission?.protect(agent);
      const memory = !cleanTask && memoryPolicy.enabled ? ctx.dshBots.memoryFor(botId) : undefined;
      let homeText = 'Private directory unavailable; use the current workspace under native permissions and approval.';
      try {
        if (cleanTask) throw new Error('Task execution uses its inherited workspace');
        const { path } = await ctx.dshBots.ensureHome(botId);
        const root = dirname(dirname(path));
        const cwd = agent.session.header.cwd;
        homeText = [
          `Your private working directory is ${JSON.stringify(path)}; put your files there.`,
          cwd === root
            ? `Your cwd is the shared Bots root ${JSON.stringify(root)}.`
            : `Your cwd is ${JSON.stringify(cwd)}; the shared Bots root is ${JSON.stringify(root)}.`,
          'Bots share this root without isolation; writes outside it follow native permissions and approval.',
        ].join('\n');
      } catch {
        // Filesystem failure must not prevent ordinary session initialization.
        // Do not expose a guessed or unverified private path in the fallback.
        if (!cleanTask) ctx.logger.warn(`[dsh-bot] private home prompt unavailable bot=${botId}`);
      }
      if (stopped || !ownsPreset(agent)) throw new DshBotError('bot/unavailable', `Bot '${botId}' context is unavailable`);
      const retainedGuards: Array<() => void> = [];
      const dispose = agent.ctx.effect(() => {
        const releases: Array<() => void> = [];
        const cleanup = () => {
          agents.delete(agent);
          bindings.delete(agent);
          const errors: unknown[] = [];
          for (const release of releases.splice(0).reverse()) {
            try {
              release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length) throw new AggregateError(errors, 'Bot agent cleanup failed');
        };
        try {
          releases.push(installLivePersona(agent,
            () => ctx.dshBots.personaSnapshot(botId, bot.createdAt),
            listener => ctx.dshBots.subscribePersonaChanges(listener)));
          releases.push(agent.ctx.systemPrompt.section({ name: 'dsh-bot:identity', order: memorySectionOrder,
            interpolate: false, text: () => {
              const current = ctx.dshBots.onboardingSnapshot?.(botId, bot.createdAt) ?? bot;
              return en.tools['bot_supergroup.identity'].replace('{identity}', () => JSON.stringify({
                id: current.id, name: current.name, description: current.description,
              }));
            } }));
          if (!cleanTask) {
            releases.push(protectGroupRecall(agent, binding, ctx.dshBots));
            releases.push(installLiveGroupRecall(agent, binding, ctx.dshBots, memorySectionOrder));
          }
          releases.push(agent.ctx.systemPrompt.context({ name: 'dsh-bot:root-instructions', order: memorySectionOrder,
            required: true, interpolate: false, text: rootInstructionNotice }));
          // Do not silently ignore unknown, same-layer or reserved tool names.
          if (deny.length) releases.push(agent.ctx.tools.restrict({ deny }));
          // The public restriction filters inherited tools. Local checked
          // collaboration tools are registered below; drafts register none.
          if (cleanTask) releases.push(agent.ctx.tools.restrict({ allow: [] }));
          releases.push(
            agent.ctx.systemPrompt.section({
              name: 'dsh-bot:home',
              order: memorySectionOrder,
              text: homeText,
              interpolate: false,
            }),
          );
          if (memory) {
            releases.push(retiredMemoryGuidance(agent));
            // restrict() only hides inherited tools in rc.2. Omit denied local
            // definitions so schema lookup and dispatch agree for memory tools.
            for (const tool of createMemoryTools(memory, agent, async rows => {
              const kernel = ctx.dshBots.memoryKernel;
              if (!kernel || !admission) throw new Error('Memory lineage is unavailable');
              await admission.recordRead(agent.session.id, rows.map(row => {
                const version = kernel.snapshot.versions.get(row.id);
                if (!version) throw new Error('Memory changed during read'); return version.versionId;
              }));
            })) {
              if (!readOnlyGroupFollowUp && !deniedMemory.has(tool.name)) releases.push(agent.ctx.tools.register(tool));
            }
            const kernel = ctx.dshBots.memoryKernel;
            if (!kernel || !admission) throw new Error('Memory kernel is not ready');
            releases.push(registerMemoryContext(agent, binding, kernel, admission, ctx.dshBots.config, memoryPolicy.injectLimit,
              () => getGroupWorkerBinding(agent)?.audience));
          }
          bindings.set(agent, binding);
          if (!readOnlyGroupFollowUp && !bot.tools.deny.includes('bot_supergroup') && !agent.session.header.parentSession) {
            releases.push(registerSupergroupTool(agent));
          }
          if (!cleanTask && !readOnlyGroupFollowUp && !bot.tools.deny.includes(BOT_FOLLOW_UP_TOOL_NAME)) {
            releases.push(registerFollowUpTool(agent));
            releases.push(agent.ctx.systemPrompt.section({ name: 'dsh-bot:follow-up', order: memorySectionOrder,
              interpolate: false, text: en.tools['bot_follow_up.guidance'] }));
          }
          retainedGuards.push(protectDelegateContinuation(agent, binding, source));
          releases.push(protectScopedCollaboration(agent, binding, source) ?? (() => {}));
          retainedGuards.push(protectOnboarding(agent, binding, ctx.dshBots));
          const releaseDataFlow = protectDataFlow(agent, binding, ctx.dshBots);
          if (releaseDataFlow) retainedGuards.push(releaseDataFlow);
          const safety = agent.ctx.get('dshBotMessagingSafety');
          if (safety) safety.protect(agent);
          if (safety && ctx.dshBots.config.messagingEnabled) {
            if (!agent.session.header.parentSession) releases.push(registerDisplayTurn(agent));
            if (collaborationTools && !bot.tools.deny.includes('bot_message') && (!agent.session.header.parentSession || scoped)) {
              releases.push(registerMessageTool(agent, safety));
              if (!agent.session.header.parentSession) releases.push(registerResultRecall(agent, ctx.dshBots));
              releases.push(agent.ctx.systemPrompt.context({ name: 'dsh-bot:teammates', order: memorySectionOrder, required: true,
                interpolate: false, text: () => {
                  const rows = ctx.dshBots.directorySnapshot().filter((b) => b.id !== botId)
                    .map((b) => ({ ...b, description: [...b.description].slice(0, 160).join('') }));
                  let text = `${en.tools['bot_message.peerGuidance']}\n`;
                  if (ctx.dshBots.config.supergroup.enabled) text += `${en.tools['bot_supergroup.collaborationGuidance']}\n`;
                  let incomplete = false;
                  for (const row of rows) {
                    const line = `${JSON.stringify(row)}\n`;
                    if (Buffer.byteLength(text + line) > ctx.dshBots.config.messageDirectoryBytes - 100) { incomplete = true; break; }
                    text += line;
                  }
                  return text + (incomplete ? 'Directory incomplete. Use bot_message action=list to page through all teammates.' : '');
                } }));
            }
          }
          releases.push(
            agent.ctx.systemPrompt.section({
              name: 'dsh-bot:schedule',
              order: memorySectionOrder,
              text: en.tools['schedule.guidance'],
              interpolate: false,
            }),
          );
          if (collaborationTools && (!cleanTask || scoped) && !readOnlyGroupFollowUp && !bot.tools.deny.includes(BOT_DELEGATE_TOOL_NAME)) {
            releases.push(registerDelegateTool(agent));
            if (!agent.session.header.parentSession) releases.push(agent.ctx.systemPrompt.section({
              name: 'dsh-bot:background-work', order: memorySectionOrder, interpolate: false,
              text: en.tools['bot_delegate.guidance'].replace('{botId}', botId),
            }));
          }
          if (model) {
            // Only alter route variables, never text/tools or other assembly
            // fields. Session history and explicit selection remain authoritative.
            let useBotModel = false;
            releases.push(
              agent.ctx.on(
                'system-prompt/assemble',
                async (_assembly, _context, next) => {
                  useBotModel = false;
                  const selected = shouldUseBotModel(agent);
                  if (selected) await validateModel();
                  const assembled = await next();
                  useBotModel = selected && !stopped;
                  if (!useBotModel) return assembled;
                  return {
                    ...assembled,
                    variables: { ...assembled.variables, provider: model.provider, model: model.model },
                  };
                },
                { prepend: true },
              ),
            );
            releases.push(
              agent.ctx.on(
                'agent/request',
                async (_payload, next) => {
                  const resolved = await next();
                  if (!useBotModel) return resolved;
                  await validateModel();
                  if (stopped) return resolved;
                  const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
                  return { ...rest, ...model };
                },
                { prepend: true },
              ),
            );
          }
          return cleanup;
        } catch (error) {
          cleanup();
          throw error;
        }
      }, `dsh-bot: agent ${botId}`);
      const notifications = agent.ctx.get('dshBotNotifications');
      const releaseNotify =
        !cleanTask && notifications && !bot.tools.deny.includes('bot_notify')
          ? registerNotifyTool(agent, binding, notifications)
          : undefined;
      const connectors = agent.ctx.get('dshBotConnectors');
      let starting: Promise<(() => Promise<void>) | undefined> | undefined;
      let closing: Promise<void> | undefined;
      const cleanup = (leavingBlank = false) => {
        closing ??= (async () => {
          dispose();
          releaseNotify?.();
          if (leavingBlank) for (const release of retainedGuards.reverse()) release();
          const releaseConnector = await starting;
          await releaseConnector?.();
        })();
        return closing;
      };
      // Publish cleanup before the asynchronous MCP start. A preset can unload
      // while agent/created is awaiting discovery; teardown must join that start.
      agents.set(agent, cleanup);
      starting = cleanTask ? undefined : connectors?.attach(agent, binding);
      try {
        await starting;
        if (stopped) throw new DshBotError('bot/unavailable', 'Bot context is unloading');
      } catch (error) {
        await cleanup();
        throw error;
      }
    };
    const offCreated = ctx.on('agent/created', async ({ agent, source }) => { await prepare(agent, source); return undefined; });
    const offSelected = ctx.on('agent-preset/selected', (sessionId) => {
      const agent = ctx.agents.get(sessionId);
      const cleanup = agent && agents.get(agent);
      if (!agent || !cleanup || ownsPreset(agent)) return;
      // Retain egress and onboarding guards when a turnless record still
      // carries business content, pending input, or prior data-flow facts.
      let disposable = false;
      try {
        const flow = outlets(ctx.dshBots);
        disposable = !flow?.kernel.domain.table('flow_sessions').get(sessionId) &&
          !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length &&
          !agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result');
      } catch { /* Keep Agent-owned guards if data-flow state is ambiguous. */ }
      void cleanup(disposable).catch(() => ctx.logger.warn('[dsh-bot] blank Bot context cleanup failed'));
    });
    // Native blank preset selection does not replay agent/created. Recover
    // against this exact preset generation without registering a service.
    blankPreparations.set(presetScope, async (agent, expected) => {
      if (!ownsPreset(agent) || expected.botId !== botId || expected.botCreatedAt !== binding.botCreatedAt)
        throw new DshBotError('bot/conflict', 'Bot preset scope changed');
      if (!agents.has(agent)) await prepare(agent, 'resume');
    });
    return async () => {
      stopped = true;
      offCreated();
      offSelected();
      blankPreparations.delete(presetScope);
      const errors: unknown[] = [];
      for (const dispose of [...agents.values()]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      agents.clear();
      if (errors.length) throw new AggregateError(errors, 'Bot preset cleanup failed');
    };
  }, `dsh-bot: preset ${botId}`);
}
