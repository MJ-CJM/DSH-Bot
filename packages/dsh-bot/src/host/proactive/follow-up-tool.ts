import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import en from '../../../locale/en.json' with { type: 'json' };
import zh from '../../../locale/zh.json' with { type: 'json' };
import { resourceId, sameBot } from '../../shared/identity.js';
import type { Subject } from '../../shared/proactive/follow-up.js';
import { getBotBinding } from '../data-flow/agent-binding.js';
import { canReadLabel } from '../data-flow/labels.js';
import { getGroupWorkerBinding } from '../groups/worker-tool.js';
import { digest } from './wire.js';
import type {} from './index.js';

export const BOT_FOLLOW_UP_TOOL_NAME = 'bot_follow_up';
const watch = {
  title: z.string().trim().min(1).max(500),
  completion: z.string().trim().min(1).max(500),
  waitReason: z.string().trim().min(1).max(500).optional(),
  inputRequest: z.string().trim().min(1).max(500).optional(),
};
const version = z.number().int().nonnegative();
const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), cursor: z.string().max(2048).optional() }),
  z.strictObject({ action: z.literal('create'), ...watch }),
  z.strictObject({ action: z.literal('update'), cardId: resourceId, expectedRevision: version, ...watch }),
  z.strictObject({ action: z.enum(['complete', 'stop']), cardId: resourceId, expectedRevision: version }),
]).refine(value => !('waitReason' in value) || Boolean(value.waitReason) === Boolean(value.inputRequest));

