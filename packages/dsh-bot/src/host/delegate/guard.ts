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
    throw new HarnessError('Background sessions cannot delegate', 'automation/depth');
  }
  // A report may cause multiple steps, tools and further notices. Only a new
  // ordinary user input clears this barrier, not an assistant or tool message.
  // Native assembly appends ambient context as user-role messages after input.
  // They neither authorize delegation nor clear an earlier notice barrier.
  const ambient = new Set(['agent-instructions', 'runtime-context', 'time-context', 'tmux-context']);
  const input = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && !ambient.has(event.data.source.kind));
  if (input?.type === 'user/message' && input.data.source.kind !== 'user') {
    throw new HarnessError('Background notices cannot start another delegation chain', 'automation/depth');
  }
}

/** Gate the explicit delegation entry. Native scheduling owns its own rules. */
export function registerAutomationGuard(ctx: Context, runs: RunService): void {
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'bot_delegate') {
      if (!exec.agent) throw new HarnessError('Automation tools require an owning agent', 'automation/invalid');
      assertInteractiveOrigin(exec.agent, runs);
    }
    return next();
  }, { prepend: true }), 'dsh-bot: automation recursion guard');
}
