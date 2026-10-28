import { randomUUID } from 'node:crypto';
import { memorySchema } from '../src/shared/schema.js';
import { privateVersion } from '../src/host/memory/version.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
// Compile first, as registry.spec does, to exercise standard Remote decorators.
import { DshBotMemoryRemote } from '../lib/host/memory/remote.js';
import { DshBotRegistry } from '../lib/host/registry.js';
import { TYPERT } from '../lib/typert.host.js';
import type { MemoryRecord } from '../src/shared/schema.js';
import { MemoryForgetting } from '../src/host/memory/forget-service.js';

const isolatedHome = fileURLToPath(new URL('../../../.dsh-dev/', import.meta.url));

class Presets extends Service {
  private readonly entries = new Map<string, PresetDefinition>();
  constructor(ctx: Context) { super(ctx, 'agentPresets'); }
  async readDocument(agentPreset: string) {
    return { agentPreset, content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n' };
  }
  async register(definition: PresetDefinition) {
    if (this.entries.has(definition.id)) throw new Error('Duplicate preset');
    this.entries.set(definition.id, definition);
    return async () => { this.entries.delete(definition.id); };
  }
  async list() {
    return [...this.entries.values()].map(({ id, name }) => ({ id, name, isDefault: false }));
  }
}

async function facility() {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't09-memory-remote-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const restoreHome = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  };
  const ctx = new Context();
  try {
    await ctx.plugin(Storage).await();
    await ctx.plugin(storageJson, { root }).await();
    await ctx.plugin(storageDomain, { backend: 'json' }).await();
    await ctx.plugin(Presets).await();
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('Missing JSON backend');
    let unit!: KvUnit;
    const open = kv.open.bind(kv);
    const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
      const opened = await open(descriptor);
      if (descriptor.name === 'dsh_bot_memory') unit = opened;
      return opened;
    });
    const host = ctx.plugin({
      inject: ['storageDomain', 'agentPresets'],
      apply(ctx: Context) {
        new DshBotRegistry(ctx, DshBotRegistry.Config({
          seedExamples: false, memoryListLimit: 1, dataDir: join(root, 'data'),
        }));
        new DshBotMemoryRemote(ctx);
      },
    });
    await host.await();
    const registry = ctx.dshBots;
    await registry.waitUntilReady();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.create({ id: 'beta', name: 'Beta', memory: { enabled: false, injectLimit: 20 } });
    return {
      ctx, registry, remote: ctx.dshBotMemory, unit, host,
      close: async () => {
        opening.mockRestore();
        try { await ctx.fiber.dispose(); } finally { restoreHome(); await rm(root, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await ctx.fiber.dispose(); } finally { restoreHome(); await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

async function withFacility(run: (fixture: Awaited<ReturnType<typeof facility>>) => Promise<void>) {
  const fixture = await facility();
  try { await run(fixture); } finally { await fixture.close(); }
}

describe('memory Remote methods over the T06 registry queue and actual JSON domain', () => {
  it('exposes a management-only global count for orphaned quarantine rows without adding them to private reads', async () =>
    withFacility(async ({ registry, remote }) => {
      const kernel = registry.memoryKernel;
      if (!kernel) throw new Error('Missing memory kernel');
      const record = memorySchema.parse({ id: 'orphan', botId: 'deleted', content: 'SYNTHETIC_QUARANTINE',
        kind: 'note', tags: [], pinned: true, createdAt: 1, updatedAt: 1 });
      const { version, payload } = privateVersion(kernel, record, { botId: 'deleted', botCreatedAt: 0 });
      version.status = 'proposed';
      const opId = randomUUID();
      await kernel.domain.table('migration_items').put(record.id, { legacyId: record.id, memoryId: version.memoryId,
        versionId: version.versionId, opId, contentRef: version.contentRef, quarantine: true });
      await kernel.commit({ opId, kind: 'migration', subjectIds: [version.memoryId], expectedRevision: kernel.seq,
        forgetEpoch: kernel.epoch, versions: [version], payloads: { [version.contentRef]: payload } });
      expect(await remote.quarantineCount()).toBe(1);
      expect(await remote.count('alpha')).toBe(0);
      expect(await remote.list('alpha', {})).toEqual([]);
      expect(await remote.list('beta', {})).toEqual([]);
    }));

  it('lists, searches and pages within the selected Bot; persists manual provenance and updates', async () => withFacility(async ({ remote, registry }) => {
    const first = await remote.save('alpha', { content: 'Prefer short titles', kind: 'preference', tags: ['writing'] });
    const second = await remote.save('alpha', { content: 'Prefer long reports', tags: ['writing'], pinned: true });
    const third = await remote.save('alpha', { content: 'A separate fact', tags: ['reference'] });
    await remote.save('beta', { content: 'Other Bot only', pinned: true });
    // Management remains available when model memory is disabled.
    expect(await remote.count('beta')).toBe(1);
    expect(await remote.count('alpha')).toBe(3);
    const page = await remote.list('alpha', {});
    expect(page.map(({ id }) => id)).toEqual([second.id]); // configured default = 1
    const last = page[0];
    if (!last) throw new Error('Missing first page');
    const rest = await remote.list('alpha', { limit: 50, before: {
      id: last.id, pinned: last.pinned, updatedAt: last.updatedAt,
    } });
    expect(rest.map(({ id }) => id)).toEqual([third.id, first.id]);
    expect(await remote.search('alpha', { query: 'prefer', tag: 'writing', limit: 50 }))
      .toMatchObject([{ id: second.id }, { id: first.id }]);
    expect(await remote.search('beta', { query: 'Prefer', limit: 50 })).toEqual([]);
    const original = rest.find(({ id }) => id === first.id);
    expect(original?.source).toEqual({ by: 'user', at: expect.any(Number) });
    const changed = await remote.update('alpha', first.id, { pinned: true, kind: 'fact', tags: ['edited'] });
    expect(changed).toMatchObject({ id: first.id, botId: 'alpha', pinned: true, kind: 'fact', tags: ['edited'], source: original?.source });
    expect(changed.updatedAt).toBeGreaterThan(original?.updatedAt ?? 0);
    expect(await registry.memoryFor('alpha').list({ limit: 50 })).toContainEqual(changed);
    await remote.remove('alpha', second.id);
    expect(await remote.count('alpha')).toBe(2);
    await expect(remote.remove('alpha', second.id)).rejects.toMatchObject({ code: 'memory/not-found' });
  }));

  it('preserves deduplication and model provenance when a user saves an existing memory', async () => withFacility(async ({ remote, registry }) => {
    const originalSource = { by: 'model' as const, sessionId: 'session-origin', at: 1 };
    const original = await registry.memoryFor('alpha').save({ content: 'Keep concise', tags: ['model'] }, originalSource);
    expect(await remote.save('alpha', { content: '  Keep\nconcise ', pinned: true, tags: ['user'] }))
      .toEqual({ id: original.id, deduplicated: true });
    expect(await remote.list('alpha', {})).toMatchObject([
      { id: original.id, source: originalSource, pinned: true, tags: ['model', 'user'] },
    ]);
  }));

  // Writes more than one page of records to real JSON storage, so allow extra I/O time.
  it('counts all records beyond the page cap without including another Bot', async () => withFacility(async ({ remote, registry }) => {
    for (let index = 0; index < 205; index++) {
      await registry.memoryFor('alpha').save({ content: `Fact ${index}`, pinned: index % 2 === 0 });
    }
    await remote.save('beta', { content: 'Not counted' });
    expect(await remote.list('alpha', { limit: 200 })).toHaveLength(200);
    expect(await remote.count('alpha')).toBe(205);
  }), 20_000);

  it('rejects cross-Bot mutation, absent Bots and forged provenance with existing error codes', async () => withFacility(async ({ remote }) => {
    const { id } = await remote.save('alpha', { content: 'Alpha only' });
    await expect(remote.update('beta', id, { content: 'Stolen' })).rejects.toMatchObject({ code: 'memory/not-found' });
    await expect(remote.remove('beta', id)).rejects.toMatchObject({ code: 'memory/not-found' });
    await expect(remote.list('missing', {})).rejects.toMatchObject({ code: 'bot/not-found' });
    await expect(remote.count('../bad')).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(remote.save('alpha', { content: 'x'.repeat(2049) })).rejects.toMatchObject({ code: 'memory/too-large' });
    await expect(remote.save('alpha', { content: 'Forged', source: { by: 'model', at: 0 } } as never))
      .rejects.toMatchObject({ code: 'bot/invalid' });
    for (const patch of [{ source: { by: 'user', at: 0 } }, { botId: 'beta' }, { id: 'chosen' }, { updatedAt: 0 }]) {
      await expect(remote.update('alpha', id, patch as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    await expect(remote.list('alpha', { query: 'unsupported' } as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    await expect(remote.search('alpha', {} as never)).rejects.toMatchObject({ code: 'bot/invalid' });
    expect(await remote.list('alpha', {})).toMatchObject([{ id, content: 'Alpha only' }]);
  }));

  it('rejects credential signatures in manual save or edits before parsing, without echoing them', async () => withFacility(async ({ remote }) => {
    const { id } = await remote.save('alpha', { content: 'Safe content' });
    const secret = `sk-${'s'.repeat(24)}`;
    for (const input of [{ content: secret }, { content: 'Safe content', tags: [secret] }, { content: `${'x'.repeat(2050)} ${secret}` }]) {
      const error = await remote.save('alpha', input).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'memory/rejected' });
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
    for (const patch of [{ content: secret }, { tags: [secret] }]) {
      await expect(remote.update('alpha', id, patch)).rejects.toMatchObject({ code: 'memory/rejected' });
    }
    expect(await remote.count('alpha')).toBe(1);
    expect(await remote.list('alpha', {})).toMatchObject([{ id, content: 'Safe content', tags: [] }]);
  }));

  it('keeps mutations in the registry lifecycle queue and propagates storage failure', async () => withFacility(async ({ remote, registry, unit,
    host, ctx }) => {
    const originalPut = unit.putRecord.bind(unit);
    const put = vi.spyOn(unit, 'putRecord').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(remote.save('alpha', { content: 'Must fail' })).rejects.toMatchObject({ code: 'store/unavailable' });
    put.mockRestore();
    expect(await remote.count('alpha')).toBe(0);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const waiting = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      entered();
      await blocked;
      return originalPut(...args);
    });
    const saving = remote.save('alpha', { content: 'Accepted before unload' });
    await started;
    const queued = remote.list('alpha', {});
    let stopped = false;
    const stopping = host.dispose().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    const { id } = await saving;
    expect(await queued).toMatchObject([{ id, content: 'Accepted before unload' }]);
    await stopping;
    waiting.mockRestore();
    expect(ctx.get('dshBotMemory')).toBeUndefined();
    expect(ctx.get('dshBots')).toBeUndefined();
    expect(() => registry.memoryFor('alpha')).toThrow();
  }));

  it('publishes decorator names and strict codecs for all actual Host methods', async () => withFacility(async ({ remote, registry, ctx }) => {
    expect(remote.typertRemote.namespace).toBe('dshBot.memory');
    registry.memoryForget = new MemoryForgetting(ctx, registry);
    const target = await registry.memoryFor('alpha').save({ content: 'Synthetic forget target' });
    const cases: Record<string, unknown[]> = {
      list: ['alpha', {}], search: ['alpha', { query: 'absent' }],
      save: ['alpha', { content: 'Codec result' }], count: ['alpha'], quarantineCount: [],
      previewForget: ['alpha', { memoryId: target.id, mode: 'version' }], cleanupStatuses: [], rootInstructions: [],
    };
    let managedId = '', publishedId = '';
    let saved: MemoryRecord | undefined;
    for (const descriptor of TYPERT.invocations.filter(({ namespace }) => namespace === 'dshBot.memory')) {
      if (descriptor.result.mode !== 'strict') throw new Error('Expected strict result');
      const method = descriptor.implementation ?? descriptor.method;
      const kernel = registry.memoryKernel; if (!kernel) throw new Error('Missing kernel');
      Object.assign(cases, {
        query: [{ botId: 'alpha', scope: 'shared', view: 'all' }],
        createManaged: [{ botId: 'alpha', scope: 'shared', kind: 'user_fact', content: 'MANAGED', subject: 'user',
          factKey: 'preference', valid: { from: 1, to: null, basis: 'explicit' }, expectedRevision: kernel.seq }],
        revise: [{ id: managedId, expectedRevision: kernel.seq, patch: { content: 'MANAGED_EDIT' } }],
        confirm: [{ id: target.id, botId: 'alpha', scope: 'shared', expectedRevision: kernel.seq }],
        resolve: [{ ids: [managedId], selected: managedId, choice: 'select', expectedRevision: kernel.seq }],
        previewContribution: [publishedId], previewShared: [{ memoryId: publishedId, mode: 'related' }],
      });
      const args = descriptor.method === 'update' ? ['alpha', saved?.id, { pinned: true }]
        : descriptor.method === 'delete' ? ['alpha', saved?.id] : cases[descriptor.method];
      if (!args) throw new Error(`Missing case for ${method}`);
      const result = await Reflect.apply(Reflect.get(remote, method), remote, args);
      expect(descriptor.result.create().parse(result)).toEqual(result);
      if (descriptor.method === 'createManaged') managedId = result as string;
      if (descriptor.method === 'confirm') publishedId = result as string;
      if (descriptor.method === 'previewForget') cases.chooseForget = [{
        previewRevision: (result as { previewRevision: string }).previewRevision, choice: 'stop',
      }];
      if (descriptor.method === 'chooseForget') cases.retryCleanup = [(result as { id: string }).id];
      if (descriptor.method === 'save') saved = (await remote.list('alpha', {}))[0];
    }
  }));
});
