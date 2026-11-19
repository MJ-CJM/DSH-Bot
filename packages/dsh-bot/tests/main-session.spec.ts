import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SessionTitle from '@deepseek-ai/dsh-session-title';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import { describe, expect, it, vi } from 'vitest';
import { MainSessions, mainSessionDomain } from '../src/host/main-session.js';
import * as botContext from '../src/host/bot-context.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { bindings } from '../src/host/data-flow/agent-binding.js';

function required<T>(value: T | undefined | null): T { if (value == null) throw new Error('Missing fixture value'); return value; }
async function setup() {
  await mkdir('../../.dsh-dev/r05', { recursive: true }); const root = await mkdtemp('../../.dsh-dev/r05/main-');
  const ctx = new Context();
  await ctx.plugin(Storage).await(); await ctx.plugin(storageJson, { root: resolve(root) }).await(); await ctx.plugin(storageDomain, { backend: 'json' }).await();
  await ctx.plugin(SessionProjections).await(); await ctx.plugin(SessionStore).await();
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 10, fallbackMaxBytes: 128, maxTitleBytes: 256 }).await();
  let bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), createdAt: 10, updatedAt: 10, schemaVersion: 1 });
  const rows: Array<{ sessionId: SessionId; updatedAt: number; running: boolean; blank: boolean; agentAvailable: boolean }> = [];
  const add = (id: string, updatedAt: number, extra = {}) => {
    const session = ctx.sessions.create(SessionId(id), { meta: { createdAt: 20, agentPreset: 'bot-alpha', ...extra } });
    rows.push({ sessionId: session.id, updatedAt, running: false, blank: false, agentAvailable: false }); return session;
  };
  const create = vi.fn(async (request?: { sessionId?: SessionId }) => ({ sessionId: add(request?.sessionId ?? `created-${rows.length}`, Date.now(), { createdAt: Math.max(Date.now(), bot.createdAt) }).id }));
  const rename = vi.fn(async ({ sessionId, title }: { sessionId: SessionId; title: string }) => {
    const session = required(ctx.sessions.get(sessionId));
    const accepted = ctx.sessionTitle.rename(session, title); return { title: accepted.title, seq: accepted.eventSeq };
  });
  ctx.provide('agents', { get: () => undefined } as unknown as Context['agents']);
  ctx.provide('agentPresets', { list: async () => [{ id: 'bot-alpha' }] } as unknown as Context['agentPresets']);
  ctx.provide('sessionController', { list: async () => ({ items: rows }), create, rename, inspect: vi.fn(() => { throw new Error('Must not inspect content'); }) } as unknown as Context['sessionController']);
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true);
  const bots = { invalidate: vi.fn(), get: async () => structuredClone(bot), config: { presetIdPrefix: 'bot-' }, ensureBotsWorkspace: async () => ({ workspaceId: 'bots', path: '/bots' }) };
  let mains = new MainSessions(ctx, bots as unknown as Context['dshBots']); await mains.start();
  const table = required(ctx.storageDomain.get(mainSessionDomain.name)).table('bindings');
  return { ctx, table, add, rows, create, rename, flush, bots, get mains() { return mains; },
    change: (fields: Partial<typeof bot>) => { bot = { ...bot, ...fields }; },
    reopen: async () => { await mains.close(); mains = new MainSessions(ctx, bots as unknown as Context['dshBots']); await mains.start(); },
    close: async () => { await mains.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) { const f = await setup(); try { await test(f); } finally { await f.close(); } }
describe('single main mapping with real JSON store and native title service', () => {
  it('preserves an exact saved main through a missing live context without creating a replacement', async () => fixture(async f => {
    const main = await f.mains.open('alpha');
    const live = { session: required(f.ctx.sessions.get(main.sessionId as SessionId)) } as Agent;
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue(live);
    await f.reopen();
    expect(await f.mains.find('alpha')).toEqual(main);
    expect(await f.mains.open('alpha')).toEqual(main);
    expect(bindings.has(live)).toBe(false);
    expect(f.create).toHaveBeenCalledTimes(1);
    bindings.set(live, { botId: 'alpha', botCreatedAt: 9 });
    expect(await f.mains.find('alpha')).toBeUndefined();
    bindings.delete(live);
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockReturnValue({ values: { agentPreset: 'standard' } } as ReturnType<Context['sessionProjections']['snapshot']>);
    expect(await f.mains.find('alpha')).toBeUndefined();
  }));
  it('does not infer ownership of an unmapped live Agent from its preset name', async () => fixture(async f => {
    const session = f.add('unmapped-live', 1);
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue({ session } as Agent);
    expect(await f.mains.find('alpha')).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  }));
  it('migrates the most active eligible session, excludes children/forks/old incarnations, and preserves all others', async () => fixture(async f => {
    const old = f.add('old', 1); const recent = f.add('recent', 5);
    f.add('child', 100, { origin: 'subagent', parentSession: 'recent' });
    f.add('parent-only', 200, { parentSession: 'recent' }); f.add('previous-bot', 300, { createdAt: 1 });
    await f.rename({ sessionId: old.id, title: 'Old title' });
    expect(await f.mains.find('alpha')).toEqual({ sessionId: recent.id });
    expect(f.ctx.sessionTitle.get(recent)).toMatchObject({ title: 'Alpha', source: { kind: 'user' } });
    expect(f.ctx.sessionTitle.get(old)?.title).toBe('Old title'); expect(f.rows).toHaveLength(5); expect(f.create).not.toHaveBeenCalled();
    required(f.rows[0]).updatedAt = 1000;
    await f.reopen(); expect(await f.mains.find('alpha')).toEqual({ sessionId: recent.id });
    expect(f.ctx.sessionController.inspect).not.toHaveBeenCalled();
  }));
  it('opens concurrently only once and persists the mapping across reopen', async () => fixture(async f => {
    expect(await f.mains.find('alpha')).toBeUndefined();
    const [a,b] = await Promise.all([f.mains.open('alpha'), f.mains.open('alpha')]);
    expect(a).toEqual(b); expect(f.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'bots', agentPreset: 'bot-alpha' });
    await f.reopen(); expect(await f.mains.open('alpha')).toEqual(a); expect(f.create).toHaveBeenCalledTimes(1);
  }));
  it('pins against native automatic fallback, syncs Bot rename and repairs a later title change without looping', async () => fixture(async f => {
    const { sessionId } = await f.mains.open('alpha'); const session = required(f.ctx.sessions.get(sessionId as SessionId));
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Greeting' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    await Promise.resolve(); expect(f.ctx.sessionTitle.get(session)?.title).toBe('Alpha');
    f.change({ name: 'Renamed' }); await f.mains.find('alpha'); expect(f.ctx.sessionTitle.get(session)?.title).toBe('Renamed');
    const before = f.rename.mock.calls.length;
    const seen = vi.fn(); f.ctx.on('session/event', seen);
    f.ctx.sessionTitle.rename(session, 'he');
    expect(seen).toHaveBeenCalled();
    await vi.waitFor(() => expect(f.ctx.sessionTitle.get(session)?.title).toBe('Renamed'));
    expect(f.rename.mock.calls.length).toBe(before + 1);
    await f.mains.find('alpha'); expect(f.rename.mock.calls.length).toBe(before + 1);
  }));
  it('uses stat headers for cold migration without requesting session content', async () => fixture(async f => {
    const cold = f.add('cold', 50);
    const stat = vi.fn(async () => ({ header: cold.header }));
    f.ctx.provide('sessionPersistence', { stat } as unknown as Context['sessionPersistence']);
    Object.assign(f.ctx.sessionController, { projections: vi.fn(async () => ({ kind: 'sequenced', asOfSeq: 0, values: { agentPreset: 'bot-alpha' } })) });
    const originalRename = required(f.rename.getMockImplementation());
    const get = vi.spyOn(f.ctx.sessions, 'get').mockReturnValue(undefined);
    f.rename.mockImplementationOnce(async request => { get.mockRestore(); return originalRename(request); });
    expect(await f.mains.find('alpha')).toEqual({ sessionId: 'cold' });
    expect(stat).toHaveBeenCalledExactlyOnceWith('cold'); expect(f.ctx.sessionController.inspect).not.toHaveBeenCalled();
  }));
  it('rejects an exact-generation open before side effects and rechecks after native title persistence', async () => fixture(async f => {
    await expect(f.mains.open('alpha', 9)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(f.create).not.toHaveBeenCalled(); expect(f.rename).not.toHaveBeenCalled();
    const rename = required(f.rename.getMockImplementation());
    f.rename.mockImplementationOnce(async input => { const result = await rename(input); f.change({ createdAt: 11 }); return result; });
    await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/conflict' });
  }));
  it('refuses the wrong effective preset even when an old matching live Bot binding remains', async () => fixture(async f => {
    const main = await f.mains.open('alpha', 10), session = required(f.ctx.sessions.get(main.sessionId as SessionId));
    const live = { session } as Agent; bindings.set(live, { botId: 'alpha', botCreatedAt: 10 });
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue(live);
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockReturnValue({ values: { agentPreset: 'standard' } } as ReturnType<Context['sessionProjections']['snapshot']>);
    try { expect(await f.mains.find('alpha')).toBeUndefined(); }
    finally { bindings.delete(live); }
  }));
  it('refuses a native creation that returned a different effective preset before binding or renaming', async () => fixture(async f => {
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockReturnValue({ values: { agentPreset: 'standard' } } as ReturnType<Context['sessionProjections']['snapshot']>);
    await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(f.mains.boundSessionIds()).toEqual([]); expect(f.rename).not.toHaveBeenCalled();
  }));
  it.each(['other-preset', 'migration-required', 'unavailable'] as const)('does not open a cold main with %s identity', async kind => fixture(async f => {
    const cold = f.add('cold', 50);
    await f.table.put(JSON.stringify(['alpha', 10]), { botId: 'alpha', botCreatedAt: 10, sessionId: cold.id });
    f.ctx.provide('sessionPersistence', { stat: async () => ({ header: cold.header }) } as unknown as Context['sessionPersistence']);
    vi.spyOn(f.ctx.sessions, 'get').mockReturnValue(undefined);
    const projections = vi.fn(async () => kind === 'unavailable' ? null : { kind: kind === 'migration-required' ? 'migration-required' : 'sequenced', values: { agentPreset: 'standard' }, asOfSeq: 0 });
    Object.assign(f.ctx.sessionController, { projections });
    if (kind === 'other-preset') expect(await f.mains.find('alpha')).toBeUndefined();
    else await expect(f.mains.find('alpha')).rejects.toMatchObject({ code: 'bot/unavailable' });
    expect(projections).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled(); expect(f.rename).not.toHaveBeenCalled();
  }));
  it('accepts native title normalization once without repeated writes or repair loops', async () => fixture(async f => {
    f.change({ name: 'Multi   space' });
    const main = await f.mains.open('alpha'); await f.mains.find('alpha');
    expect(f.ctx.sessionTitle.get(required(f.ctx.sessions.get(main.sessionId as SessionId)))?.title).toBe('Multi space');
    expect(f.rename).toHaveBeenCalledTimes(1);
  }));
  it('preserves an unavailable saved main until explicit fresh recovery, without promoting hidden old history', async () => fixture(async f => {
    f.add('older-history', 1); f.add('old-main', 2);
    expect(await f.mains.find('alpha')).toEqual({ sessionId: 'old-main' });
    f.ctx.provide('sessionPersistence', { stat: async () => undefined } as unknown as Context['sessionPersistence']);
    const get = f.ctx.sessions.get.bind(f.ctx.sessions);
    vi.spyOn(f.ctx.sessions, 'get').mockImplementation(id => id === 'old-main' ? undefined : get(id));
    expect(await f.mains.find('alpha')).toBeUndefined();
    await expect(f.mains.open('alpha')).rejects.toMatchObject({ code: 'bot/unavailable' });
    await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/unavailable' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.mains.boundSessionId('alpha', 10)).toBe('old-main');
    const replacement = await f.mains.fresh('alpha', 10, 'old-main');
    expect(replacement.sessionId).not.toBe('older-history'); expect(f.create).toHaveBeenCalledTimes(1);
    expect(get('older-history' as SessionId)).toBeDefined();
  }));
  it('does not create a replacement when a saved native main was downgraded to the standard preset', async () => fixture(async f => {
    const main = await f.mains.open('alpha', 10), count = f.create.mock.calls.length;
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockReturnValue({ values: { agentPreset: 'standard' } } as ReturnType<Context['sessionProjections']['snapshot']>);
    await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/unavailable' });
    await expect(f.mains.open('alpha')).rejects.toMatchObject({ code: 'bot/unavailable' });
    expect(f.create).toHaveBeenCalledTimes(count);
    expect(f.mains.boundSessionId('alpha', 10)).toBe(main.sessionId);
  }));
  it('restores its exact blank native main from the default preset only on an exact Bot open', async () => fixture(async f => {
    const main = await f.mains.open('alpha', 10);
    const session = required(f.ctx.sessions.get(main.sessionId as SessionId));
    const runMaintenance = <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal);
    const agent = { session, ctx: f.ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, runMaintenance } as unknown as Agent;
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue(agent);
    let preset = 'standard';
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockImplementation(() =>
      ({ values: { agentPreset: preset } }) as ReturnType<Context['sessionProjections']['snapshot']>);
    const select = vi.fn(async (_agent, value: string) => {
      preset = value;
      return value;
    });
    const prepare = vi.fn(async (agent: Agent, owner: { botId: string; botCreatedAt: number }) => { bindings.set(agent, owner); });
    const preparation = vi.spyOn(botContext, 'blankBotPreparation').mockReturnValue(prepare);
    Object.assign(f.ctx.agentPresets, { defaultId: 'standard', select });

    expect(await f.mains.find('alpha')).toBeUndefined();
    await expect(f.mains.open('alpha')).rejects.toMatchObject({ code: 'bot/unavailable' });
    await expect(f.mains.open('alpha', 9)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(select).not.toHaveBeenCalled();
    try { expect(await f.mains.open('alpha', 10)).toEqual(main); }
    finally { preparation.mockRestore(); }
    expect(select).toHaveBeenCalledExactlyOnceWith(agent, 'bot-alpha');
    expect(prepare).toHaveBeenCalledExactlyOnceWith(agent, { botId: 'alpha', botCreatedAt: 10 });
    expect(f.flush).toHaveBeenLastCalledWith(session);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.mains.boundSessionIds()).toEqual([main.sessionId]);
  }));
  it.each(['business history', 'queued input', 'other Bot preset', 'retired live Bot generation'] as const)(
    'keeps an unavailable main untouched with %s', async cause => fixture(async f => {
      const main = await f.mains.open('alpha', 10);
      const session = required(f.ctx.sessions.get(main.sessionId as SessionId));
      const pending = createUserMessage({ content: [{ type: 'text', text: 'Pending input' }], source: { kind: 'user' } });
      const agent = { session, status: 'idle', inbox: { nextTurn: cause === 'queued input' ? [pending] : [], nextStep: [] } } as unknown as Agent;
      if (cause === 'business history') session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Existing input' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
      if (cause === 'retired live Bot generation') bindings.set(agent, { botId: 'alpha', botCreatedAt: 9 });
      vi.spyOn(f.ctx.agents, 'get').mockReturnValue(agent);
      const preset = cause === 'other Bot preset' ? 'bot-beta' : 'standard';
      const select = vi.fn();
      Object.assign(f.ctx.agentPresets, { defaultId: preset, select });
      vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockReturnValue({ values: { agentPreset: preset } } as ReturnType<Context['sessionProjections']['snapshot']>);

      await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/unavailable' });
      expect(select).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledOnce();
      expect(f.mains.boundSessionIds()).toEqual([main.sessionId]);
    }));
  it('keeps failed recovery unavailable even when native rollback does not restore the default', async () => fixture(async f => {
    const main = await f.mains.open('alpha', 10);
    const session = required(f.ctx.sessions.get(main.sessionId as SessionId));
    const runMaintenance = <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal);
    const agent = { session, ctx: f.ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, runMaintenance } as unknown as Agent;
    vi.spyOn(f.ctx.agents, 'get').mockReturnValue(agent);
    let preset = 'standard';
    vi.spyOn(f.ctx.sessionProjections, 'snapshot').mockImplementation(() =>
      ({ values: { agentPreset: preset } }) as ReturnType<Context['sessionProjections']['snapshot']>);
    const select = vi.fn(async (_agent, value: string) => {
      if (value === 'standard') throw new Error('Native rollback failed');
      preset = value;
      return value;
    });
    const preparation = vi.spyOn(botContext, 'blankBotPreparation').mockReturnValue(async () => { throw new Error('Setup failed'); });
    Object.assign(f.ctx.agentPresets, { defaultId: 'standard', select });
    try {
      await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/unavailable' });
      expect(preset).toBe('bot-alpha');
      expect(await f.mains.find('alpha')).toBeUndefined();
      await expect(f.mains.open('alpha', 10)).rejects.toMatchObject({ code: 'bot/unavailable' });
    } finally { preparation.mockRestore(); }
    expect(select.mock.calls.map(([, value]) => value)).toEqual(['bot-alpha', 'standard']);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.mains.boundSessionIds()).toEqual([main.sessionId]);
  }));
  it('never reuses the mapping when the same Bot id is recreated', async () => fixture(async f => {
    const previous = await f.mains.open('alpha');
    f.change({ createdAt: Date.now() + 100 });
    const replacement = await f.mains.open('alpha');
    expect(replacement.sessionId).not.toBe(previous.sessionId); expect(f.rows).toHaveLength(2);
  }));
});

