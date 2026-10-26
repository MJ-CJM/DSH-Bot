import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
// Like bundle.spec, run against the current build produced by pnpm check.
// This also exercises TypeScript's lowering of the standard Remote decorators.
import { Config, } from '../lib/host/registry.js';

import { withFacility, } from './fixtures/registry.js';

describe('DshBotRegistry with JSON storage and a preset service double', () => {
  it('creates a single 0700 shared workspace on startup and persists its id for concurrent ensures', async () => withFacility(async ({ ctx,
    start, root, workspaces }) => {
    const { registry: native } = await workspaces();
    const create = vi.spyOn(native, 'create');
    const { registry } = await start();
    const path = join(root, 'dsh-bot', 'bots');
    expect(native.list()).toHaveLength(1);
    const shared = native.list()[0];
    if (!shared) throw new Error('Shared Bots workspace was not created');
    expect(shared).toMatchObject({ path, title: 'Bots' });
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(await Promise.all(Array.from({ length: 12 }, () => registry.ensureBotsWorkspace())))
      .toEqual(Array.from({ length: 12 }, () => ({ workspaceId: shared.id, path })));
    expect(create).toHaveBeenCalledTimes(1);
    expect(ctx.storageDomain.get('dsh_bot')?.table('registry_state').get('bots-workspace')).toEqual({ botsWorkspaceId: shared.id });
  }));

  it('reuses the canonical path without overwriting user titles and repairs a stale stored id', async () => withFacility(async ({ ctx, start,
    root, workspaces }) => {
    const { registry: native } = await workspaces();
    const path = join(root, 'dsh-bot', 'bots');
    await mkdir(path, { recursive: true });
    const existing = await native.create(path, 'My renamed bots');
    const { registry, stop } = await start();
    expect(await registry.ensureBotsWorkspace()).toEqual({ workspaceId: existing.id, path });
    expect(existing.title).toBe('My renamed bots');
    const domain = ctx.storageDomain.get('dsh_bot');
    if (!domain) throw new Error('Bot storage domain was not opened');
    const state = domain.table('registry_state');
    await state.put('bots-workspace', { botsWorkspaceId: 'stale-workspace-id' });
    await stop();
    const restarted = await start();
    expect(await restarted.registry.ensureBotsWorkspace()).toEqual({ workspaceId: existing.id, path });
    expect(native.list()).toHaveLength(1);
    expect(ctx.storageDomain.get('dsh_bot')?.table('registry_state').get('bots-workspace')).toEqual({ botsWorkspaceId: existing.id });
    expect(existing.title).toBe('My renamed bots');
  }));

  it('recreates a deleted workspace on demand and restart, preserving history, archive and unrelated workspaces',
    async () => withFacility(async ({ ctx, start, root, workspaces }) => {
    const { registry: native, headers } = await workspaces();
    const { registry, stop } = await start();
    const first = native.list()[0];
    if (!first) throw new Error('Shared Bots workspace was not created');
    const sessionId = SessionId('historical-bot');
    headers.push({ id: sessionId, cwd: first.path, createdAt: 1 });
    await first.attachSession(sessionId);
    await native.archiveSession(sessionId);
    const unrelated = await native.create(root, 'Keep this workspace');
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.recordActivity({ sessionId, botId: 'alpha', role: 'assistant', text: 'Historic reply', at: 1 });
    await native.delete(first.id);
    expect(native.archivedSessionIds).toEqual([sessionId]);
    const next = await registry.ensureBotsWorkspace();
    expect(next.workspaceId).not.toBe(first.id);
    expect(native.list().find((entry) => entry.id === next.workspaceId)?.sessionIds).toEqual([]);
    expect(native.archivedSessionIds).toEqual([sessionId]);
    expect((await registry.listActivity()).sessions).toHaveLength(1);
    expect((await stat(first.path)).isDirectory()).toBe(true);
    const nextEntity = native.list().find((entry) => entry.id === next.workspaceId);
    if (!nextEntity) throw new Error('Shared Bots workspace was not recreated');
    await native.delete(nextEntity.id);
    await stop();
    const restarted = await start();
    const final = await restarted.registry.ensureBotsWorkspace();
    expect(final.workspaceId).not.toBe(next.workspaceId);
    expect(native.list().find((entry) => entry.id === unrelated.id)?.title).toBe('Keep this workspace');
    expect(native.list()).toHaveLength(2);
    expect(ctx.storageDomain.get('dsh_bot')?.table('registry_state').get('bots-workspace')).toEqual({ botsWorkspaceId: final.workspaceId });
  }));

  it('keeps Bot management ready on workspace failure and retries without creating duplicate workspaces',
    async () => withFacility(async ({ start, workspaces, unit }) => {
    const { registry: native } = await workspaces();
    const create = vi.spyOn(native, 'create').mockRejectedValueOnce(new Error('Workspace backend unavailable'));
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    expect(await registry.list()).toHaveLength(1);
    const write = vi.spyOn(unit(), 'putRecord').mockRejectedValueOnce(new Error('Bot storage unavailable'));
    await expect(registry.ensureBotsWorkspace()).rejects.toMatchObject({ code: 'store/unavailable' });
    write.mockRestore();
    expect(native.list()).toHaveLength(1);
    const result = await registry.ensureBotsWorkspace();
    expect(result.workspaceId).toBe(native.list()[0]?.id);
    expect(create).toHaveBeenCalledTimes(2); // failed startup, then one actual create
  }));

  it('ensures a private home under the public DSH home, separately from configured skill data', async () => withFacility(async ({ start, root }) => {
    const { registry, stop } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: root });
    const expected = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await expect(stat(expected)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registry.ensureHome('alpha')).toEqual({ path: expected });
    expect(await registry.ensureHome('alpha')).toEqual({ path: expected });
    expect((await stat(expected)).mode & 0o777).toBe(0o700);
    await expect(registry.ensureHome('missing')).rejects.toMatchObject({ code: 'bot/not-found' });
    await expect(registry.ensureHome('../escape')).rejects.toMatchObject({ code: 'bot/invalid' });
    await stop();
    const restarted = await start();
    expect(await restarted.registry.ensureHome('alpha')).toEqual({ path: expected });
  }));

  it('validates supplied default directories before changing storage or presets', async () => withFacility(async ({ start, root, presets }) => {
    const { registry } = await start();
    const file = join(root, 'plain-file');
    await writeFile(file, 'Not a directory');
    const original = await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: root });
    const calls = [...presets.calls];
    for (const defaultCwd of ['./relative', '', join(root, 'missing'), file]) {
      await expect(registry.create({ id: 'beta', name: 'Beta', defaultCwd })).rejects.toMatchObject({ code: 'bot/invalid' });
      await expect(registry.update('alpha', { defaultCwd })).rejects.toMatchObject({ code: 'bot/invalid' });
    }
    expect(presets.calls).toEqual(calls);
    expect(await registry.get('alpha')).toEqual(original);
    expect(await registry.update('alpha', { defaultCwd: null })).not.toHaveProperty('defaultCwd');
  }));

  it('preserves homes by default and deletes only explicitly requested owned homes, never defaultCwd', async () => withFacility(async ({ start, root }) => {
    const { registry } = await start();
    const user = join(root, 'chosen-directory');
    await mkdir(user); await writeFile(join(user, 'keep.txt'), 'User data');
    await registry.create({ id: 'alpha', name: 'Alpha', defaultCwd: user });
    const home = (await registry.ensureHome('alpha')).path;
    await writeFile(join(home, 'keep.txt'), 'Private data');
    await registry.remove('alpha');
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('Private data');
    await registry.create({ id: 'alpha', name: 'Recreated', defaultCwd: user });
    expect(await registry.ensureHome('alpha')).toEqual({ path: home });
    await registry.remove('alpha', { deleteHome: true, deleteMemories: false });
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(user, 'keep.txt'), 'utf8')).toBe('User data');
  }));

  it('rejects unsafe home cleanup before Bot deletion, while default deletion never touches an unowned home',
    async () => withFacility(async ({ start, root }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = join(root, 'dsh-bot', 'bots', 'alpha', 'home');
    await mkdir(join(home, '..'), { recursive: true });
    const outside = join(root, 'user-directory');
    await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'User data');
    await symlink(outside, home, 'dir');
    await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({ code: 'bot/invalid' });
    expect((await registry.get('alpha')).name).toBe('Alpha');
    await registry.remove('alpha');
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('User data');
    expect((await stat(home)).isDirectory()).toBe(true);
  }));

  it('keeps home data and restores the preset if record deletion fails', async () => withFacility(async ({ start, unit }) => {
    const { registry } = await start();
    const original = await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = (await registry.ensureHome('alpha')).path;
    await writeFile(join(home, 'keep.txt'), 'Preserved');
    const deletion = vi.spyOn(unit(), 'deleteRecord').mockRejectedValueOnce(new Error('Injected deletion failure'));
    try { await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({ code: 'store/unavailable' }); }
    finally { deletion.mockRestore(); }
    expect(await registry.get('alpha')).toEqual(original);
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('Preserved');
  }));

  it('reports committed deletion separately if home ownership changes before cleanup', async () => withFacility(async ({ start, unit }) => {
    const { registry } = await start();
    await registry.create({ id: 'alpha', name: 'Alpha' });
    const home = (await registry.ensureHome('alpha')).path;
    const originalDelete = unit().deleteRecord.bind(unit());
    const deletion = vi.spyOn(unit(), 'deleteRecord').mockImplementationOnce(async (...args) => {
      const result = await originalDelete(...args);
      await rename(home, `${home}-saved`);
      await mkdir(home);
      await writeFile(join(home, 'user.txt'), 'Not our inode');
      return result;
    });
    try {
      await expect(registry.remove('alpha', { deleteHome: true })).rejects.toMatchObject({
        code: 'bot/home-cleanup-failed', message: expect.stringContaining('Bot was deleted'),
      });
    } finally { deletion.mockRestore(); }
    await expect(registry.get('alpha')).rejects.toMatchObject({ code: 'bot/not-found' });
    expect(await readFile(join(home, 'user.txt'), 'utf8')).toBe('Not our inode');
  }));

  it('streams opening and coalesced catalog/activity invalidations, and drains cancelled/Host-disposed watchers',
    async () => withFacility(async ({ start }) => {
    const { registry, stop } = await start();
    const abort = new AbortController();
    const iterator = registry.watch(abort.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 0 } });
    await registry.create({ id: 'alpha', name: 'Alpha' });
    await registry.update('alpha', { name: 'Updated' });
    // Slow readers get the latest invalidation instead of an unbounded queue.
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 2 } });
    const input = { sessionId: 'session-1', botId: 'alpha', role: 'assistant' as const, text: 'Reply', at: 100, seq: 1 };
    await registry.recordActivity(input);
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 3 } });
    await registry.recordActivity(input); // replay does not invalidate
    await registry.markActivityRead('session-1');
    expect(await iterator.next()).toEqual({ done: false, value: { revision: 4 } });
    const pending = iterator.next();
    abort.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    const stopped = new AbortController(); stopped.abort();
    expect(await registry.watch(stopped.signal)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    const next = registry.watch(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await next.next()).toEqual({ done: false, value: { revision: 4 } });
    const waiting = next.next();
    await stop();
    expect(await waiting).toEqual({ done: true, value: undefined });
  }));

  it('validates configurable activity retention limits', () => {
    expect(Config({})).toMatchObject({ activityMaxSessionsPerBot: 50, activityMaxSessionsTotal: 1000 });
    for (const field of ['activityMaxSessionsPerBot', 'activityMaxSessionsTotal']) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => Config({ [field]: value })).toThrow();
      }
      expect(Config({ [field]: 2 })).toHaveProperty(field, 2);
    }
  });

  it('keeps the preset creation identity equal to storage across delayed activation', async () => withFacility(async ({ start, presets }) => {
    const { registry } = await start();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    let generationCreatedAt = 0;
    presets.beforeRegister = async () => {
      generationCreatedAt = registry.presetBot('alpha').createdAt;
      now.mockReturnValue(200);
    };
    try {
      const bot = await registry.create({ id: 'alpha', name: 'Alpha' });
      expect(bot.createdAt).toBe(generationCreatedAt);
      await registry.recordActivity({ sessionId: 'session-1', botId: 'alpha', role: 'assistant',
        text: 'Completed', at: 200, seq: 1, expectedBotCreatedAt: generationCreatedAt });
      expect((await registry.listActivity()).sessions[0]).toMatchObject({ unread: true, lastMessage: { preview: 'Completed' } });
    } finally { now.mockRestore(); }
  }));

  it('rejects old Agent activity after same-id recreation when the clock does not advance', async () => withFacility(async ({ start }) => {
    const { registry } = await start();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      const old = await registry.create({ id: 'alpha', name: 'Old' });
      await registry.remove('alpha');
      now.mockReturnValue(50);
      const current = await registry.create({ id: 'alpha', name: 'New' });
      expect(current.createdAt).toBeGreaterThan(old.createdAt);
      await registry.recordActivity({ sessionId: 'old-session', botId: 'alpha', role: 'assistant', text: 'Late',
        at: 100, seq: 1, expectedBotCreatedAt: old.createdAt });
      expect((await registry.listActivity()).sessions).toEqual([]);
      await registry.recordActivity({ sessionId: 'new-session', botId: 'alpha', role: 'assistant', text: 'Current',
        at: 100, seq: 1, expectedBotCreatedAt: current.createdAt });
      expect((await registry.listActivity()).sessions).toHaveLength(1);
    } finally { now.mockRestore(); }
  }));

});
