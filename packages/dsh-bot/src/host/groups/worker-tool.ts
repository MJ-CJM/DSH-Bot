import en from '../../../locale/en.json' with { type: 'json' };
import type { BotKey } from '../../shared/identity.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { OperationError, digest } from '../common/operations.js';
import type { GroupModelSelection } from '../../shared/groups.js';
import type { GroupState } from './state.js';
import type { GroupTurnRunner } from './turn-runner.js';
export interface WorkerBinding { turnId: string; deliveryId: string; childId: string; rootId: string; presetId: string; resumeAllowed?: boolean; approvedInputs?: Set<string>; restrictedInputId?: string; modelSelection?: GroupModelSelection; audience: BotKey[]; isActive?: () => boolean; agent?: Agent }
const bindings = new WeakMap<Agent, WorkerBinding>();
export const workerReservations = new Map<string, WorkerBinding>();
export function getGroupWorkerBinding(agent: Agent) {
  const binding = workerReservations.get(agent.session.id) ?? bindings.get(agent);
  return binding && agent.session.header.parentSession === binding.rootId && agent.session.header.agentPreset === binding.presetId ? binding : undefined;
}
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
export function admitGroupInput(binding: WorkerBinding, content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[]) {
  // rc.2/rc.5 public relay events prepend this native sender block (A fixture verifies it).
  binding.approvedInputs ??= new Set();
  binding.approvedInputs.add(digest([{ type: 'text', text: `Agent ${binding.rootId} sent a message: ` }, ...content]));
}
const definitions = new WeakMap<Agent, { definition: ToolDefinition; live: () => boolean }>();
export function isOwnedGroupTool(agent: Agent, name: string): boolean {
  const owned = definitions.get(agent);
  return name === 'group_message' && Boolean(owned?.live() && agent.ctx.tools.get(name, agent) === owned.definition);
}
export const groupToolInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({ action: z.literal('send'), to: z.string().min(1).optional(), targets: z.array(z.string().min(1)).min(1).max(16).optional(), kind: z.enum(['request', 'progress']).optional(), text: z.string().trim().min(1).max(65536),
    replyTo: z.string().min(1).optional(), requestReply: z.boolean().default(false) }),
]);
/** Only a pre-reserved local worker receives the tool; no address is model supplied. */
export function installWorkerTools(state: GroupState, runner: GroupTurnRunner) {
  return state.ctx.effect(() => {
    const releases = new Set<() => void>();
    const off = state.ctx.on('agent/created', async ({ agent, source }) => {
      const binding = state.workers.get(agent.session.id);
      if (!binding || (source !== 'startup' && !binding.resumeAllowed) || binding.agent || agent.session.header.parentSession !== binding.rootId || agent.session.header.agentPreset !== binding.presetId) return;
      binding.agent = agent;
      if (binding.restrictedInputId) return;
      const delivery = state.table('deliveries').get(binding.deliveryId);
      if (!delivery || (await state.bot(delivery.bot)).tools.deny.includes('group_message')) return;
      bindings.set(agent, binding);
      const live = () => binding.agent === agent && !state.stopped && state.workers.get(agent.session.id) === binding &&
        !state.cancelledTurns.has(binding.turnId) && Boolean(binding.isActive?.());
      const definition = defineTool({
        name: 'group_message',
        description: en.tools['group_message.description'],
        parameters: { action: { type: 'string', required: true, enum: ['send', 'skip'] },
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
        return () => { definitions.delete(agent); bindings.delete(agent); unregister(); releases.delete(release); };
      }, 'dsh-bot: group worker tool');
      releases.add(release);
    });
    return () => { off(); for (const release of releases) release(); releases.clear(); };
  }, 'dsh-bot: owned group workers');
}
