import { NATIVE_TOOL_NAMES } from '../data-flow/native-tools.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import { OperationError } from '../common/operations.js';

export type GroupWorkerMode = 'member' | 'guest' | 'memory' | 'supergroup';

const toolsByMode: Record<GroupWorkerMode, readonly string[]> = {
  member: ['group_message', 'bot_follow_up', 'bot_memory_search', 'bot_memory_list', 'bot_memory_save', 'bot_memory_forget'],
  guest: ['bot_memory_search', 'bot_memory_list'],
  memory: ['bot_memory_search', 'bot_memory_list', 'bot_memory_save'],
  supergroup: ['group_message'],
};
const definitions = new WeakMap<Agent, Set<ToolDefinition>>();
const protectedAgents = new WeakSet<Agent>();
const executionGuards = new WeakMap<Agent, (name: string) => boolean>();
const externalCapabilities = new WeakMap<Agent, (name: string) => boolean>();
export const executionWorkerMode = (mode: GroupWorkerMode | undefined): boolean =>
  mode === 'member' || mode === 'guest' || mode === 'supergroup';
/** Only the retained data-flow guard may admit native definitions and managed connectors. */
export function registerWorkerExternalCapabilities(agent: Agent, permits: (name: string) => boolean) {
  externalCapabilities.set(agent, permits);
  return () => { if (externalCapabilities.get(agent) === permits) externalCapabilities.delete(agent); };
}
/** Recheck after asynchronous persistence/approval, immediately before the real tool dispatch. */
export function assertWorkerExecution(agent: Agent, name: string) {
  if (protectedAgents.has(agent) && !executionGuards.get(agent)?.(name)) throw new OperationError('approval-denied');
}
export const groupWorkerPermits = (mode: GroupWorkerMode | undefined, name: string): boolean =>
  mode !== undefined && toolsByMode[mode].includes(name);

/** Remember the actual capability bound to this Agent, never trust a tool name by itself. */
export function registerWorkerCapability(agent: Agent, definition: ToolDefinition) {
  const unregister = agent.ctx.tools.register(definition);
  const owned = definitions.get(agent) ?? new Set<ToolDefinition>();
  definitions.set(agent, owned);
  owned.add(definition);
  return () => { owned.delete(definition); unregister(); };
}
export function ownsWorkerCapability(agent: Agent, name: string): boolean {
  const definition = agent.ctx.tools.get(name, agent);
  return definition !== undefined && definitions.get(agent)?.has(definition) === true;
}

/** The agent owns the guard through unload and loss of the worker reservation. */
export function protectWorkerCapabilities(agent: Agent, currentMode: () => GroupWorkerMode | undefined, initialMode = currentMode(), executionPermitted = () => true) {
  if (protectedAgents.has(agent)) return;
  const permits = (name: string) => {
    const mode = currentMode();
    if (groupWorkerPermits(mode, name) && ownsWorkerCapability(agent, name)) return true;
    return executionWorkerMode(mode) && executionPermitted() && externalCapabilities.get(agent)?.(name) === true;
  };
  agent.ctx.effect(() => {
    const mask = agent.ctx.tools.restrict({ allow: executionWorkerMode(initialMode)
      ? NATIVE_TOOL_NAMES.filter(name => agent.ctx.tools.get(name, agent) !== undefined) : [] });
    // rc.2 has selectable PTC presentation. rc.5 moved presentation off ToolRuntime.
    // Dispatch and nested-call isolation are enforced independently on both hosts.
    const presentation = agent.ctx.tools.presentAs?.('native');
    const allowed = (exec: ToolExecution) => exec.agent === agent && exec.parent === undefined && permits(exec.name);
    const reason = 'This task may only use its authorized Bot tools';
    const prepare = agent.ctx.on('tools/pre-execute', async (exec, next) =>
      allowed(exec) ? next() : { kind: 'deny', reason }, { prepend: true });
    const guard = agent.ctx.tools.guard(exec => allowed(exec) ? undefined : reason);
    const dispatch = agent.ctx.on('tools/execute', async (exec, next) => {
      if (!allowed(exec)) throw new OperationError('approval-denied');
      return next();
    }, { prepend: true });
    const prompt = agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next();
      return Array.isArray(result.tools) ? { ...result, tools: result.tools.filter(tool => permits(tool.name)) } : result;
    }, { prepend: true });
    executionGuards.set(agent, permits);
    protectedAgents.add(agent);
    return () => { protectedAgents.delete(agent); executionGuards.delete(agent); prompt(); dispatch(); guard(); prepare(); presentation?.(); mask(); };
  }, 'dsh-bot: group worker tool isolation');
}
