import type { Context } from '@deepseek-ai/cordis';
export const name = 'p34-root-guard';
/** Scoped to the retained root preset generation, including Controller-owned roots. */
export function apply(ctx: Context) {
  ctx.on('agent/pre-step', async () => ({ kind: 'reject' }));
}
