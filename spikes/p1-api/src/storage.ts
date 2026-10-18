import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const recordSchema = z.object({ botId: z.string(), value: z.number().int(), marker: z.literal('p1-api-spike') });

export const spikeDomain = defineDomain({
  name: 'dsh_bot',
  version: 1,
  tables: { probes: domainTable(recordSchema) },
});

export interface StorageProbeOptions {
  dshHome: string;
}

function errorInfo(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, code: 'code' in error ? error.code : null }
    : { name: typeof error, message: String(error), code: null };
}

/** Exercise the real configured storageDomain; only this spike's table is touched. */
export async function runStorageProbe(ctx: Context, options: StorageProbeOptions) {
  let requestedDomainNameError: ReturnType<typeof errorInfo> | null = null;
  try {
    defineDomain({ ...spikeDomain, name: 'dsh-bot' });
  } catch (error) {
    requestedDomainNameError = errorInfo(error);
  }
  const changes: Array<{ operation: string; key: string }> = [];
  const off = ctx.effect(() => ctx.on('domain/changed', (change) => {
    if (change.domain === spikeDomain.name) changes.push({ operation: change.operation, key: change.key });
  }));
  const openDomain = () => ctx.storageDomain.open(spikeDomain);
  const openOwned = async () => {
    let domain!: Awaited<ReturnType<typeof openDomain>>;
    const close = ctx.effect(async () => {
      domain = await openDomain();
      return () => domain.close();
    });
    await close;
    return { domain, close };
  };
  const { domain, close } = await openOwned();
  const table = domain.table('probes');
  const before = table.get('restart-marker');
  const nextValue = (before?.value ?? 0) + 1;
  let duplicateOpen: ReturnType<typeof errorInfo> | null = null;
  try {
    await openOwned();
  } catch (error) {
    duplicateOpen = errorInfo(error);
  }
  await table.put('restart-marker', { botId: 'alpha', value: nextValue, marker: 'p1-api-spike' });
  await table.put('concurrent-updates', { botId: 'alpha', value: 0, marker: 'p1-api-spike' });
  await Promise.all([
    table.update('concurrent-updates', (record) => ({ ...record, value: record.value + 1 })),
    table.update('concurrent-updates', (record) => ({ ...record, value: record.value + 1 })),
  ]);
  const concurrentValue = table.get('concurrent-updates')?.value;

  // The source only validates records on open. Confirm this surprising API
  // boundary without leaving malformed data behind for the next Host start.
  let invalidPutAccepted = false;
  try {
    await table.put('validation-boundary', { botId: 'alpha', value: 'invalid', marker: 'p1-api-spike' } as never);
    invalidPutAccepted = !recordSchema.safeParse(table.get('validation-boundary')).success;
  } finally {
    await table.delete('validation-boundary');
  }
  const expectedPath = join(options.dshHome, 'storages', 'dsh_bot.json');
  const persisted: unknown = JSON.parse(await readFile(expectedPath, 'utf8'));
  const persistedText = JSON.stringify(persisted);
  await close();
  let closedRead: ReturnType<typeof errorInfo> | null = null;
  try { table.get('restart-marker'); } catch (error) { closedRead = errorInfo(error); }
  const { domain: reopened, close: closeReopened } = await openOwned();
  const afterReopen = reopened.table('probes').get('restart-marker');
  await closeReopened();
  await off();
  const pass = requestedDomainNameError !== null
    && duplicateOpen?.code === 'already-open' && closedRead?.code === 'closed'
    && concurrentValue === 2 && afterReopen?.value === nextValue
    && persistedText.includes('restart-marker') && !persistedText.includes('validation-boundary');
  const result = {
    pass, requestedDomainName: 'dsh-bot', requestedDomainNameAccepted: requestedDomainNameError === null,
    requestedDomainNameError, domain: spikeDomain.name, version: spikeDomain.version, expectedPath,
    previousProcessMarker: before ?? null, writtenValue: nextValue, afterReopen,
    concurrentValue, duplicateOpen, closedRead, invalidPutAccepted, changes,
    desktopRuntime: 'NOT_RUN',
  };
  ctx.logger.info(`P1_STORAGE_RESULT ${JSON.stringify(result)}`);
  return result;
}
