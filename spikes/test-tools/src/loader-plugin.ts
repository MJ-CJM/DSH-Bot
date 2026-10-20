import type { Context } from '@deepseek-ai/cordis';

export function apply(ctx: Context): void {
  ctx.effect(() => {
    console.log('T02_LOADER_PLUGIN_LOADED');
    return () => { console.log('T02_LOADER_PLUGIN_DISPOSED'); };
  });
}
