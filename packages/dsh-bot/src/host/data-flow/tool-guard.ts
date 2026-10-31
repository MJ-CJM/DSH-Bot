import { graphCapability } from './graph-capability.js';
import { connectorDestination, connectorDispatch } from './connector-boundary.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import { unknownLabel } from './labels.js';
import type { ManagedOutlets } from './outlets.js';
import { nativePolicy } from './native-policy.js';
import { isOwnedGroupTool } from '../groups/worker-tool.js';

/** Missing real Host infrastructure fails closed; older isolated unit fixtures have no memory kernel. */
export function outlets(registry: DshBotRegistry): ManagedOutlets | undefined {
  if (!registry.memoryKernel) return;
  if (!registry.memoryOutlets) throw new Error('Managed outlet service unavailable');
  return registry.memoryOutlets;
}
/** Native schedule payloads have no human authority. Only the current Bot's exact root main
 * can retain its existing audience when its own scheduler inserts a candidate notice.
 * All persistence still uses mergeLabels: an old unknown/no-egress label is never repaired here.
 */
export async function inheritOwnSchedule(agent: Agent, bot: BotKey, registry: DshBotRegistry, flow: ManagedOutlets): Promise<boolean> {
  const header = agent.session.header;
  if (header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return false;
  try {
    const current = await registry.get(bot.botId);
    if (current.createdAt !== bot.botCreatedAt) return false;
    const main = await registry.mainSessions?.find(bot.botId);
    if (main?.sessionId !== agent.session.id) return false;
    await flow.inherit(agent.session.id, { readers: [bot], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
    return true;
  } catch { return false; }
}
const local = new Set(['bot_memory_save', 'bot_memory_search', 'bot_memory_list', 'bot_memory_forget',
  'bot_message', 'bot_delegate', 'bot_notify']);
/** Own lifetime is the Agent. Unload does not remove protection from surviving Agents. */
export function protectDataFlow(agent: Agent, bot: BotKey, registry: DshBotRegistry) {
  const flow = outlets(registry); if (!flow) return;
  const native = nativePolicy(agent, bot, registry, flow);
  const legacy = !flow.kernel.domain.table('flow_sessions').get(agent.session.id) &&
    agent.session.snapshotEvents().some(e => ['user/message', 'assistant/message', 'tool/result'].includes(e.type));
  return agent.ctx.effect(() => {
    const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
      native.capture();
      const persisted = flow.kernel.domain.table('flow_sessions').get(agent.session.id);
      if (!persisted) await flow.inherit(agent.session.id, legacy || payload.messages.some(m =>
        ['dsh-bot-message', 'dsh-bot-message-sent', 'dsh-bot-group'].includes(m.source.kind)) ? unknownLabel() : {
        readers: 'shared', originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [],
      });
      for (const message of payload.messages) {
        if (message.source.kind === 'user' && !agent.session.header.parentSession) {
          await flow.inherit(agent.session.id, { readers: [bot], originTrust: 'candidate',
            sourceVersions: [], restrictions: [], grants: [] });
        } else if (message.source.kind === 'dsh-bot-onboarding') {
          if (registry.onboarding?.owns(agent, bot, message)) await flow.inherit(agent.session.id, { readers: [bot], originTrust: 'candidate', sourceVersions: [], restrictions: [], grants: [] });
          else await flow.inherit(agent.session.id, unknownLabel());
        } else if ((message.source as { kind: string }).kind === 'schedule') {
          if (!await inheritOwnSchedule(agent, bot, registry, flow)) await flow.inherit(agent.session.id, unknownLabel());
        } else if (!['user', 'runtime-context', 'dsh-bot-message', 'dsh-bot-message-sent',
          'dsh-bot-message-wake', 'dsh-bot-group', 'dsh-bot-delegate'].includes(message.source.kind)) {
          await flow.inherit(agent.session.id, unknownLabel());
        }
      }
      return next();
    }, { prepend: true });
    const guard = agent.ctx.tools.guard(exec => {
      if (exec.agent !== agent) return 'Wrong data-flow owner';
      if (exec.name === 'bot_message' && exec.parent !== undefined) return 'bot_message disabled inside run_code';
      if (isOwnedGroupTool(agent, exec.name)) return exec.parent === undefined ? undefined : 'group_message disabled inside run_code';
      if (local.has(exec.name) || graphCapability(agent, exec.callId)) return;
      if (connectorDestination(agent, exec.name)) return;
      if (native.candidate(exec.name)) return native.reason(exec);
      // Unknown tools, generic PTC and unmanaged external MCP remain closed.
      if (flow.label(agent.session.id).sourceVersions.length ||
        flow.label(agent.session.id).readers !== 'shared') return 'Data export blocked: unaudited tool boundary';
      return 'Data export blocked: unknown tool destination';
    });
    const result = agent.ctx.on('tools/execute', async (exec, next) => {
      if (connectorDestination(agent, exec.name)) return connectorDispatch(agent, bot, registry, flow, exec, next);
      if (native.candidate(exec.name)) return native.dispatch(exec, next);
      if (exec.name === 'group_message' && (!isOwnedGroupTool(agent, exec.name) || exec.parent !== undefined))
        throw new Error('Group tool identity changed or unavailable');
      const value = await next();
      if (!local.has(exec.name) && !isOwnedGroupTool(agent, exec.name) && !graphCapability(agent, exec.callId))
        await flow.inherit(agent.session.id, unknownLabel());
      return value;
    }, { prepend: true });
    return () => { off(); guard(); result(); };
  }, 'dsh-bot: retained data-flow guard');
}
