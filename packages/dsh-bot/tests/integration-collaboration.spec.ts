import { describe, expect, it, vi } from 'vitest';
import { withIntegrations, alpha } from './integration-support.js';
import { Collaboration, collaborationDomain } from '../src/host/collaboration/service.js';
import { getBotBinding } from '../src/host/bot-context.js';
import { collaborationSpec } from '../src/shared/collaboration-contract.js';
import type { SessionId } from '@deepseek-ai/dsh-session';
vi.mock('../src/host/bot-context.js', () => ({ getBotBinding: vi.fn() }));
async function setup(f: Parameters<Parameters<typeof withIntegrations>[0]>[0]) {
  const { agent } = f.createAgent('main-alpha');
  vi.mocked(getBotBinding).mockReturnValue(alpha);
  const open = vi.fn(async () => ({ sessionId: agent.id }));
  Object.assign(f.registry, { openConversation: open, mainSessions: { find: vi.fn(async () => ({ sessionId: agent.id })) } });
  const resolve = vi.fn(async () => ({ agent })); const flush = vi.fn(async () => true);
  f.ctx.provide('agents', { get: id => id === agent.id ? agent : undefined } as typeof f.ctx.agents);
  f.ctx.provide('sessionController', { resolveAgent: resolve } as unknown as typeof f.ctx.sessionController);
  f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  const task = { id: 'task-1', revision: 2, subject: 'Task', description: 'Details', status: 'in_progress', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] };
  const native = { membership: vi.fn(() => ({ root: agent, id: agent.id, role: 'lead' })), listMembers: vi.fn(() => []), listTasks: vi.fn(() => []), createTask: vi.fn(async () => task), updateTask: vi.fn(async (_agent: typeof agent, _input: unknown) => task) };
  let off: (() => void) | undefined;
  const enable = () => { off = f.ctx.provide('agentTeams', native as unknown as typeof f.ctx.agentTeams); };
  let domain = await f.ctx.storageDomain.open(collaborationDomain);
  const service = () => new Collaboration(f.ctx, f.registry, domain, () => {});
  let collaboration = service();
  return { agent, open, resolve, flush, native, enable, get current() { return collaboration; },
    async reopen() { await collaboration.close(); domain = await f.ctx.storageDomain.open(collaborationDomain); collaboration = service(); },
    disable() { off?.(); off = undefined; }, async close() { await collaboration.close(); off?.(); } };
}
describe('U05 identity links and public native-service boundary (Agent/Controller fixtures)', () => {
  it('does not create a main Session during reads or while the optional native service is absent', () => withIntegrations(async f => {
    const s = await setup(f); try {
      expect(await s.current.board(alpha)).toMatchObject({ supported: false, reason: 'native-service-missing' });
      await expect(s.current.ensure(alpha, 0)).rejects.toMatchObject({ code: 'dsh-bot/unavailable' }); expect(s.open).not.toHaveBeenCalled();
      s.enable(); expect(await s.current.board(alpha)).toMatchObject({ supported: true, reason: 'not-linked' }); expect(s.open).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }));
  it('persists only the native link, uses CAS for creation and reopens without duplicating the main', () => withIntegrations(async f => {
    const s = await setup(f); s.enable(); try {
      const raced = await Promise.allSettled([s.current.ensure(alpha, 0), s.current.ensure(alpha, 0)]);
      expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(s.open).toHaveBeenCalledTimes(1);
      const before = await s.current.board(alpha); await s.reopen(); const after = await s.current.board(alpha);
      expect(after.link).toEqual(before.link); expect(after.tasks).toEqual([]); expect(s.open).toHaveBeenCalledTimes(1);
      s.disable(); expect(await s.current.board(alpha)).toMatchObject({ supported: false });
    } finally { await s.close(); }
  }));
  it('rejects stale birthdays, changed main mappings and a forged live Bot binding', () => withIntegrations(async f => {
    const s = await setup(f); s.enable(); try {
      await s.current.ensure(alpha, 0);
      vi.mocked(getBotBinding).mockReturnValue({ botId: 'beta', botCreatedAt: 1 });
      await expect(s.current.updateTask(alpha, { taskId: 'task-1', expectedRevision: 1, action: 'claim' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      expect(s.native.updateTask).not.toHaveBeenCalled(); vi.mocked(getBotBinding).mockReturnValue(alpha);
      if (!f.registry.mainSessions) throw new Error('No fixture main sessions');
      vi.mocked(f.registry.mainSessions.find).mockResolvedValue({ sessionId: 'different-main' });
      await expect(s.current.board(alpha)).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      await expect(s.current.ensure({ ...alpha, botCreatedAt: 2 }, 0)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    } finally { await s.close(); }
  }));
  it('checks identity again after asynchronous native resolve and never calls a stale Agent', () => withIntegrations(async f => {
    const s = await setup(f); s.enable(); try {
      await s.current.ensure(alpha, 0);
      s.resolve.mockImplementation(async () => { const bot = f.bots.get('alpha'); if (!bot) throw new Error('No fixture Bot'); f.bots.set('alpha', { ...bot, createdAt: 2 }); return { agent: s.agent }; });
      await expect(s.current.updateTask(alpha, { taskId: 'task-1', expectedRevision: 1, action: 'claim' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      expect(s.native.updateTask).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }));
  it('maps native conflicts safely, preserves uncertain flush outcomes and rejects calls after close', () => withIntegrations(async f => {
    const s = await setup(f); s.enable(); try {
      await s.current.ensure(alpha, 0);
      s.native.updateTask.mockRejectedValueOnce(Object.assign(new Error('sensitive native failure'), { code: 'TEAM_TASK_STALE_REVISION' }));
      await expect(s.current.updateTask(alpha, { taskId: 'task-1', expectedRevision: 1, action: 'claim' })).rejects.toMatchObject({ code: 'dsh-bot/conflict', message: 'DSH-Bot: conflict' });
      s.flush.mockResolvedValueOnce(false);
      await expect(s.current.createTask(alpha, { subject: 'Task', description: 'Details' })).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      expect(s.native.createTask).toHaveBeenCalledTimes(1);
      expect(s.native.updateTask.mock.calls[0]?.[0]).toBe(s.agent);
      expect(s.agent.id).toBe('main-alpha' as SessionId);
      await s.close(); await expect(s.current.board(alpha)).rejects.toMatchObject({ code: 'dsh-bot/unavailable' });
    } finally { await s.close(); }
  }));
  it('strict codecs prohibit independent Bot presets, arbitrary claimant IDs and unsupported actions', () => {
    const methods = collaborationSpec.methods;
    expect(() => methods['dshBot.collaboration/createTask'].parameters[1].codec.decode({ subject: 'T', description: 'D', agentPreset: 'bot-beta' })).toThrow();
    for (const input of [{ taskId: 'x', expectedRevision: 1, action: 'reassign' }, { taskId: 'x', expectedRevision: 1, action: 'claim', agentId: 'beta' }]) expect(() => methods['dshBot.collaboration/updateTask'].parameters[1].codec.decode(input)).toThrow();
  });
});
