import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { BotKey } from '../../shared/identity.js';
import type { DshBotRegistry } from '../registry.js';
import type { ManagedOutlets } from './outlets.js';
import { unknownLabel } from './labels.js';

export function connectorDestination(agent: Agent, name: string) {
  const service = agent.ctx.get('dshBotConnectors'); if (!service) return;
  for (const status of service.runtime().filter(r => r.sessionId === agent.session.id && r.state === 'ready')) {
    const assignment = service.assignments().find(a => a.id === status.assignmentId);
    const definition = assignment && service.definitions().find(d => d.id === assignment.connectorId);
    if (assignment?.enabled && definition?.enabled && name.startsWith(`mcp__${definition.serverName}__`))
      return JSON.stringify([definition.id, definition.revision, assignment.id, assignment.desiredRevision,
        definition.transport, definition.url ?? definition.command, name]);
  }
}
export async function connectorDispatch(agent: Agent, bot: BotKey, registry: DshBotRegistry, flow: ManagedOutlets,
  exec: ToolExecution, next: () => Promise<ToolExecutionResult>) {
  const destination = connectorDestination(agent, exec.name);
  if (!destination) throw new Error('Connector unavailable or changed');
  const envelope = flow.draft('connector', bot, agent.session.id, String(exec.callId),
    { kind: 'external', destination }, JSON.stringify({ name: exec.name, arguments: exec.arguments }));
  const grant = await flow.request(agent, envelope, exec.signal), id = await flow.admit(envelope, grant, exec.signal);
  // Configuration may change while the human answers. Compare the effective endpoint/assignment again.
  if (connectorDestination(agent, exec.name) !== destination) throw new Error('Connector destination changed');
  const value = await flow.dispatch(id, () => {
    if (connectorDestination(agent, exec.name) !== destination) throw new Error('Connector destination changed');
    return next();
  }, exec.signal);
  await flow.inherit(agent.session.id, unknownLabel());
  registry.memoryAdmission.assertAllowed(); return value;
}