describe('explicit fresh native main recovery', () => {
  it('creates and binds a blank native main while retaining the old native history and binding across reopen', async () => fixture(async f => {
    const old = await f.mains.open('alpha'), session = required(f.ctx.sessions.get(old.sessionId as SessionId));
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Old user history' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    const before = JSON.stringify(session.snapshotEvents());
    const fresh = await f.mains.fresh('alpha', 10, old.sessionId);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(JSON.stringify(session.snapshotEvents())).toBe(before);
    expect(f.ctx.sessions.get(old.sessionId as SessionId)).toBe(session);
    expect(required(f.ctx.sessions.get(fresh.sessionId as SessionId)).snapshotEvents().some(e => e.type === 'user/message')).toBe(false);
    expect(f.bots.invalidate).toHaveBeenCalledOnce();
    await f.reopen(); expect(await f.mains.open('alpha')).toEqual(fresh);
  }));
  it('serializes concurrent clicks and rejects stale main/generation before creating another session', async () => fixture(async f => {
    const old = await f.mains.open('alpha');
    const results = await Promise.allSettled([f.mains.fresh('alpha', 10, old.sessionId), f.mains.fresh('alpha', 10, old.sessionId)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const count = f.create.mock.calls.length;
    await expect(f.mains.fresh('alpha', 9, old.sessionId)).rejects.toMatchObject({ code: 'bot/conflict' });
    await expect(f.mains.fresh('alpha', 10, null)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(f.create).toHaveBeenCalledTimes(count);
  }));
  it('leaves the old main bound when native header flush fails and keeps the unbound new session', async () => fixture(async f => {
    const old = await f.mains.open('alpha'); f.flush.mockResolvedValueOnce(false);
    await expect(f.mains.fresh('alpha', 10, old.sessionId)).rejects.toMatchObject({ code: 'bot/unavailable' });
    expect(await f.mains.find('alpha')).toEqual(old); expect(f.rows).toHaveLength(2);
    expect(f.bots.invalidate).not.toHaveBeenCalled();
  }));
  it('does not override a changed Bot generation or another main binding during native creation', async () => fixture(async f => {
    const old = await f.mains.open('alpha'), original = required(f.create.getMockImplementation());
    f.create.mockImplementationOnce(async () => { const result = await original(); f.change({ createdAt: 30 }); return result; });
    await expect(f.mains.fresh('alpha', 10, old.sessionId)).rejects.toMatchObject({ code: 'bot/conflict' });
    f.change({ createdAt: 10 });
    const other = f.add('other-main', Date.now());
    f.create.mockImplementationOnce(async () => { const result = await original();
      await f.table.put(JSON.stringify(['alpha', 10]), { botId: 'alpha', botCreatedAt: 10, sessionId: other.id }); return result; });
    await expect(f.mains.fresh('alpha', 10, old.sessionId)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(await f.mains.find('alpha')).toEqual({ sessionId: other.id });
    expect(f.ctx.sessions.get(old.sessionId as SessionId)).toBeDefined();
  }));
  it('refuses native reuse of a different session address without replacing the old binding', async () => fixture(async f => {
    const old = await f.mains.open('alpha'); f.create.mockResolvedValueOnce({ sessionId: old.sessionId as SessionId });
    await expect(f.mains.fresh('alpha', 10, old.sessionId)).rejects.toMatchObject({ code: 'bot/conflict' });
    expect(await f.mains.find('alpha')).toEqual(old); expect(f.bots.invalidate).not.toHaveBeenCalled();
  }));
  it('can explicitly start with no saved binding without adopting legacy history', async () => fixture(async f => {
    const legacy = f.add('legacy', 1);
    const fresh = await f.mains.fresh('alpha', 10, null);
    expect(fresh.sessionId).not.toBe(legacy.id); expect(f.rows).toHaveLength(2);
    expect(await f.mains.find('alpha')).toEqual(fresh);
  }));
});
