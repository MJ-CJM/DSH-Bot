import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { RunService } from '../automation/store.js';

/** Use durable Host provenance, never model arguments or prompt text. */
export function assertInteractiveOrigin(agent: Agent, runs: RunService): void {
  const header = agent.session.header;
  // Children/forks cannot shed the parent's automation provenance by changing preset.
  if (header.parentSession || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
    || runs.forSession(agent.session.id)) {
    throw new HarnessError('Background sessions cannot delegate or modify Routines', 'automation/depth');
  }
  // A report may cause multiple steps, tools and further notices. Only a new
  // ordinary user input clears this barrier, not an assistant or tool message.
  const input = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && (event.data.source.kind === 'user' || event.data.source.kind === 'dsh-bot-delegate'));
  if (input?.type === 'user/message' && input.data.source.kind === 'dsh-bot-delegate') {
    throw new HarnessError('Delegate reports cannot start another automation chain', 'automation/depth');
  }
}

/** Also gates future Routine tools, including definitions added after this hook. */
export function registerAutomationGuard(ctx: Context, runs: RunService): void {
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bot_delegate' || (exec.name.startsWith('routine_') && !['routine_list', 'routine_get'].includes(exec.name))) {
      if (!exec.agent) throw new HarnessError('Automation tools require an owning agent', 'automation/invalid');
      assertInteractiveOrigin(exec.agent, runs);
    }
    return next();
  }, { prepend: true }), 'dsh-bot: automation recursion guard');
}
