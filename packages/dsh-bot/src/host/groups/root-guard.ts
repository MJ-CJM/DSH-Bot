import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import { GROUP_ROOT_PRESET } from '../../shared/groups.js';
export const name = 'dsh-bot-group-root-guard';
/** Retained preset generation owns the listener, even for a Controller-owned root. */
export function apply(ctx: Context) {
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.agentPreset === GROUP_ROOT_PRESET) return { kind: 'reject' as const };
    return next();
  }), 'dsh-bot: group root no-model guard');
}
