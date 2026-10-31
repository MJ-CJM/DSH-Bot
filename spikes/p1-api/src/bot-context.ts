import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-bot-context-api-spike';
export const inject = ['dshBots', 'systemPrompt', 'tools'];

export interface Config {
  botId: string;
}

export const Config: Schema<Config> = Schema.object({
  botId: Schema.string().required(),
});

interface HostBots {
  list(): Promise<Array<{ id: string; name: string }>>;
}

const memorySection = 'dsh-bot:memory';
const agentSection = 'dsh-bot:agent-memory';
const presetTool = 'dsh_bot_scope_probe';
const agentTool = 'dsh_bot_agent_probe';
const inheritedTool = 'dsh_bot_restrict_probe';

function botsService(ctx: Context): HostBots {
  const service: unknown = ctx.get('dshBots');
  if (typeof service !== 'object' || service === null || !('list' in service)
    || typeof service.list !== 'function') {
    throw new Error('Host dshBots.list is unavailable from preset context');
  }
  return service as HostBots;
}

/** Real Loader plugin: contributions are owned by the preset generation scope. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const hostBots = await botsService(ctx).list();
  ctx.effect(() => ctx.tools.register(defineTool({
    name: inheritedTool,
    description: 'Tool inherited from the preset and hidden for each created agent.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => config.botId,
  })));
  let sameScopeRestrictionError: string | null = null;
  try {
    // Standard's tools and bot-context occupy the same preset layer: attempting
    // to hide a same-layer tool here is rejected by the public restrict API.
    const unexpected = ctx.tools.restrict({ deny: [inheritedTool] });
    ctx.effect(() => unexpected);
  } catch (error) {
    sameScopeRestrictionError = error instanceof Error ? error.message : String(error);
  }
  const text = JSON.stringify({
    botId: config.botId,
    hostIds: hostBots.map((bot) => bot.id),
    scopeTagged: scopeOf(ctx) !== undefined,
    sameScopeRestrictionError,
    presetOwnToolVisible: ctx.tools.get(inheritedTool, scopeOf(ctx)) !== undefined,
  });
  ctx.effect(() => ctx.systemPrompt.section({ name: memorySection, order: 9000, text }));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: presetTool,
    description: 'Return the configured Bot identity for the API scope spike.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async () => config.botId,
  })));

  // The preset row activates once per retained revision. Per-session snapshots
  // must instead be registered through the newly created agent's own context.
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: [inheritedTool] }));
    agent.ctx.effect(() => agent.ctx.systemPrompt.section({
      name: agentSection,
      order: 9001,
      text: JSON.stringify({ botId: config.botId, sessionId: agent.id }),
    }));
    agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
      name: agentTool,
      description: 'Return this session identity for the API scope spike.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async () => agent.id,
    })));
  }));
  ctx.logger.info(`P1_SCOPE_ACTIVATED ${text}`);
}

export async function inspectAgentScope(ctx: Context, agent: Agent) {
  const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent, agent });
  return {
    sessionId: agent.id,
    preset: ctx.agentPresets.composedPreset(agent.ctx),
    presetSection: assembly.sections.find((section) => section.name === memorySection)?.text ?? null,
    agentSection: assembly.sections.find((section) => section.name === agentSection)?.text ?? null,
    probeTools: agent.ctx.tools.schemas(agent).map((tool) => tool.name)
      .filter((tool) => tool === presetTool || tool === agentTool).sort(),
    inheritedToolVisible: agent.ctx.tools.get(inheritedTool, agent) !== undefined,
    hostBotIds: (await botsService(agent.ctx).list()).map((bot) => bot.id),
  };
}

export interface ScopeProbeOptions {
  cwd: string;
  pluginName?: string;
}

/** Uses the isolated Host's real session controller without submitting prompts. */
export async function runScopeProbe(ctx: Context, options: ScopeProbeOptions) {
  const pluginName = options.pluginName ?? 'dsh-bot-p1-spike/bot-context';
  const definitions: PresetDefinition[] = [
    ...['alpha', 'beta'].map((botId) => ({
      id: `bot-scope-${botId}`,
      name: `Scope ${botId}`,
      plugins: [{ id: 'bot-context', name: pluginName, config: { botId } }],
    })),
    { id: 'bot-scope-plain', name: 'Scope plain', plugins: [] },
    {
      id: 'bot-scope-hidden-host',
      name: 'Scope isolated Host service',
      plugins: [{
        id: 'isolated-host-service', name: 'cordis:group', group: true,
        isolate: { dshBots: true },
        config: [{ id: 'bot-context', name: pluginName, config: { botId: 'hidden' } }],
      }],
    },
  ];
  for (const definition of definitions) {
    await ctx.effect(() => ctx.agentPresets.register(definition));
  }
  const roster = await ctx.agentPresets.list();
  const rows = roster.filter((row) => row.id.startsWith('bot-scope-'));
  const results = [];
  for (const preset of ['bot-scope-alpha', 'bot-scope-alpha', 'bot-scope-beta', 'bot-scope-plain']) {
    const created = await ctx.sessionController.create({ cwd: options.cwd, agentPreset: preset });
    const agent = ctx.agents.get(created.sessionId);
    if (agent === undefined) throw new Error(`Created session ${created.sessionId} has no live agent`);
    results.push(await inspectAgentScope(ctx, agent));
  }
  const globalAssembly = await ctx.systemPrompt.assemble();
  const global = {
    sections: globalAssembly.sections.filter((section) =>
      section.name === memorySection || section.name === agentSection),
    tools: ctx.tools.schemas().map((tool) => tool.name)
      .filter((tool) => tool === presetTool || tool === agentTool || tool === inheritedTool),
  };
  const [alpha1, alpha2, beta, plain] = results;
  const pass = alpha1 !== undefined && alpha2 !== undefined && beta !== undefined && plain !== undefined
    && alpha1.presetSection === alpha2.presetSection
    && alpha1.presetSection?.includes('"sameScopeRestrictionError":"') === true
    && alpha1.agentSection !== alpha2.agentSection
    && alpha1.presetSection !== beta.presetSection
    && alpha1.probeTools.length === 2 && beta.probeTools.length === 2
    && !alpha1.inheritedToolVisible && !alpha2.inheritedToolVisible && !beta.inheritedToolVisible
    && plain.presetSection === null && plain.agentSection === null && plain.probeTools.length === 0
    && global.sections.length === 0 && global.tools.length === 0
    && rows.find((row) => row.id === 'bot-scope-hidden-host')?.broken !== undefined;
  const result = { pass, rows, agents: results, global, modelRequestsSent: 0 };
  ctx.logger.info(`P1_SCOPE_RESULT ${JSON.stringify(result)}`);
  return result;
}
