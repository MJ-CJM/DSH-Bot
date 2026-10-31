import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Config as HostConfig } from './host/registry-config.js';

// Deliberately no static local runtime imports: link failures must reach this boundary.
export const VERSION = '0.6.3';
export const name = 'dsh-bot';
const restart = 'DSH-Bot 模块版本不一致或加载失败。请完全退出并重新打开 DSH。 '
  + 'DSH-Bot modules are stale or could not load. Fully quit and reopen DSH.';
function verifyInstallation() {
  const manifest = JSON.parse(readFileSync(new URL('./module-manifest.json', import.meta.url), 'utf8')) as {
    version: string; files: Record<string, string>;
  };
  if (manifest.version !== VERSION) throw new Error('Mixed installation');
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!/^(?:host|shared)\/[\w./-]+\.js$|^typert[\w.-]*\.js$/.test(path) || path.split('/').includes('..'))
      throw new Error('Invalid module manifest');
    const bytes = readFileSync(new URL(`./${path}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Incomplete installation');
  }
  return manifest;
}
let runtime: typeof import('./host/index.js') | undefined;
try {
  const manifest = verifyInstallation();
  // Old releases load this exact URL. A retained namespace is the cache witness.
  const schema = await import('./shared/schema.js');
  if (!('DSH_BOT_MODULE_VERSION' in schema) || schema.DSH_BOT_MODULE_VERSION !== VERSION)
    throw new Error('Cached legacy schema');
  // Stable URLs retain public class/service identity. Verify all loaded namespaces before apply.
  for (const path of Object.keys(manifest.files)) {
    const url = new URL(`./${path}`, import.meta.url).href;
    const module = await import(/* @vite-ignore */ url);
    if (module.DSH_BOT_MODULE_VERSION !== VERSION) throw new Error('Cached module from another release');
  }
  const runtimeUrl = new URL('./host/index.js', import.meta.url).href;
  runtime = await import(/* @vite-ignore */ runtimeUrl);
} catch {
  // No registry apply, storage open or migrations have run. Never expose raw linker diagnostics.
}
export const inject = runtime?.inject ?? [];
export type Config = HostConfig;
export const Config: typeof import('./host/index.js').Config = runtime?.Config
  ?? Schema.transform(Schema.any(), () => { throw new Error(restart); });
export type DshBotRegistry = import('./host/index.js').DshBotRegistry;
export const DshBotRegistry = runtime?.DshBotRegistry;
export function apply(ctx: Context, config: HostConfig): void {
  // Even an already cached bootstrap must refuse a subsequently replaced installation.
  try { verifyInstallation(); } catch { throw new Error(restart); }
  if (!runtime) throw new Error(restart);
  runtime.apply(ctx, config);
}
