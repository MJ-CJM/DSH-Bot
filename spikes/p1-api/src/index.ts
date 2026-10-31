import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-cordis-host-runner';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { DshBots } from 'dsh-bot-spike-remote';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPresetProbe } from './presets.js';
import { runScopeProbe } from './bot-context.js';
import { runStorageProbe } from './storage.js';

export const name = 'dsh-bot-p1-api-spike';
export const inject = ['agentPresets', 'sessionController', 'sessions', 'storageDomain', 'typert', 'loader', 'tools', 'systemPrompt', 'agents'];

export interface Config {
  phase: 'bare' | 'prepare' | 'resume';
  outputDir: string;
  cwd: string;
}
export const Config: Schema<Config> = Schema.object({
  phase: Schema.union(['bare', 'prepare', 'resume']).default('prepare'),
  outputDir: Schema.string().default('.dsh-dev/t02'),
  cwd: Schema.string().default('.'),
});

export function apply(ctx: Context, config: Config): void {
  new DshBots(ctx);
  const directory = resolve(config.outputDir);
  mkdirSync(directory, { recursive: true });
  const emit = (event: string, detail: unknown) => {
    const line = JSON.stringify({ event, detail });
    appendFileSync(join(directory, `${config.phase}.jsonl`), `${line}\n`);
    console.log(`P1_SPIKE ${line}`);
  };
  emit('host.activated', { phase: config.phase, pid: process.pid });
  ctx.effect(() => {
    let active = true;
    let settled = false;
    const task = (async () => {
      await ctx.loader.await();
      settled = true;
      if (!active) return;
      emit('remote.host-before-registration', { descriptor: ctx.typert.local.get('dshBot/list') ?? null });
      if (config.phase !== 'bare') {
        const { TYPERT } = await import('dsh-bot-spike-remote/typert');
        if (!active) return;
        ctx.effect(() => ctx.typert.register(TYPERT as TypertContribution), 't02:remote-host');
        emit('remote.host-registered', { package: 'dsh-bot-spike-remote', resultCodec: ctx.typert.local.get('dshBot/list')?.result.mode });
        emit('storage', await runStorageProbe(ctx, { dshHome: process.env.DSH_HOME ?? '' }));
        if (!active) return;
        await runPresetProbe(ctx, {
          phase: config.phase,
          cwd: resolve(config.cwd),
          statePath: join(directory, 'restart-state.json'),
          emit,
          appendRows: [{ id: 'bot-context', name: 'dsh-bot-p1-spike/bot-context', config: { botId: 'alpha' } }],
        });
        if (!active) return;
        if (config.phase === 'prepare') {
          emit('scope', await runScopeProbe(ctx, { cwd: resolve(config.cwd), pluginName: 'dsh-bot-p1-spike/bot-context' }));
        }
      }
      emit('host.done', { phase: config.phase });
    })().catch((error: unknown) => emit('host.fatal', { message: error instanceof Error ? error.message : String(error) }));
    return async () => {
      active = false;
      // Never await the Loader from its own pre-settlement teardown.
      if (settled) await task;
    };
  }, 't02:probe-lifetime');
}
