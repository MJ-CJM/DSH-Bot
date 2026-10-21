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
import { MainSessions } from '../src/host/main-session.js';
import { botCreateSchema, botSchema } from '../src/shared/schema.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

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
  const create = vi.fn(async () => ({ sessionId: add(`created-${rows.length}`, Date.now(), { createdAt: Math.max(Date.now(), bot.createdAt) }).id }));
  const rename = vi.fn(async ({ sessionId, title }: { sessionId: SessionId; title: string }) => {
    const session = required(ctx.sessions.get(sessionId));
    const accepted = ctx.sessionTitle.rename(session, title); return { title: accepted.title, seq: accepted.eventSeq };
  });
  ctx.provide('agents', { get: () => undefined } as unknown as Context['agents']);
  ctx.provide('agentPresets', { list: async () => [{ id: 'bot-alpha' }] } as unknown as Context['agentPresets']);
  ctx.provide('sessionController', { list: async () => ({ items: rows }), create, rename, inspect: vi.fn(() => { throw new Error('Must not inspect content'); }) } as unknown as Context['sessionController']);
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true);
  const bots = { get: async () => structuredClone(bot), config: { presetIdPrefix: 'bot-' }, ensureBotsWorkspace: async () => ({ workspaceId: 'bots', path: '/bots' }) };
  let mains = new MainSessions(ctx, bots as unknown as Context['dshBots']); await mains.start();
  return { ctx, add, rows, create, rename, flush, bots, get mains() { return mains; },
    change: (fields: Partial<typeof bot>) => { bot = { ...bot, ...fields }; },
    reopen: async () => { await mains.close(); mains = new MainSessions(ctx, bots as unknown as Context['dshBots']); await mains.start(); },
    close: async () => { await mains.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) { const f = await setup(); try { await test(f); } finally { await f.close(); } }
describe('single main mapping with real JSON store and native title service', () => {
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
    const originalRename = required(f.rename.getMockImplementation());
    const get = vi.spyOn(f.ctx.sessions, 'get').mockReturnValue(undefined);
    f.rename.mockImplementationOnce(async request => { get.mockRestore(); return originalRename(request); });
    expect(await f.mains.find('alpha')).toEqual({ sessionId: 'cold' });
    expect(stat).toHaveBeenCalledExactlyOnceWith('cold'); expect(f.ctx.sessionController.inspect).not.toHaveBeenCalled();
  }));
  it('accepts native title normalization once without repeated writes or repair loops', async () => fixture(async f => {
    f.change({ name: 'Multi   space' });
    const main = await f.mains.open('alpha'); await f.mains.find('alpha');
    expect(f.ctx.sessionTitle.get(required(f.ctx.sessions.get(main.sessionId as SessionId)))?.title).toBe('Multi space');
    expect(f.rename).toHaveBeenCalledTimes(1);
  }));
  it('creates a fresh main when the mapped session disappears, without promoting hidden old history', async () => fixture(async f => {
    f.add('older-history', 1); f.add('old-main', 2);
    expect(await f.mains.find('alpha')).toEqual({ sessionId: 'old-main' });
    f.ctx.provide('sessionPersistence', { stat: async () => undefined } as unknown as Context['sessionPersistence']);
    const get = f.ctx.sessions.get.bind(f.ctx.sessions);
    vi.spyOn(f.ctx.sessions, 'get').mockImplementation(id => id === 'old-main' ? undefined : get(id));
    expect(await f.mains.find('alpha')).toBeUndefined();
    const replacement = await f.mains.open('alpha');
    expect(replacement.sessionId).not.toBe('older-history'); expect(f.create).toHaveBeenCalledTimes(1);
    expect(get('older-history' as SessionId)).toBeDefined();
  }));
  it('never reuses the mapping when the same Bot id is recreated', async () => fixture(async f => {
    const previous = await f.mains.open('alpha');
    f.change({ createdAt: Date.now() + 100 });
    const replacement = await f.mains.open('alpha');
    expect(replacement.sessionId).not.toBe(previous.sessionId); expect(f.rows).toHaveLength(2);
  }));
});
