/** T02-only probes. Called after the Host Loader settles; never sends a prompt. */
import type { Context } from '@deepseek-ai/cordis';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { load } from 'js-yaml';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PresetProbeOptions {
  phase: 'prepare' | 'resume';
  cwd: string;
  statePath: string;
  emit: (name: string, detail: unknown) => void;
  appendRows?: PresetDefinition['plugins'];
  onComposedAgent?: (agent: Agent) => Promise<void>;
  onPlainAgent?: (agent: Agent) => Promise<void>;
}

interface SavedState {
  stableSessionId?: string;
  versionSessionId?: string;
  version2SessionId?: string;
}

function errorDetail(error: unknown): { name: string; code?: string; message: string } {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return { name: error.name, ...(code === undefined ? {} : { code }), message: error.message };
}

function definition(id: string, revision: string): PresetDefinition {
  return {
    id,
    name: 'API spike Bot',
    description: `T02 isolated probe ${revision}`,
    plugins: [{ id: `persona-${revision}`, name: '@deepseek-ai/dsh-persona', config: { prefix: `T02 ${revision}` } }],
  };
}

/** Preset leases belong to this context; Session Controller owns the Agents it creates. */
export async function runPresetProbe(ctx: Context, options: PresetProbeOptions): Promise<void> {
  const { emit } = options;
  const register = async (value: PresetDefinition) => {
    const owned = ctx.effect(() => ctx.agentPresets.register(value), `t02:preset:${value.id}`);
    await owned;
    return owned;
  };
  const create = async (agentPreset: string) => {
    const value = await ctx.sessionController.create({ cwd: options.cwd, agentPreset });
    const result = await ctx.sessionController.resolveAgent(value.sessionId);
    if ('error' in result) throw result.error;
    // Session Controller returns an identity, not an AgentHandle. Its Host
    // lifecycle owns the Agent; bare Agent intentionally exposes no disposer.
    const durable = await ctx.sessions.flush(result.agent.session);
    const inspection = await ctx.sessionController.inspect(value.sessionId);
    return { value, agent: result.agent, durable, persistedPreset: inspection.meta.agentPreset };
  };
  const attempt = async (name: string, operation: () => Promise<unknown>) => {
    try { emit(name, { ok: true, result: await operation() }); }
    catch (error) { emit(name, { ok: false, error: errorDetail(error) }); }
  };
  const expectedFailure = async (operation: () => Promise<unknown>) => {
    try { await operation(); return { rejected: false }; }
    catch (error) { return { rejected: true, error: errorDetail(error) }; }
  };
  const row = async (id: string) => (await ctx.agentPresets.list()).find(value => value.id === id) ?? null;
  const persona = async (agent: Agent) => (await ctx.systemPrompt.assemble({ scope: agent })).sections
    .filter(value => value.name === 'deployment:persona-prefix');

  if (options.phase === 'resume') {
    const state = JSON.parse(await readFile(options.statePath, 'utf8')) as SavedState;
    await attempt('presets.resume-version-missing', async () => {
      if (state.versionSessionId === undefined) throw new Error('prepare did not save versionSessionId');
      const sessionId = state.versionSessionId as SessionId;
      const before = await ctx.sessionController.inspect(sessionId);
      const result = await ctx.sessionController.resolveAgent(sessionId);
      return {
        persistedPreset: before.meta.agentPreset,
        row: await row('bot-spike~1'),
        refused: 'error' in result,
        ...('error' in result ? { error: errorDetail(result.error) } : { unexpectedLiveAgent: result.agent.id }),
      };
    });
    await attempt('presets.resume-version-restored', async () => {
      if (state.versionSessionId === undefined) throw new Error('prepare did not save versionSessionId');
      await register(definition('bot-spike~1', 'r1'));
      const result = await ctx.sessionController.resolveAgent(state.versionSessionId as SessionId);
      if ('error' in result) throw result.error;
      return { sessionId: result.agent.id, composedPreset: ctx.agentPresets.composedPreset(result.agent.ctx) };
    });
    await attempt('presets.resume-stable-current-definition', async () => {
      if (state.stableSessionId === undefined) throw new Error('prepare did not save stableSessionId');
      await register(definition('bot-spike', 'r2'));
      const result = await ctx.sessionController.resolveAgent(state.stableSessionId as SessionId);
      if ('error' in result) throw result.error;
      return {
        sessionId: result.agent.id,
        composedPreset: ctx.agentPresets.composedPreset(result.agent.ctx),
        document: await ctx.agentPresets.readDocument('bot-spike'),
        persona: await persona(result.agent),
      };
    });
    return;
  }

  const state: SavedState = {};
  await attempt('presets.same-id-update', async () => {
    const original = definition('bot-spike', 'r1');
    const removeOriginal = await register(original);
    const visible = await row(original.id);
    const duplicate = await expectedFailure(async () => {
      const remove = await register(original);
      await remove();
    });
    const old = await create(original.id);
    state.stableSessionId = old.value.sessionId;
    if (options.onPlainAgent !== undefined) await options.onPlainAgent(old.agent);

    const started = performance.now();
    await removeOriginal();
    const absent = await row(original.id);
    const absentAtMs = performance.now() - started;
    const duringGap = await expectedFailure(() => ctx.sessionController.create({ cwd: options.cwd, agentPreset: original.id }));
    const failedCreateAtMs = performance.now() - started;

    // Invalid activation is deliberately tested: register resolves a disposer,
    // while list()/resolve() report broken. A transaction must check this state.
    const removeBroken = await register({ ...original, plugins: [{ name: '' }] });
    const brokenRegisteredAtMs = performance.now() - started;
    const broken = await row(original.id);
    const brokenCreate = await expectedFailure(() => ctx.sessionController.create({ cwd: options.cwd, agentPreset: original.id }));
    await removeBroken();
    const removeRestored = await register(original);
    const restored = await row(original.id);
    const restoredAtMs = performance.now() - started;
    const afterRollback = await create(original.id);

    // Successful replacement still requires unregister/register. Existing
    // Agent keeps the retained r1; only future create() binds r2.
    await removeRestored();
    await register(definition(original.id, 'r2'));
    const fresh = await create(original.id);
    return {
      visible,
      duplicate,
      absent,
      gapTimingMs: { listAbsent: absentAtMs, createRejected: failedCreateAtMs, brokenRegistered: brokenRegisteredAtMs, restored: restoredAtMs },
      duringGap,
      brokenRegistrationResolved: true,
      broken,
      brokenCreate,
      restored,
      rollbackCreated: afterRollback.value,
      oldSession: { ...old.value, durable: old.durable, persistedPreset: old.persistedPreset, stillLive: ctx.agents.get(old.agent.id) === old.agent },
      newSession: fresh.value,
      oldComposition: ctx.agentPresets.inspectCompositions(old.agent.ctx),
      newComposition: ctx.agentPresets.inspectCompositions(fresh.agent.ctx),
      oldPersona: await persona(old.agent),
      newPersona: await persona(fresh.agent),
      retainedCompositionCount: ctx.agentPresets.inspectCompositions().filter(value => value.id === original.id).length,
    };
  });

  await attempt('presets.versioned-update', async () => {
    const remove1 = await register(definition('bot-spike~1', 'r1'));
    const old = await create('bot-spike~1');
    state.versionSessionId = old.value.sessionId;
    await register(definition('bot-spike~2', 'r2'));
    const overlapRoster = (await ctx.agentPresets.list()).filter(value => value.id.startsWith('bot-spike~'));
    const current = await create('bot-spike~2');
    state.version2SessionId = current.value.sessionId;
    await remove1();
    const afterRemoveRoster = (await ctx.agentPresets.list()).filter(value => value.id.startsWith('bot-spike~'));
    return {
      old: { ...old.value, persistedPreset: old.persistedPreset, durable: old.durable },
      current: { ...current.value, persistedPreset: current.persistedPreset, durable: current.durable },
      overlapRoster,
      overlapDisplay: overlapRoster.map(value => ({ id: value.id, ...presetDisplayText(value, key => key) })),
      afterRemoveRoster,
      missingOldIdDisplayFallback: presetDisplayText({ id: 'bot-spike~1' }, key => key),
      oldSessionStillLive: ctx.agents.get(old.agent.id) === old.agent,
      oldComposedPreset: ctx.agentPresets.composedPreset(old.agent.ctx),
      newCreateRemovedVersion: await expectedFailure(() => ctx.sessionController.create({ cwd: options.cwd, agentPreset: 'bot-spike~1' })),
    };
  });

  await attempt('presets.standard-template', async () => {
    const document = await ctx.agentPresets.readDocument('standard');
    const parsed = load(document.content, { schema: entryListSchema });
    if (!Array.isArray(parsed)) throw new Error('standard readDocument did not return a YAML list');
    const plugins = parsed as PresetDefinition['plugins'];
    const inventory = (await ctx.agentPresets.compositionInventory()).find(value => value.id === 'standard');
    const persona = plugins.find(value => value.id === 'persona');
    if (persona === undefined) throw new Error('standard no longer includes expected persona row');
    const cloned: PresetDefinition = {
      id: 'bot-spike-standard',
      name: 'API spike standard clone',
      plugins: [
        ...plugins.map(value => value.id === 'persona'
          ? { ...value, config: { prefix: 'T02 runtime standard clone persona' } }
          : value),
        ...(options.appendRows ?? []),
      ],
    };
    await register(cloned);
    const clone = await row(cloned.id);
    const created = await create(cloned.id);
    if (options.onComposedAgent !== undefined) await options.onComposedAgent(created.agent);
    return {
      document,
      originalTopLevelRowCount: plugins.length,
      cloneTopLevelRowCount: cloned.plugins.length,
      clone,
      created: created.value,
      inventory,
      inventoryHasConfig: inventory?.rows.some(value => 'config' in value) ?? false,
      clonedDocument: await ctx.agentPresets.readDocument(cloned.id),
    };
  });

  for (const [label, disabled] of [
    ['expression', { __jsExpr: "process.platform === 'win32'" }],
    ['string', "process.platform === 'win32'"],
    ['function', () => false],
  ] as const) {
    await attempt(`presets.expression-${label}`, async () => {
      const id = `bot-spike-${label}`;
      // string/function are intentionally outside PresetDefinition's public type.
      const plugins = [{ id: 'probe', name: '@deepseek-ai/dsh-persona', disabled, config: { prefix: 'T02 expression probe' } }] as unknown as PresetDefinition['plugins'];
      await register({ id, plugins });
      const inventory = (await ctx.agentPresets.compositionInventory()).find(value => value.id === id);
      return { platform: process.platform, roster: await row(id), inventory };
    });
  }
  await mkdir(dirname(options.statePath), { recursive: true });
  await writeFile(options.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  emit('presets.restart-state-saved', state);
}
