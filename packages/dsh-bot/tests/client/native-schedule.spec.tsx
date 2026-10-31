import { openSettings } from './bot-ui-helpers.js';
// @vitest-environment jsdom
import en from '../../locale/en.json' with { type: 'json' };
import zh from '../../locale/zh.json' with { type: 'json' };
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { NativeTask } from '../../src/client/automation-state.js';
import { createRoutineActions } from '../../src/client/automation-state.js';
import { bot, button, click, field, fill, mountClient } from './helpers.js';
const task = (id = 'schedule-test'): NativeTask => ({ id: id as NativeTask['id'], nativeScheduleId: id, sessionId: 'session-test' as NativeTask['sessionId'],
  botId: 'alpha', botCreatedAt: 1, kind: 'every', title: 'Native example', prompt: 'Full native instruction', everySeconds: 3600,
  status: 'active', scheduledAt: '2027-01-01T00:00:00.000Z' });
describe('R02 shipped native task Client', () => {
  it('keeps identical snapshots and refreshes on native changed/reset; forwards complete native expected and deletion', async () => {
    const app = await mountClient();
    const actions = createRoutineActions(app.ctx, { pollIntervalMs: 60000 });
    app.remote.data.routines = [task()];
    const off = actions.catalog.subscribe(() => {});
    try {
      await actions.catalog.refresh(); const initial = actions.catalog.getSnapshot();
      const notify = vi.fn(); const observer = actions.catalog.observe(notify);
      await actions.catalog.refresh(); expect(actions.catalog.getSnapshot()).toBe(initial); expect(notify).not.toHaveBeenCalled(); observer();
      app.remote.data.routines = [{ ...task(), title: 'External change' }];
      await act(async () => { app.ctx.emit('schedule/changed'); });
      await vi.waitFor(() => expect(actions.catalog.getSnapshot().routines[0]?.title).toBe('External change'));
      app.remote.data.routines = [{ ...task(), title: 'Reconnect change' }];
      await act(async () => { app.ctx.emit('connection/reset'); });
      await vi.waitFor(() => expect(actions.catalog.getSnapshot().routines[0]?.title).toBe('Reconnect change'));
      const current = actions.catalog.getSnapshot().routines[0]; if (!current) throw new Error('Missing task');
      await actions.update(current, { title: 'Edited' });
      const request = app.remote.schedule.update.mock.calls[0]?.[0];
      expect(request?.expected).toEqual({ id: current.id, kind: 'every', title: current.title, prompt: current.prompt, everySeconds: 3600, scheduledAt: current.scheduledAt });
      expect(request).not.toHaveProperty('change');
      await actions.remove(current); expect(actions.catalog.getSnapshot().routines).toEqual([]);
    } finally { off(); actions.catalog.dispose(); await app.dispose(); }
  });
  it('reuses the Host mounted native namespace and leaves it mounted on unload', async () => {
    const app = await mountClient();
    try {
      await app.unloadPlugin();
      const release = app.ctx.provide('remote.schedule', app.remote.schedule);
      app.mountRemote.mockClear();
      await app.reloadPlugin();
      expect(app.mountRemote.mock.calls.map(call => call[0]?.package)).not.toContain('@deepseek-ai/dsh-schedule');
      await app.unloadPlugin();
      expect(app.ctx.get('remote.schedule')).toBe(app.remote.schedule);
      await release();
    } finally { await app.dispose(); }
  });
  it.each(['en','zh'] as const)('%s shows delivery semantics and confirms manual execution; no retired pause/create controls', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language);
    try {
      app.remote.data.routines = [task()];
      await act(async () => { app.ctx.emit('schedule/changed'); });
      const t = (language === 'zh' ? zh : en).ui;
      await openSettings(app, t === zh.ui ? 'zh' : 'en'); await click(button(app.container, t['routine.title']));
      await vi.waitFor(() => expect(app.container.textContent).toContain('Native example'));
      const panel = app.container.querySelector('[data-routine-panel="overview"]'); if (!panel) throw new Error('Missing panel');
      expect(panel.textContent).not.toContain(language === 'zh' ? '暂停' : 'Pause'); expect(panel.textContent).not.toContain(t['routine.create']);
      await click(button(panel, t['routine.history']));
      expect(panel.textContent).toContain(t['native.deliveryHint']);
      await click(button(panel, t['routine.runNow']));
      expect(app.remote.routine.runNow).not.toHaveBeenCalled();
      const dialog = document.querySelector('dialog'); if (!dialog) throw new Error('Missing dialog');
      expect(dialog.textContent).toContain('Full native instruction');
      app.remote.routine.runNow.mockResolvedValue({ ok: true, value: { status: 'delivered' } as never });
      await click(button(dialog, t['routine.confirm']));
      expect(app.remote.routine.runNow).toHaveBeenCalledWith('schedule-test', expect.any(String),
        { title: 'Native example', prompt: 'Full native instruction', botCreatedAt: 1 }, true);
      await click(button(panel, t['card.edit']));
      const editor = document.querySelector('dialog'); if (!editor) throw new Error('Missing editor');
      await fill(field(editor, t['routine.name']), 'New title');
      await act(async () => { editor.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(app.remote.schedule.update.mock.calls.at(-1)?.[0]).toMatchObject({ title: 'New title', prompt: 'Full native instruction' });
    } finally { await app.dispose(); }
  });
});
