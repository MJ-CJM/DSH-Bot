import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { Capabilities } from '../src/host/capabilities/service.js';
import type { DshBotRegistry } from '../src/host/registry.js';
vi.mock('../src/host/bot-context.js', () => ({ getBotBinding: (agent: { fixtureBinding: unknown }) => agent.fixtureBinding }));
const key = { botId: 'alpha', botCreatedAt: 1 };
const content = '---\nname: review\ndescription: Review changes\n---\n\nCheck changes carefully.\n';
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await run(f); } finally { await f.service.close(); await f.ctx.fiber.dispose(); await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const base = join(process.cwd(), '../../.dsh-dev/capabilities-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')); const ctx = new Context();
  const bot = { id: 'alpha', createdAt: 1, skills: { extraDirs: ['/configured-only'] } };
  const registry = { get: async () => bot, config: { dataDir: root }, mainSessions: { find: async () => ({ sessionId: 'main' }) } } as unknown as DshBotRegistry;
  const llm = { listProviders: vi.fn(() => [{ id: 'mock', name: 'Mock provider' }]),
    listModels: vi.fn(async () => [{ provider: 'mock', id: 'small', name: 'Small', inputModalities: ['text'] }]),
    resolveModelInfo: vi.fn(async () => ({ provider: 'mock', id: 'small', name: 'Small', reasoning: { efforts: [{ id: 'high', name: 'High' }] } })),
    discoverModels: vi.fn(), generate: vi.fn() };
  ctx.provide('llm', llm as never); const agents = { get: vi.fn<() => unknown>(() => undefined) }; ctx.provide('agents', agents as never);
  const service = new Capabilities(ctx, registry); return { root, ctx, bot, registry, llm, agents, service, skillsPath: join(root, 'bots/alpha/skills') };
}
describe('public capability bridge and own skill management', () => {
  it('lists only registered adapters and advertised models without discovery or generation', async () => fixture(async f => {
    expect(await f.service.request({ action: 'models' })).toMatchObject({ kind: 'models', providers: [{ id: 'mock', available: true, models: [{ id: 'small' }] }] });
    expect(await f.service.request({ action: 'modelInfo', provider: 'mock', model: 'small' })).toMatchObject({ kind: 'modelInfo', model: { reasoning: { efforts: [{ id: 'high' }] } } });
    await expect(f.service.request({ action: 'modelInfo', provider: 'mock', model: 'forged' })).rejects.toThrow();
    expect(f.llm.discoverModels).not.toHaveBeenCalled(); expect(f.llm.generate).not.toHaveBeenCalled();
  }));
  it('shows adapter catalog failure explicitly without presenting a loaded empty provider', async () => fixture(async f => {
    f.llm.listModels.mockRejectedValue(new Error('private adapter failure'));
    expect(await f.service.request({ action: 'models' })).toEqual({ kind: 'models', providers: [{ id: 'mock', name: 'Mock provider', available: false, models: [] }] });
  }));
  it('distinguishes configured skill roots from live scoped loading and tool visibility', async () => fixture(async f => {
    expect(await f.service.request({ action: 'inspect', bot: key })).toMatchObject({ online: false, skillsAvailable: false, skills: [], extraDirs: ['/configured-only'], tools: [] });
    const list = vi.fn(async () => [{ name: 'native-review', description: 'Loaded by native provider', provider: 'filesystem' }]);
    const agent = { fixtureBinding: key, ctx: { get: (name: string) => name === 'skills' ? { list } : undefined,
      tools: { schemas: () => [{ name: 'read_file' }] } } };
    f.agents.get.mockReturnValue(agent);
    expect(await f.service.request({ action: 'inspect', bot: key })).toMatchObject({ online: true, skillsAvailable: true, skills: [{ name: 'native-review' }], tools: ['read_file'] });
    expect(list).toHaveBeenCalledWith({ scope: agent, cwd: undefined });
  }));
  it('reports existing main data-flow restrictions without mutating labels or exposing lineage records', async () => fixture(async f => {
    const label = { readers: [], originTrust: 'candidate', sourceVersions: ['private-version'], restrictions: ['no-egress', 'revoked'], grants: [] };
    const read = vi.fn(() => label), before = JSON.stringify(label);
    Object.assign(f.registry, { memoryOutlets: { label: read } });
    const result = await f.service.request({ action: 'inspect', bot: key });
    expect(result).toMatchObject({ mainSessionId: 'main', dataFlow: { state: 'restricted', reasons: ['no-egress', 'revoked', 'unknown-lineage', 'reader-mismatch'] } });
    expect(read).toHaveBeenCalledWith('main'); expect(JSON.stringify(label)).toBe(before);
    expect(JSON.stringify(result)).not.toContain('private-version');
  }));
  it('requires explicit fresh action, passes exact generation/main CAS and returns the created native address', async () => fixture(async f => {
    const fresh = vi.fn(async () => ({ sessionId: 'new-native-main' })); Object.assign(f.registry.mainSessions ?? {}, { fresh });
    await f.service.request({ action: 'inspect', bot: key }); expect(fresh).not.toHaveBeenCalled();
    expect(await f.service.request({ action: 'freshConversation', bot: key, expectedSessionId: 'main' })).toEqual({ kind: 'conversation', sessionId: 'new-native-main' });
    expect(fresh).toHaveBeenCalledExactlyOnceWith('alpha', 1, 'main');
    await expect(f.service.request({ action: 'freshConversation', bot: { ...key, botCreatedAt: 99 }, expectedSessionId: 'main' })).rejects.toThrow();
    expect(fresh).toHaveBeenCalledTimes(1);
  }));
  it('creates, reads and edits own SKILL.md with hash CAS; stale editor cannot overwrite', async () => fixture(async f => {
    const first = await f.service.request({ action: 'skillWrite', bot: key, name: 'review', content, expectedHash: null });
    if (first.kind !== 'skill') throw new Error('Missing receipt');
    expect(first.hash).toBeTruthy();
    expect(await f.service.request({ action: 'skillRead', bot: key, name: 'review' })).toEqual(first);
    await expect(f.service.request({ action: 'skillWrite', bot: key, name: 'review', content: `${content}stale`, expectedHash: null })).rejects.toThrow();
    expect(await readFile(join(f.skillsPath, 'review/SKILL.md'), 'utf8')).toBe(content);
    const changed = await f.service.request({ action: 'skillWrite', bot: key, name: 'review', content: `${content}Update`, expectedHash: first.hash });
    if (changed.kind !== 'skill' || !changed.hash) throw new Error('Missing updated receipt');
    await writeFile(join(f.skillsPath, 'review/asset.txt'), 'Preserved');
    await f.service.request({ action: 'skillRemove', bot: key, name: 'review', expectedHash: changed.hash });
    expect(await readFile(join(f.skillsPath, 'review/asset.txt'), 'utf8')).toBe('Preserved');
    expect(await f.service.request({ action: 'inspect', bot: key })).toMatchObject({ ownSkills: [] });
  }));
  it('rejects traversal, symlink, stale Bot generation, and invalid frontmatter', async () => fixture(async f => {
    await expect(f.service.request({ action: 'skillRead', bot: key, name: '../outside' })).rejects.toThrow();
    await f.service.request({ action: 'inspect', bot: key });
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'SKILL.md'), 'SECRET');
    await symlink(outside, join(f.skillsPath, 'linked'));
    await expect(f.service.request({ action: 'skillRead', bot: key, name: 'linked' })).rejects.toThrow();
    await expect(f.service.request({ action: 'skillWrite', bot: key, name: 'review', content: 'invalid', expectedHash: null })).rejects.toThrow();
    f.bot.createdAt = 2; await expect(f.service.request({ action: 'inspect', bot: key })).rejects.toThrow();
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('SECRET');
  }));
});
