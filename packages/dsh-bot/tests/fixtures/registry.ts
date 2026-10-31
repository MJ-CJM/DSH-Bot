import { required } from './required.js';
import { mkdir, mkdtemp, rm, } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import Storage from '@deepseek-ai/dsh-storage';
import type { KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { vi } from 'vitest';
// Like bundle.spec, run against the current build produced by pnpm check.
// This also exercises TypeScript's lowering of the standard Remote decorators.
import { type Config, DshBotRegistry } from '../../lib/host/registry.js';
import type { botDomain, } from '../../lib/host/store.js';

import { V2MemoryStore } from '../../lib/host/memory/store-v2.js';
import { BotStore } from '../../lib/host/stores/bots.js';

const isolatedHome = fileURLToPath(new URL('../../../../.dsh-dev/', import.meta.url));

/** The double deliberately implements duplicate-id and broken-roster semantics. */
class PresetDouble extends Service {
  readonly calls: string[] = [];
  readonly current = new Map<string, PresetDefinition>();
  readonly brokenNames = new Set<string>();
  readonly throwNames = new Set<string>();
  beforeRegister?: (definition: PresetDefinition) => Promise<void>;
  beforeUnregister?: (definition: PresetDefinition) => Promise<void>;

  constructor(ctx: Context) { super(ctx, 'agentPresets'); }

  async readDocument(agentPreset: string) {
    return { agentPreset, content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n' };
  }

  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    this.calls.push(`register:${definition.id}:${definition.name}`);
    if (this.current.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
    await this.beforeRegister?.(definition);
    if (this.throwNames.has(definition.name ?? '')) throw new Error(`Registration rejected: ${definition.name}`);
    this.current.set(definition.id, structuredClone(definition));
    let disposed = false;
    return async () => {
      if (disposed) return;
      this.calls.push(`unregister:${definition.id}:${definition.name}`);
      await this.beforeUnregister?.(definition);
      disposed = true;
      this.current.delete(definition.id);
    };
  }

  async list() {
    return [...this.current.values()].map(({ id, name, description }) => ({
      id, name, description, isDefault: false,
      ...(this.brokenNames.has(name ?? '') ? { broken: `Activation rejected: ${name}` } : {}),
    }));
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function facility() {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't04-registry-'));
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
    await ctx.plugin(PresetDouble).await();
    const presets = ctx.agentPresets as unknown as PresetDouble;
    const kv = ctx.storage.backend.get('json').kv;
    if (!kv) throw new Error('JSON backend has no KV facet');
    const units = new Map<string, KvUnit>();
    const open = kv.open.bind(kv);
    const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
      const unit = await open(descriptor);
      units.set(descriptor.name, unit);
      return unit;
    });
    const start = async (options: Partial<Config> = {}) => {
      const previousHome = process.env.DSH_HOME;
      process.env.DSH_HOME = root;
      const fork = ctx.plugin(DshBotRegistry, {
        seedExamples: false, presetIdPrefix: 'bot-', presetOrder: 50, dataDir: join(root, 'data'), ...options,
      });
      try { await fork.await(); }
      finally {
        if (previousHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = previousHome;
      }
      const registry = ctx.dshBots;
      await registry.list();
      return { registry, stop: () => fork.dispose() };
    };
    return {
      ctx, root, presets, start,
      workspaces: async () => {
        const headers: { id: ReturnType<typeof SessionId>; cwd: string; createdAt: number }[] = [];
        ctx.provide('sessionPersistence', { list: async () => headers.map((header) => ({ header })) } as unknown as Context['sessionPersistence']);
        await ctx.plugin(WorkspaceRegistry).await();
        return { registry: ctx.workspaceRegistry, headers };
      },
      unit: (name = 'dsh_bot') => {
        const unit = units.get(name);
        if (!unit) throw new Error('Bot domain has not been opened');
        return unit;
      },
      retainedMemories: (botId: string) => [...required(ctx.dshBots.memoryKernel).snapshot.versions.values()]
        .filter(v => v.scope === 'private' && v.ownerBotKey.botId === botId).map(v => {
          const payload = required(required(ctx.dshBots.memoryKernel).domain.table('payloads').get(v.contentRef));
          return { ...required(payload.legacy), id: v.memoryId, content: payload.content };
        }),
      memories: () => {
        const domain = ctx.storageDomain.get('dsh_bot');
        if (!domain) throw new Error('Bot domain has not been opened');
        return new V2MemoryStore(required(ctx.dshBots.memoryKernel) as unknown as ConstructorParameters<typeof V2MemoryStore>[0],
          new BotStore(domain as unknown as Domain<typeof botDomain>));
      },
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

type Fixture = Awaited<ReturnType<typeof facility>>;
export async function withFacility(run: (fixture: Fixture) => Promise<void>) {
  const fixture = await facility();
  try { await run(fixture); } finally { await fixture.close(); }
}

