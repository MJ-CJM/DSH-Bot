import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AUTOMATION_REMOTE, automationRemoteSpec, type AutomationHostMethods, type AutomationRemoteMethods } from '../lib/shared/automation-contract.js';
import { registerAutomationRemote, AUTOMATION_HOST, type RoutineRemote, type RunRemote } from '../lib/host/automation/remote.js';
import { openAutomationStores } from '../lib/host/automation/store.js';
import { AutomationError } from '../lib/host/automation/errors.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import P1_REMOTE from '../src/typert.remote-client.js';

const createInput = { botId: 'alpha', title: 'Routine', prompt: 'Task', rule: { kind: 'every' as const, everySeconds: 60 }, timeZone: 'UTC' };
describe('automation Remote contract', () => {
  it('keeps seven strict endpoints separate from P1 and denies client-supplied identities/reservations', () => {
    expect(AUTOMATION_HOST.invocations).toBe(AUTOMATION_REMOTE.descriptors);
    expect(AUTOMATION_REMOTE.descriptors).toHaveLength(7);
    expect(P1_REMOTE.descriptors).toHaveLength(19);
    const parse = (endpoint: string, input: unknown) => AUTOMATION_REMOTE.methods[endpoint]?.input({ strict: true }).create().parse(input);
    expect(parse('dshBot.routine/create', { input: createInput })).toMatchObject({ input: { enabled: true, misfirePolicy: 'latest' } });
    for (const field of [{ id: 'chosen' }, { createdBy: { kind: 'model' } }, { botCreatedAt: 7 }, { revision: 2 }, { workspacePolicy: 'elsewhere' }]) {
      expect(() => parse('dshBot.routine/create', { input: { ...createInput, ...field } })).toThrow();
    }
    expect(() => parse('dshBot.routine/list', { options: { ownerId: 'fake' } })).toThrow();
    expect(() => parse('dshBot.run/list', { options: { limit: 201 } })).toThrow();
    expect(() => parse('dshBot.routine/get', { id: '../escape' })).toThrow();
    expect(() => parse('dshBot.routine/delete', { id: 'f5db4554-9c3c-4da6-a42a-2c9ffd220ed3' })).toThrow();
    expect(Object.keys(automationRemoteSpec.methods).some((k) => /reserve|transition|enqueue|report/.test(k))).toBe(false);
    expect(remoteErrorOf(new AutomationError('automation/conflict', 'Conflict'))).toMatchObject({ code: 'automation/conflict', details: {} });
    expectTypeOf<RoutineRemote['create']>().toEqualTypeOf<AutomationHostMethods<'dshBot.routine'>['create']>();
    expectTypeOf<RoutineRemote['update']>().toEqualTypeOf<AutomationHostMethods<'dshBot.routine'>['update']>();
    expectTypeOf<RunRemote['get']>().toEqualTypeOf<AutomationHostMethods<'dshBot.run'>['get']>();
  });

  it('mounts real Cordis services/Gateway, round-trips CRUD and rejects bad Host/Client result values', async () => {
    const home = fileURLToPath(new URL('../../../.dsh-dev/p2/t12/', import.meta.url));
    await mkdir(home, { recursive: true }); const root = await mkdtemp(join(home, 'remote-'));
    const host = new Context(); const client = new Context(); let corrupt = false;
    try {
      await host.plugin(Storage).await(); await host.plugin(storageJson, { root }).await();
      await host.plugin(storageDomain, { backend: 'json' }).await(); new TypertRegistry(host);
      const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 1, updatedAt: 1, schemaVersion: 1 });
      const stores = await openAutomationStores(host, { assertOwner() {}, ownerId: 'contract-test', config: { quotaTimeZone: 'UTC' },
        now: () => 1792497600000, resolveBot: () => ({ bot, presetId: 'actual-preset' }) });
      const scope = host.plugin({ inject: ['typert'], apply(ctx: Context) { registerAutomationRemote(ctx, stores); } });
      await scope.await();
      new TypertRegistry(client);
      // Only HTTP carrier/dispatch is in-process; published namespace mounting,
      // Connection parsing, strict codecs, service lifecycle and stores are real.
      installConnection(client, { interactions: 'none', transport: { async fetch(_url, init) {
        const envelope = JSON.parse(String(init.body));
        const endpoint = envelope.method;
        const descriptor = AUTOMATION_REMOTE.descriptors.find((d) => `${d.namespace}/${d.method}` === endpoint);
        if (!descriptor) throw new Error(`Unknown endpoint: ${JSON.stringify(envelope)}`);
        const method = AUTOMATION_REMOTE.methods[endpoint];
        if (!method) throw new Error('Missing method');
        const args = method.input({ strict: true }).create().parse(envelope.payload.args) as { [key: string]: unknown };
        const service = host.get(descriptor.service) as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
        const implementation = service[descriptor.implementation ?? descriptor.method];
        if (!implementation) throw new Error('Missing implementation');
        let value = await implementation.apply(service, descriptor.parameters.map((p) => args[p.name]));
        if (descriptor.result.mode !== 'strict' || !descriptor.result.encode) throw new Error('Missing strict result');
        value = descriptor.result.encode(value, () => null);
        if (corrupt && Array.isArray(value)) value = [{ ...(value[0] as object), internalUnexpected: true }];
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } });
      } } });
      await client.plugin(Gateway).await();
      const unmount = await client.effect(() => client.remote.$mount(AUTOMATION_REMOTE));
      const routine = client.get('remote.dshBot.routine') as unknown as AutomationRemoteMethods<'dshBot.routine'>;
      const runs = client.get('remote.dshBot.run') as unknown as AutomationRemoteMethods<'dshBot.run'>;
      expect(routine).toBeDefined();
      const created = await routine.create(createInput);
      if (!created.ok) throw new Error('Create failed');
      const row = created.value;
      expect(await routine.get(row.id)).toMatchObject({ ok: true, value: row });
      const changed = await routine.update(row.id, { enabled: false }, row.revision);
      if (!changed.ok) throw new Error('Update failed');
      expect(await routine.list({})).toMatchObject({ ok: true, value: [changed.value] });
      expect(await runs.list({})).toEqual({ ok: true, value: [] });
      for (const descriptor of AUTOMATION_REMOTE.descriptors.filter((d) => d.namespace === 'dshBot.routine')) {
        const result = descriptor.result;
        if (result.mode !== 'strict' || !result.encode || !result.decode) throw new Error('Missing strict codec');
        const valid = descriptor.method === 'list' ? [row] : row;
        const invalid = descriptor.method === 'list' ? [{ ...row, unknown: true }] : { ...row, unknown: true };
        expect(result.decode(result.encode(valid, () => null))).toEqual(valid);
        expect(() => result.encode?.(invalid, () => null)).toThrow();
        expect(() => result.decode?.(invalid)).toThrow();
      }
      corrupt = true;
      expect(await routine.list({})).toMatchObject({ ok: false, error: { code: 'gateway/internal' } }); corrupt = false;
      expect(await routine.delete(row.id, changed.value.revision)).toMatchObject({ ok: true, value: { deletedAt: 1792497600000 } });
      expect(await routine.list({})).toEqual({ ok: true, value: [] });
      await unmount(); expect(client.get('remote.dshBot.routine')).toBeUndefined();
      await scope.dispose(); expect(host.get('dshBotRoutines')).toBeUndefined();
    } finally { await client.fiber.dispose(); await host.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
