import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-config-editor';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { randomUUID } from 'node:crypto';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { proactiveSetupRequest, type ProactiveSetupRequest, type ProactiveSetupReply } from '../../shared/proactive/setup.js';
import { proactiveBootstrapToken, type ProactiveBootstrapToken, type ProactiveConfig } from './config.js';

const bindingSchema = z.strictObject({ installationId: z.uuid(), storeId: z.uuid().nullable() });
const bindingDomain = defineDomain({
  name: 'dsh_bot_proactive',
  version: 1,
  tables: { identity: domainTable(bindingSchema) },
});

export async function withProactiveBinding<T>(
  ctx: Context,
  use: (binding: z.output<typeof bindingSchema>, saveStore: (storeId: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const domain = await ctx.storageDomain.open(bindingDomain);
  try {
    const table = domain.table('identity');
    const previous = table.get('binding');
    const binding = previous ?? { installationId: randomUUID(), storeId: null };
    if (!previous) await table.put('binding', binding);
    return await use(binding, storeId => table.put('binding', { installationId: binding.installationId, storeId }));
  } finally {
    await domain.close();
  }
}

function editorEntry(ctx: Context) {
  const loader = ctx.get('loader'), editor = ctx.get('configEditor');
  const id = loader?.locate(ctx.fiber);
  if (!loader || !editor || !id) return;
  const entry = loader.resolve(id);
  if (entry.options.name === 'dsh-bot' && editor.entries().includes(entry)) return { editor, entry };
}

export async function persistScopedBootstrap(ctx: Context, token: ProactiveBootstrapToken, stillCurrent: () => boolean): Promise<ProactiveSetupReply> {
  const target = editorEntry(ctx);
  if (!target) return 'unavailable';
  const conflict = new Error('Settings changed during scoped setup');
  try {
    await target.editor.edit(target.entry, raw => {
      const previous = proactiveBootstrapToken.nullish().parse(raw.proactiveFollowUpBootstrap);
      if (!stillCurrent() || raw.proactiveEnabled === true ||
        (previous?.operation.configEpoch ?? null) !== token.previousConfigEpoch ||
        previous?.operation.operationId === token.operation.operationId) throw conflict;
      return { ...raw, proactiveEnabled: true, proactiveExecutionEnabled: false, proactiveFollowUpBootstrap: token };
    });
  } catch (error) {
    if (error === conflict) return 'conflict';
    throw error;
  }
  return 'updated';
}

/** Persist in the active profile override through the native ConfigEditor, not Loader's composed file. */
export async function setupProactive(
  ctx: Context, current: ProactiveConfig, request: ProactiveSetupRequest, stillCurrent = () => true,
): Promise<ProactiveSetupReply> {
  const input = proactiveSetupRequest.parse(request);
  if (input.action === 'enable-suggestions') return current.proactiveEnabled ? 'unchanged' : 'conflict';
  const target = editorEntry(ctx);
  if (!target) return 'unavailable';
  if (!current.proactiveEnabled || current.proactiveFollowUpBootstrap) return 'conflict';
  const existing = current.proactiveCiFeed;
  if (existing) return existing.scope.repository === input.repository && existing.scope.branch === input.branch && existing.github?.credentialRef === input.credentialRef ? 'unchanged' : 'conflict';
  const info = await ctx.get('credentials')?.describe(credentialRef(input.credentialRef));
  if (!info?.configured) return 'credential-missing';
  const conflict = new Error('Settings changed during setup');
  try {
    await target.editor.edit(target.entry, raw => {
      if (!stillCurrent() || raw.proactiveEnabled !== true || raw.proactiveCiFeed || raw.proactiveFollowUpBootstrap) throw conflict;
      return { ...raw, proactiveCiFeed: {
        scope: { repository: input.repository, branch: input.branch, generation: 1 },
        github: { credentialRef: input.credentialRef, since: new Date().toISOString(), maxRuns: 256, timeoutMs: 15000 },
        intervalMs: 60000,
      } };
    });
  } catch (error) { if (error === conflict) return 'conflict'; throw error; }
  return 'updated';
}
