import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import en from '../../../locale/en.json' with { type: 'json' };
import { getBotBinding } from '../data-flow/agent-binding.js';
import { OperationError } from '../common/operations.js';
import { supergroupCandidateIds, supergroupInputSchema } from './service.js';

export const SUPERGROUP_TOOL = 'bot_supergroup';
/** Agent-owned watcher survives late Host service activation and volatile mode updates. */
export function registerSupergroupTool(agent: Agent) {
  const ctx = agent.ctx;
  return ctx.effect(() => {
    let release: (() => void) | undefined, releasePrompt: (() => void) | undefined, releaseContinuation: (() => void) | undefined;
    const definition = defineTool({ name: SUPERGROUP_TOOL, description: en.tools['bot_supergroup.description'],
      parameters: { action: { type: 'string', required: true, enum: ['start', 'continue', 'status', 'cancel'] },
        memberIds: { type: 'array', items: { type: 'string' }, description: 'Select two or more existing Bot IDs only when collaboration helps. The exact current human message is shared with the configured allowed pool; no task text is accepted.' },
        workId: { type: 'string', description: 'Omit to use the latest work in this same conversation.' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        const registry = ctx.get('dshBots'), binding = getBotBinding(agent);
        if (exec.agent !== agent || exec.parent !== undefined || ctx.tools.get(exec.name, agent) !== definition ||
          !binding || !registry?.supergroup || !registry.config.supergroup.enabled) throw new OperationError('approval-denied');
        const header = agent.session.header;
        if (header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) throw new OperationError('approval-denied');
        return JSON.parse(JSON.stringify(await registry.supergroup.invoke(agent, supergroupInputSchema.parse(exec.arguments), exec.signal)));
      },
    });
    const sync = () => {
      const registry = ctx.get('dshBots'), binding = getBotBinding(agent);
      const enabled = !!binding && !!registry?.supergroup && !!registry.config.supergroup.enabled
        && !agent.session.header.parentSession && !agent.session.header.origin;
      // Bot deny policy is checked against the current committed record, not a stale preset copy.
      const bot = enabled && binding && registry?.onboardingSnapshot(binding.botId, binding.botCreatedAt);
      releasePrompt?.(); releasePrompt = undefined; releaseContinuation?.(); releaseContinuation = undefined;
      if (enabled && bot && !bot.tools.deny.includes(SUPERGROUP_TOOL)) {
        release ??= ctx.tools.register(definition);
        const available = registry!.directorySnapshot();
        let ids: string[] = [];
        try { ids = supergroupCandidateIds(binding!.botId, available, registry!.config.supergroup); }
        catch { /* An explicitly oversized configuration grants no discoverable pool. */ }
        const directory = ids.flatMap(id => available.filter(row => row.id === id));
        releasePrompt = ctx.systemPrompt.section({ name: 'dsh-bot:supergroup', order: 9050,
          text: `${en.tools['bot_supergroup.instructions']}\n${JSON.stringify(directory)}` });
        if (registry?.supergroup?.continuationInstruction) releaseContinuation = ctx.systemPrompt.context({ name: 'dsh-bot:original-task-continuation', order: 9051, required: true, interpolate: false,
          text: () => ctx.get('dshBots')?.supergroup?.continuationInstruction(agent) ?? '' });
      } else { release?.(); release = undefined; }
    };
    const offInput = ctx.on('agent/pre-step', async (payload, next) => {
      await ctx.get('dshBots')?.supergroup?.checkContinuation?.(agent, payload.messages); return next();
    });
    const offStatus = ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') void ctx.get('dshBots')?.supergroup?.observeContinuation?.(agent)?.catch(() => {});
    });
    const off = ctx.on('dsh-bot/supergroup-changed', sync);
    const offBots = ctx.on('dsh-bot/changed', sync);
    sync();
    return () => { off(); offBots(); releaseContinuation?.(); offInput(); offStatus(); release?.(); releasePrompt?.(); release = undefined; };
  }, 'dsh-bot: current conversation Supergroup tool');
}
