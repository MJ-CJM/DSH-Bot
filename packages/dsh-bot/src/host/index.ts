import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-bot';

export function apply(ctx: Context) {
  ctx.effect(() => {
    ctx.logger?.info?.('[dsh-bot] loaded');
    return () => {
      ctx.logger?.info?.('[dsh-bot] unloaded');
    };
  });
}
