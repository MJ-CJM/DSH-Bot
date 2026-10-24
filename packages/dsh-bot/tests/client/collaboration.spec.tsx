// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { bot, button, click, field, fill, mountClient, submit } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
const link = { id: 'team:alpha', bot: { botId: 'alpha', botCreatedAt: 1 }, nativeTeamId: 'main-alpha', leadSessionId: 'main-alpha', enabled: true, revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 as const };
const task = { id: 'task-1', revision: 1, subject: 'Native task', description: 'Native details', status: 'pending' as const, blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] };
describe('U04/U05 public slot UI', () => {
  it.each(['en','zh'] as const)('%s exposes an explicit unsupported state and disabled IM actions', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language); const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['team.title']));
      await vi.waitFor(() => expect(app.container.textContent).toContain(t['team.unsupported']));
      expect(app.remote.collaboration.ensure).not.toHaveBeenCalled();
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['im.title']));
      expect(button(app.container, t['im.bind']).disabled).toBe(true); expect(button(app.container, t['im.send']).disabled).toBe(true);
      expect(app.container.textContent).toContain(t['im.gateHint']);
    } finally { await app.dispose(); }
  });
  it.each(['en','zh'] as const)('%s links the main, shows native state and keeps draft/DOM on polls and CAS conflict', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language, remote => { remote.data.board = { supported: true, reason: 'not-linked', members: [], tasks: [] }; });
    const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['team.title']));
      app.remote.collaboration.ensure.mockImplementation(async () => {
        app.remote.data.board = { supported: true, link, members: [{ id: 'main-alpha', name: 'lead', role: 'lead', status: 'inactive' }], tasks: [task] }; return { ok: true, value: link };
      });
      await click(button(app.container, t['team.ensure']));
      expect(app.remote.collaboration.ensure).toHaveBeenCalledWith(link.bot, 0);
      await fill(field(app.container, t['team.subject']), 'Keep my draft'); await fill(field(app.container, t['team.description']), 'Keep details');
      const input = field(app.container, t['team.subject']);
      const reads = app.remote.collaboration.board.mock.calls.length;
      input.focus();
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await vi.waitFor(() => expect(app.remote.collaboration.board.mock.calls.length).toBeGreaterThan(reads));
      expect(document.activeElement).toBe(input);
      expect(field(app.container, t['team.subject'])).toBe(input);
      app.remote.collaboration.createTask.mockResolvedValue({ ok: false, error: new RemoteError('p34/conflict', '', {}) });
      await submit(app.container); expect(input.value).toBe('Keep my draft'); expect(app.container.textContent).toContain(t['team.conflict']);
      app.remote.collaboration.updateTask.mockImplementation(async (_key, update) => {
        const next = { ...task, revision: 2, status: update.action === 'claim' ? 'in_progress' as const : 'completed' as const, ownerName: 'lead' };
        app.remote.data.board.tasks = [next]; return { ok: true, value: next };
      });
      await click(button(app.container, t['team.claim'])); expect(app.remote.collaboration.updateTask).toHaveBeenLastCalledWith(link.bot, { taskId: 'task-1', expectedRevision: 1, action: 'claim' });
      await click(button(app.container, t['team.complete'])); expect(app.remote.collaboration.updateTask).toHaveBeenLastCalledWith(link.bot, { taskId: 'task-1', expectedRevision: 2, action: 'complete' });
      expect(app.container.textContent).toContain(t['team.inherits']); expect(input.value).toBe('Keep my draft');
      app.remote.collaboration.createTask.mockResolvedValue({ ok: false, error: new RemoteError('p34/recovery-needed', '', {}) });
      const attempts = app.remote.collaboration.createTask.mock.calls.length;
      await submit(app.container); expect(app.container.textContent).toContain(t['team.recovery']);
      expect(app.remote.collaboration.createTask).toHaveBeenCalledTimes(attempts + 1); expect(input.value).toBe('Keep my draft');
    } finally { await app.dispose(); }
  });
});