interface Origin { subject: Subject; name: string; generation: string; sessionId: string; messageId: string }
async function origin(agent: Agent): Promise<Origin> {
  const registry = agent.ctx.get('dshBots');
  const binding = getBotBinding(agent);
  if (!binding || !registry) throw new HarnessError('Bot context unavailable', 'automation/invalid');
  const groupBinding = getGroupWorkerBinding(agent);
  if (groupBinding) {
    const exact = await agent.ctx.get('dshBotGroups')?.followUpWorker(agent);
    if (!exact) throw new HarnessError('Human group context unavailable', 'automation/invalid');
    const flow = registry.memoryOutlets;
    if (registry.memoryKernel && (!flow || groupBinding.audience.some(bot => !canReadLabel(flow.label(agent.session.id), bot)) ||
        flow.label(agent.session.id).restrictions.includes('no-egress')))
      throw new HarnessError('Group follow-up cannot include private material', 'automation/invalid');
    return exact;
  }
  const header = agent.session.header;
  if (header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
    throw new HarnessError('Only the current main conversation can register follow-up', 'automation/invalid');
  const bot = await registry.get(binding.botId);
  const main = await registry.mainSessions?.find(binding.botId);
  if (!sameBot(binding, { botId: bot.id, botCreatedAt: bot.createdAt }) || main?.sessionId !== agent.session.id)
    throw new HarnessError('Bot conversation changed', 'automation/conflict');
  const ambient = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']);
  const event = agent.session.snapshotEvents().findLast(row => row.type === 'user/message' && !ambient.has(row.data.source.kind));
  if (event?.type !== 'user/message' || event.data.source.kind !== 'user')
    throw new HarnessError('A human message is required', 'automation/invalid');
  return { subject: { kind: 'bot', bot: binding }, name: bot.name,
    generation: JSON.stringify([bot.createdAt, bot.updatedAt, main.sessionId]), sessionId: agent.session.id, messageId: event.data.id };
}

/** A narrow native tool, used only in an existing model turn. No inference loop or scheduler. */
export function registerFollowUpTool(agent: Agent): () => void {
  const ctx = agent.ctx;
  const lifetime = new AbortController();
  type Prepared = { argsDigest: string; origin: Origin; policyRevision: number; after: number; confirmationId?: string };
  const approved = new WeakMap<ToolExecution, Prepared>();
  const replays = new Map<string, Prepared>();
  let step = -1;
  const read = (exec: ToolExecution) => {
    lifetime.signal.throwIfAborted(); exec.signal.throwIfAborted();
    if (exec.agent !== agent || exec.parent !== undefined || ctx.tools.get(exec.name, agent) !== definition)
      throw new HarnessError('Invalid follow-up tool owner', 'automation/invalid');
    return inputSchema.parse(exec.arguments);
  };
  const operation = (exec: ToolExecution) => {
    const seq = agent.session.snapshotEvents().findLast(event => event.type === 'step/start' || event.type === 'turn/start')?.seq ?? 0;
    if (step !== seq) { replays.clear(); step = seq; }
    const hex = digest(['follow-up-tool', agent.session.id, seq, exec.rootCallId, exec.callId]);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const definition = defineTool({
    name: BOT_FOLLOW_UP_TOOL_NAME,
    description: en.tools['bot_follow_up.description'],
    parameters: {
      action: { type: 'string', enum: ['list', 'create', 'update', 'complete', 'stop'], required: true },
      title: { type: 'string' }, completion: { type: 'string' },
      waitReason: { type: 'string' }, inputRequest: { type: 'string' },
      cardId: { type: 'string' }, expectedRevision: { type: 'integer' }, cursor: { type: 'string' },
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const args = read(exec);
      const current = await origin(agent);
      const service = ctx.get('dshBotProactive');
      if (!service) throw new HarnessError('Follow-up unavailable', 'automation/unavailable');
      if (args.action === 'list') return service.followUpPage({ subject: current.subject, cursor: args.cursor });
      const commandId = operation(exec);
      const plan = approved.get(exec);
      if (!plan || plan.argsDigest !== digest(args) || JSON.stringify(plan.origin) !== JSON.stringify(current))
        throw new HarnessError('Follow-up context changed; request approval again', 'automation/conflict');
      const flush = async () => {
        if (!await ctx.get('sessions')?.flush(agent.session)) throw new HarnessError('Follow-up durability unknown', 'automation/unavailable');
        read(exec);
        // A retired service, changed member or main cannot retain authority after a flush.
        if (ctx.get('dshBotProactive') !== service || JSON.stringify(await origin(agent)) !== JSON.stringify(current))
          throw new HarnessError('Follow-up context changed', 'automation/conflict');
      };
      if (current.subject.kind === 'group') {
        if (args.action !== 'create') throw new HarnessError('Only the group owner can update follow-up', 'automation/invalid');
        const call = agent.session.snapshotEvents().findLast(event => event.type === 'tool/call' &&
          event.seq > step && event.data.name === BOT_FOLLOW_UP_TOOL_NAME && event.data.callId === exec.callId);
        if (call?.type !== 'tool/call' || digest(inputSchema.parse(JSON.parse(call.data.arguments))) !== plan.argsDigest)
          throw new HarnessError('Native group tool call unavailable', 'automation/invalid');
        await flush();
        const reply = await service.proposeGroupFollowUpWatch(commandId, { subject: current.subject, expectedRevision: plan.policyRevision, id: commandId,
          watch: { title: args.title, completion: args.completion,
            source: { kind: 'group-proposal', sessionId: current.sessionId, messageId: current.messageId,
              workerSessionId: agent.session.id, toolCallId: exec.callId },
            ...(args.waitReason && args.inputRequest ? { wait: { reason: args.waitReason, request: args.inputRequest } } : {}) } });
        return reply.kind === 'receipt' ? { ...reply, state: 'awaiting-owner-confirmation' } : reply;
      }
      if (!plan.confirmationId) {
        const events = agent.session.snapshotEvents();
        const asked = events.findLast(event => event.type === 'approval/asked' && event.seq > plan.after &&
          event.data.toolName === BOT_FOLLOW_UP_TOOL_NAME && event.data.callId === exec.callId);
        if (asked?.type !== 'approval/asked' || !events.some(event => event.type === 'approval/decided' &&
            event.seq > asked.seq && event.data.id === asked.data.id && event.data.outcome === 'allowed-once'))
          throw new HarnessError('Native approval receipt unavailable', 'automation/invalid');
        plan.confirmationId = `${agent.session.id}:${asked.data.id}`;
      }
      await flush();
      if (args.action === 'complete' || args.action === 'stop')
        return service.followUpAction(commandId, { subject: current.subject, cardId: args.cardId,
          expectedRevision: args.expectedRevision, expectedPolicyRevision: plan.policyRevision, action: args.action });
      if (!('title' in args)) throw new HarnessError('Invalid follow-up action', 'automation/invalid');
      const draft = { title: args.title, completion: args.completion,
        source: { kind: 'message' as const, sessionId: current.sessionId, messageId: current.messageId, confirmationId: plan.confirmationId },
        ...(args.waitReason && args.inputRequest ? { wait: { reason: args.waitReason, request: args.inputRequest } } : {}),
      };
      return args.action === 'create'
        ? service.createFollowUpWatch(commandId, { subject: current.subject, expectedRevision: plan.policyRevision, id: commandId, watch: draft })
        : service.updateFollowUpWatch(commandId, { subject: current.subject, expectedPolicyRevision: plan.policyRevision,
          cardId: args.cardId, expectedRevision: args.expectedRevision, watch: draft });
    },
  });
  return ctx.effect(() => {
    const off = ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== BOT_FOLLOW_UP_TOOL_NAME) return next();
      const args = read(exec);
      const source = await origin(agent);
      const service = ctx.get('dshBotProactive');
      const summary = await service?.followUpSummary(source.subject);
      if (!summary?.policy.localEnabled) throw new HarnessError('Enable follow-up in this Bot or group first', 'automation/unavailable');
      const decision = await next();
      if (decision.kind === 'deny' || decision.kind === 'cancel' || args.action === 'list') return decision;
      if (source.subject.kind === 'group' && args.action !== 'create')
        return { kind: 'deny', reason: 'Only the group owner can update follow-up' };
      const commandId = operation(exec);
      const previous = replays.get(commandId);
      if (previous && (previous.argsDigest !== digest(args) || JSON.stringify(previous.origin) !== JSON.stringify(source)))
        throw new HarnessError('Invocation changed', 'automation/conflict');
      const plan = previous ?? { argsDigest: digest(args), origin: source, policyRevision: summary.policy.revision,
        after: agent.session.snapshotEvents().at(-1)?.seq ?? -1 };
      approved.set(exec, plan); replays.set(commandId, plan);
      // Native delegated approvals stay disabled. A group create can only propose a draft.
      if (source.subject.kind === 'group') return decision;
      if (previous?.confirmationId) return decision;
      const describe = (dict: typeof en, locale: 'en' | 'zh') => {
        const text = dict.tools['bot_follow_up.approval'].replace('{scope}', () => JSON.stringify(source.name))
          .replace('{change}', () => JSON.stringify(args));
        return decision.kind === 'ask' ? `${text}\n${decision.displayReason?.[locale] ?? decision.reason ?? ''}` : text;
      };
      const displayReason = { en: describe(en, 'en'), zh: describe(zh, 'zh') };
      return { kind: 'ask', reason: displayReason.en, displayReason };
    }, { prepend: true });
    try {
      const release = ctx.tools.register(definition);
      return () => { lifetime.abort(); release(); off(); replays.clear(); };
    } catch (error) { off(); throw error; }
  }, 'dsh-bot: explicit follow-up tool');
}
