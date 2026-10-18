/** Compile-checked T04 templates. Split into Host and Client entry points in the product. */
import type { Context } from '@deepseek-ai/cordis';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import type {} from '@deepseek-ai/dsh-api-gateway/client';
import { DshBots } from 'dsh-bot-spike-remote';
import { TYPERT } from 'dsh-bot-spike-remote/typert';
import contribution from 'dsh-bot-spike-remote/remote';

export const host = {
  name: 'dsh-bot-host-template', inject: ['typert'],
  apply(ctx: Context): void {
    new DshBots(ctx);
    const descriptor: TypertContribution = TYPERT;
    ctx.effect(() => ctx.typert.register(descriptor));
  },
};
export const clientAssembly = {
  name: 'dsh-bot-client-assembly-template', inject: ['remote'],
  async apply(ctx: Context): Promise<void> {
    await ctx.effect(async () => await ctx.remote.$mount(contribution));
  },
};
// A separate consumer may inject ['remote', 'remote.dshBot']; the mounting
// assembly itself must not wait for the namespace it is about to install.
