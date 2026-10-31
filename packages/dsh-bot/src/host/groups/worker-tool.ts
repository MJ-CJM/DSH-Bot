import en from '../../../locale/en.json' with { type: 'json' };
import type { BotKey } from '../../shared/identity.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { OperationError } from '../common/operations.js';
import type { GroupModelSelection } from '../../shared/groups.js';
import type { GroupState } from './state.js';
import type { GroupTurnRunner } from './turn-runner.js';
export interface WorkerBinding { turnId: string; deliveryId: string; childId: string; rootId: string; presetId: string; modelSelection?: GroupModelSelection; audience: BotKey[]; isActive?: () => boolean; agent?: Agent }
const bindings = new WeakMap<Agent, WorkerBinding>();
export const workerReservations = new Map<string, WorkerBinding>();
export function getGroupWorkerBinding(agent: Agent) {
  const binding = bindings.get(agent) ?? workerReservations.get(agent.session.id);
  return binding && agent.session.header.parentSession === binding.rootId && agent.session.header.agentPreset === binding.presetId ? binding : undefined;
}
export function isLiveGroupWorker(agent: Agent): boolean {
  const binding = getGroupWorkerBinding(agent);
  return Boolean(binding && binding.agent === agent && workerReservations.get(agent.session.id) === binding && binding.isActive?.());
}
const definitions = new WeakMap<Agent, { definition: ToolDefinition; live: () => boolean }>();
export function isOwnedGroupTool(agent: Agent, name: string): boolean {
  const owned = definitions.get(agent);
  return name === 'group_message' && Boolean(owned?.live() && agent.ctx.tools.get(name, agent) === owned.definition);
}
export const groupToolInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skip') }),
  z.strictObject({ action: z.literal('send'), to: z.string().min(1).optional(), text: z.string().trim().min(1).max(65536),
    replyTo: z.string().min(1).optional(), requestReply: z.boolean().default(false) }),
]);
/** Only a pre-reserved local worker receives the tool; no address is model supplied. */
export function installWorkerTools(state: GroupState, runner: GroupTurnRunner) {
  return state.ctx.effect(() => {
    const releases = new Set<() => void>();
    const off = state.ctx.on('agent/created', async ({ agent, source }) => {
      const binding = state.workers.get(agent.session.id);
      if (source !== 'startup' || !binding || binding.agent || agent.session.header.parentSession !== binding.rootId || agent.session.header.agentPreset !== binding.presetId) return;
      binding.agent = agent;
      const delivery = state.table('deliveries').get(binding.deliveryId);
      if (!delivery || (await state.bot(delivery.bot)).tools.deny.includes('group_message')) return;
      bindings.set(agent, binding);
      const live = () => !state.stopped && state.workers.get(agent.session.id) === binding &&
        !state.cancelledTurns.has(binding.turnId) && !state.controllers.get(binding.deliveryId)?.signal.aborted;
      const definition = defineTool({
        name: 'group_message',
        description: en.tools['group_message.description'],
        parameters: { action: { type: 'string', required: true, enum: ['send', 'skip'] },
          to: { type: 'string' }, text: { type: 'string' }, replyTo: { type: 'string' }, requestReply: { type: 'boolean' } },
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
