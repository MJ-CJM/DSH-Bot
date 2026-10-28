import type { Agent } from '@deepseek-ai/dsh-agent';
import { replacementMemoryTool } from '../../shared/memory-tool-names.js';

/** A native guard explains stale calls without registering aliases or intercepting another plugin's tool. */
export function retiredMemoryGuidance(agent: Agent) {
  return agent.ctx.tools.guard(exec => {
    const replacement = replacementMemoryTool(exec.name);
    if (replacement && !agent.ctx.tools.get(exec.name, agent))
      return `DSH-Bot renamed this tool to ${replacement}. Refresh tool definitions; old names have no DSH-Bot alias.`;
  });
}
