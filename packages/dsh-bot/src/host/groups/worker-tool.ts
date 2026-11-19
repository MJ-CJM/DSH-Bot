import en from '../../../locale/en.json' with { type: 'json' };
import type { BotKey } from '../../shared/identity.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { OperationError, digest } from '../common/operations.js';
import type { GroupModelSelection } from '../../shared/groups.js';
import type { GroupState } from './state.js';
import type { GroupTurnRunner } from './turn-runner.js';
import { checkSupergroup, reserveSupergroupRequest } from './supergroup-admission.js';
export interface WorkerBinding { turnId: string; deliveryId: string; childId: string; rootId: string; presetId: string; resumeAllowed?: boolean; approvedInputs?: Set<string>; restrictedInputId?: string; modelSelection?: GroupModelSelection; audience: BotKey[]; automaticSupergroup?: boolean; isActive?: () => boolean; agent?: Agent }
const bindings = new WeakMap<Agent, WorkerBinding>();
export const workerReservations = new Map<string, WorkerBinding>();
const workerStates = new Set<GroupState>();
/** Derive the privacy boundary from an exact Host reservation before preset initialization. */
function automaticBinding(agent: Agent, binding: WorkerBinding): boolean {
  if (binding.childId !== agent.session.id || workerReservations.get(binding.childId) !== binding) return false;
  for (const state of workerStates) {
    if (state.stopped || state.workers.get(binding.childId) !== binding) continue;
    const turn = state.table('turns').get(binding.turnId), group = turn && state.table('groups').get(turn.group.groupId);
    if (group?.supergroup && group.createdAt === turn?.group.groupCreatedAt && group.rootSessionId === binding.rootId) return true;
  }
  return false;
}
export function getGroupWorkerBinding(agent: Agent) {
  const binding = workerReservations.get(agent.session.id) ?? bindings.get(agent);
  if (!binding || agent.session.header.parentSession !== binding.rootId || agent.session.header.agentPreset !== binding.presetId) return;
  binding.automaticSupergroup = automaticBinding(agent, binding);
  return binding;
}
/** A persisted supergroup marker alone cannot classify an unrelated Agent. */
export const isSupergroupWorker = (agent: Agent): boolean => Boolean(getGroupWorkerBinding(agent)?.automaticSupergroup);
export function isLiveGroupWorker(agent: Agent): boolean {
  const binding = getGroupWorkerBinding(agent);
  return Boolean(binding && binding.agent === agent && workerReservations.get(agent.session.id) === binding && binding.isActive?.());
}
/** Only exact inputs admitted by the group bridge retain the shared label. */
export function isAdmittedGroupInput(agent: Agent, message: import('@deepseek-ai/dsh-llm').UserMessage): boolean {
  const binding = getGroupWorkerBinding(agent);
  if (!binding || !isLiveGroupWorker(agent)) return false;
  if (binding.restrictedInputId)
    return message.id === binding.restrictedInputId && message.source.kind === 'dsh-bot-group-owner-followup' &&
      message.source.turnId === binding.turnId;
  return Boolean(message.source.kind === 'agent-message' && message.source.senderSessionId === binding.rootId &&
    binding.approvedInputs?.has(digest(message.content)));
}
export function admitGroupInput(binding: WorkerBinding, content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[], sender: Agent) {
  if (sender.id !== binding.rootId || sender.session.id !== binding.rootId || sender.ctx.get('agents')?.get(sender.id) !== sender)
    throw new OperationError('approval-denied');
  // 0.2.2 names relays through public namesOf; 0.2.1 uses the Session id.
  // Admit one exact native prefix, never a set of guessed display names.
  const native = sender.ctx.get('subagents') as (typeof sender.ctx.subagents & { namesOf?: (agent: Agent) => { readonly self: string } }) | undefined;
  if (!native || (native.namesOf !== undefined && typeof native.namesOf !== 'function')) throw new OperationError('unavailable');
  const senderName = native.namesOf === undefined ? binding.rootId : native.namesOf(sender).self;
  if (typeof senderName !== 'string' || !senderName) throw new OperationError('unavailable');
  binding.approvedInputs ??= new Set();
  binding.approvedInputs.add(digest([{ type: 'text', text: `Agent ${senderName} sent a message: ` }, ...content]));
}
const definitions = new WeakMap<Agent, { definition: ToolDefinition; live: () => boolean }>();
export function isOwnedGroupTool(agent: Agent, name: string): boolean {
  const owned = definitions.get(agent);
  return name === 'group_message' && Boolean(owned?.live() && agent.ctx.tools.get(name, agent) === owned.definition);
}
export const groupToolInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({ action: z.literal('request-expert'), botId: z.string().min(1), question: z.string().trim().min(1).max(8192) }),
  z.strictObject({ action: z.literal('send'), to: z.string().min(1).optional(), targets: z.array(z.string().min(1)).min(1).max(16).optional(), kind: z.enum(['request', 'progress']).optional(), text: z.string().trim().min(1).max(65536),
    replyTo: z.string().min(1).optional(), requestReply: z.boolean().default(false) }),
]);
/** Only a pre-reserved local worker receives the tool; no address is model supplied. */
export function installWorkerTools(state: GroupState, runner: GroupTurnRunner) {
  return state.ctx.effect(() => {
    workerStates.add(state);
    const releases = new Set<() => void>();
    const off = state.ctx.on('agent/created', async ({ agent, source }) => {
      const binding = state.workers.get(agent.session.id);
      if (!binding || (source !== 'startup' && !binding.resumeAllowed) || binding.agent || agent.session.header.parentSession !== binding.rootId || agent.session.header.agentPreset !== binding.presetId) return;
      binding.agent = agent;
      if (state.table('turns').get(binding.turnId)?.routing) agent.ctx.effect(() => agent.ctx.on('agent/request', async ({ agent: requesting }, next) => {
        if (requesting === agent) await state.queue.run(async () => {
          const turn = state.table('turns').get(binding.turnId);
          if (turn?.routing && state.workers.get(agent.session.id) === binding && binding.isActive?.())
            await state.putTurn({ ...turn, routing: { ...turn.routing, modelRequests: (turn.routing.modelRequests ?? 0) + 1 } });
        });
        return next();
      }, { prepend: true }), 'dsh-bot: ordinary group observed request count');
      const turn = state.table('turns').get(binding.turnId);
      if (turn?.memoryStatusOnly) {
        agent.ctx.effect(() => agent.ctx.tools.guard(exec =>
          exec.agent === agent && exec.parent === undefined &&
          ['bot_memory_save', 'bot_memory_list', 'bot_memory_search'].includes(exec.name)
            ? undefined : 'This group turn permits only private memory operations'), 'dsh-bot: private memory status tool boundary');
        return;
      }
      const group = state.table('groups').get(turn?.group.groupId ?? '');
      if (group?.supergroup) agent.ctx.effect(() => agent.ctx.tools.guard(exec =>
        exec.agent === agent && exec.name === 'group_message' && exec.parent === undefined
          ? undefined : 'Supergroup P0 permits only checked group collaboration'), 'dsh-bot: supergroup read-only tool boundary');
      if (group?.supergroup) agent.ctx.effect(() => agent.ctx.on('agent/request', async ({ agent: requesting }, next) => {
        if (requesting !== agent || !isLiveGroupWorker(agent)) throw new OperationError('approval-denied');
        await checkSupergroup(state, group);
        await reserveSupergroupRequest(state, group);
        return next();
      }, { prepend: true }), 'dsh-bot: supergroup native request budget');
      if (binding.restrictedInputId) return;
      const delivery = state.table('deliveries').get(binding.deliveryId);
      if (!delivery || (await state.bot(delivery.bot)).tools.deny.includes('group_message')) return;
      bindings.set(agent, binding);
      const live = () => binding.agent === agent && !state.stopped && state.workers.get(agent.session.id) === binding &&
        !state.cancelledTurns.has(binding.turnId) && Boolean(binding.isActive?.());
      const definition = defineTool({
        name: 'group_message',
        description: `${en.tools['group_message.description']}${group?.supergroup ? `\n${en.tools['group_message.expertGuidance']}` : ''}`,
        parameters: { action: { type: 'string', required: true, enum: ['send', 'skip', ...(group?.supergroup ? ['request-expert'] : [])] },
          botId: { type: 'string', description: 'Exact botId from the authorized expert directory; used with action=request-expert.' },
          question: { type: 'string', description: 'Specific task question for that expert, up to 8192 characters; used with action=request-expert.' },
          to: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['request', 'progress'] }, text: { type: 'string' }, replyTo: { type: 'string' }, requestReply: { type: 'boolean' } },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute(_args, exec) {
          exec.signal.throwIfAborted();
          if (exec.agent !== agent || exec.parent !== undefined || !live() || !isOwnedGroupTool(agent, exec.name)) throw new OperationError('approval-denied');
          return JSON.parse(JSON.stringify(await runner.groupMessage(agent, binding, groupToolInput.parse(exec.arguments), JSON.stringify([
            agent.session.snapshotEvents().findLast(e => e.type === 'step/start' || e.type === 'turn/start')?.seq,
            exec.rootCallId, exec.callId]), exec.signal)));
        },
      });
      const release = agent.ctx.effect(() => {
        definitions.set(agent, { definition, live });
        const unregister = agent.ctx.tools.register(definition);
        const offDirectory = group?.supergroup ? agent.ctx.systemPrompt.context({
          name: 'dsh-bot:supergroup-experts', order: 9055, required: true, interpolate: false,
          text: () => {
            if (!live()) return '';
            const readers = group.supergroup?.readers ?? [];
            const directory = state.registry.directorySnapshot().filter(row => {
              if (row.id === delivery.bot.botId) return false;
              const reader = readers.find(key => key.botId === row.id);
              return reader !== undefined && state.registry.onboardingSnapshot(reader.botId, reader.botCreatedAt) !== undefined;
            }).map(row => ({ id: row.id, name: [...row.name].slice(0, 64).join(''),
              description: [...row.description].slice(0, 160).join('') }));
            return `${en.tools['group_message.expertGuidance']}\n${JSON.stringify({ authorizedExperts: directory })}`;
          },
        }) : () => {};
        return () => { offDirectory(); definitions.delete(agent); bindings.delete(agent); unregister(); releases.delete(release); };
      }, 'dsh-bot: group worker tool');
      releases.add(release);
    });
    return () => { workerStates.delete(state); off(); for (const release of releases) release(); releases.clear(); };
  }, 'dsh-bot: owned group workers');
}
