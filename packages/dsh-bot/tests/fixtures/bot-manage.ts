import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import Storage, { type KvUnit } from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { expect, vi } from 'vitest';
import { DshBotRegistry } from '../../lib/host/registry.js';
import { BOT_MANAGE_TOOL_NAME, registerBotManageTool, } from '../../lib/host/tools/bot-manage.js';

export const isolatedHome = fileURLToPath(new URL('../../../../.dsh-dev/', import.meta.url));

/** Only preset loading is doubled; duplicate ids and activation errors stay observable. */
class PresetDouble extends Service {
  readonly calls: string[] = [];
  readonly current = new Map<string, PresetDefinition>();
  readonly composed = new Map<Context, string>();
  readonly throwNames = new Set<string>();

  constructor(ctx: Context) { super(ctx, 'agentPresets'); }

  async readDocument(agentPreset: string) {
    return { agentPreset, content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n' };
  }

  async register(definition: PresetDefinition) {
    this.calls.push(`register:${definition.id}:${definition.name}`);
    if (this.current.has(definition.id)) throw new Error(`Duplicate preset: ${definition.id}`);
    if (this.throwNames.has(definition.name ?? '')) throw new Error(`Rejected preset: ${definition.name}`);
    this.current.set(definition.id, structuredClone(definition));
    let disposed = false;
    return async () => {
      if (disposed) return;
      disposed = true;
      this.calls.push(`unregister:${definition.id}:${definition.name}`);
      this.current.delete(definition.id);
    };
  }

  async list() {
    return [...this.current.values()].map(({ id, name, description }) => ({ id, name, description, isDefault: false }));
  }

  composedPreset(ctx: Context) { return this.composed.get(ctx); }
}

async function fixture(ctx: Context, root: string, approval: boolean) {
  await ctx.plugin(SystemPrompt, {}).await();
  await ctx.plugin(ToolRuntime, { mode: 'native' }).await();
  await ctx.plugin(Storage).await();
  await ctx.plugin(storageJson, { root }).await();
  await ctx.plugin(storageDomain, { backend: 'json' }).await();
  await ctx.plugin(PresetDouble).await();
  const presets = ctx.agentPresets as unknown as PresetDouble;
  if (approval) await ctx.plugin(ApprovalService, { policy: 'ask' }).await();
  const kv = ctx.storage.backend.get('json').kv;
  if (!kv) throw new Error('JSON backend has no KV facet');
  let unit: KvUnit | undefined;
  const open = kv.open.bind(kv);
  const opening = vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
    const result = await open(descriptor);
    if (descriptor.name === 'dsh_bot') unit = result;
    return result;
  });
  const registryPlugin = ctx.plugin(DshBotRegistry, {
    seedExamples: false, presetIdPrefix: 'bot-', presetOrder: 50, dataDir: join(root, 'data'),
  });
  await registryPlugin.await();
  const registry = ctx.dshBots;
  await registry.list();
  opening.mockRestore();
  const liveAgents = new Map<SessionId, Agent>();
  ctx.provide('agents', { get: (id: SessionId) => liveAgents.get(id) } as Context['agents']);
  let owner!: Context;
  await ctx.plugin({
    inject: ['tools', 'systemPrompt', 'dshBots', 'agentPresets', 'agents'],
    apply(injected: Context) { owner = injected; },
  }).await();
  let sequence = 0;
  const create = (
    options: { install?: boolean; agentPreset?: string; composedPreset?: string; blank?: boolean; resume?: boolean; currentBotId?: string } = {}) => {
    const id = SessionId(`bot-manage-session-${++sequence}`);
    let session = Session.create(id, undefined, {
      version: 4, id, createdAt: Date.now(), isSeeded: false,
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    });
    const composedPreset = options.composedPreset ?? options.agentPreset;
    if (composedPreset !== undefined && composedPreset !== options.agentPreset) {
      session.append('agent-preset/selected', { agentPreset: composedPreset });
    }
    if (options.resume) session = Session.fromRestore(id, structuredClone(session.snapshotEvents()), session.header, SessionLogOffset(0), 'detached');
    if (!options.blank) session.append('turn/start', { turn: 1 });
    // Agent identity is a fixture; Session, approval audit, scope routing, tools,
    // registry transactions and JSON writes are the published/production services.
    const payload = { id: `bot-manage-agent-${sequence}`, ctx: owner, session };
    const agent = payload as Agent;
    const scope = createScope(owner, agent);
    payload.ctx = scope.ctx;
    liveAgents.set(session.id, agent);
    agent.ctx.effect(() => () => { liveAgents.delete(session.id); });
    if (composedPreset !== undefined) presets.composed.set(agent.ctx, composedPreset);
    const dispose = options.install === false ? undefined : registerBotManageTool(agent, registry, undefined, options.currentBotId);
    return {
      agent, scope, session, dispose,
      announce: () => ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: options.resume ? 'resume' : 'startup' }),
      select: async (agentPreset: string) => {
        // The registry double models successful composition; use the real Session
        // event and public notification contract without mutating its header.
        presets.composed.set(agent.ctx, agentPreset);
        session.append('agent-preset/selected', { agentPreset });
        await ctx.serial('agent-preset/selected', session.id, agentPreset);
      },
    };
  };
  const execute = (agent: Agent | undefined, args: unknown, signal = new AbortController().signal, name = BOT_MANAGE_TOOL_NAME) => ctx.tools.execute({
    callId: ToolCallId(`bot-manage-call-${++sequence}`), name, arguments: args, signal,
    ...(agent === undefined ? {} : { agent }),
  });
  return {
    ctx, registry, create, execute, presets,
    disk: () => readFile(join(root, 'dsh_bot.json'), 'utf8'),
    unit: () => { if (!unit) throw new Error('Missing dsh_bot KV unit'); return unit; },
    stopRegistry: () => registryPlugin.dispose(),
  };
}

export async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, options: { approval?: boolean } = {}) {
  await mkdir(isolatedHome, { recursive: true });
  const root = await mkdtemp(join(isolatedHome, 't07-bot-manage-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const ctx = new Context();
  try { await run(await fixture(ctx, root, options.approval !== false)); }
  finally {
    try { await ctx.fiber.dispose(); }
    finally {
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }
}

export function successful(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  const text = result.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
  expect(text).toContain(JSON.stringify(result.value));
  expect(text.length).toBeGreaterThan(JSON.stringify(result.value).length);
  return result.value;
}

export function failure(result: ToolExecutionResult, code?: string) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!result.isError) throw new Error('Expected a rejected tool call');
  expect(result).not.toHaveProperty('value');
  if (code !== undefined) expect(result.error.info?.code).toBe(code);
  return result.error;
}

export function audit(session: Session) {
  return session.snapshotEvents().filter((event) => event.type === 'approval/asked' || event.type === 'approval/decided');
}

export function mutation(action: 'create' | 'update' | 'delete') {
  if (action === 'create') return { action, input: { id: 'beta', name: 'Beta' } };
  if (action === 'update') return { action, id: 'alpha', input: { name: 'Changed' } };
  return { action, id: 'alpha' };
}

