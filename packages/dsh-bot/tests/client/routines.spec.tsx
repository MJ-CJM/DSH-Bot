import { within } from '@testing-library/dom';
// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { act } from 'react';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { routineRecordSchema, type RunRecord } from '../../src/shared/automation.js';
import { bot, button, click, field, fill, loadBuiltClient, mountClient, submit } from './helpers.js';
const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.dispose(); vi.restoreAllMocks(); });
function routine(botId = 'alpha-bot') {
  return routineRecordSchema.parse({ id: randomUUID(), botId, title: 'Morning review', prompt: 'Review changes', rule: { kind: 'every', everySeconds: 60 }, timeZone: 'UTC', enabled: true, misfirePolicy: 'latest',
    schemaVersion: 1, revision: 1, ruleRevision: 1, botCreatedAt: 1, createdBy: { kind: 'user' }, workspacePolicy: 'bots', anchorAt: 1, createdAt: 1, updatedAt: 1, nextRunAt: Date.now() + 60000 });
}
function run(record: ReturnType<typeof routine>, status: RunRecord['status'] = 'succeeded'): RunRecord {
  return { id: randomUUID(), routineId: record.id, botId: record.botId, status, trigger: 'manual', requestedAt: Date.now(), startedAt: Date.now(), snapshot: { title: record.title, prompt: record.prompt, timeZone: 'UTC', presetId: 'bot-alpha', botUpdatedAt: 1 }, workspaceId: 'workspace', sessionId: 'routine-session', step: 'settled', ...(status === 'skipped' ? { skipReason: 'overlap' } : {}) } as RunRecord;
}
const panel = (app: Awaited<ReturnType<typeof mountClient>>) => app.container.querySelector('[data-routine-panel]') as HTMLElement;
const dialog = (app: Awaited<ReturnType<typeof mountClient>>) => app.container.querySelector('dialog') as HTMLDialogElement;
async function mount(...args: Parameters<typeof mountClient>) { const app = await mountClient(...args); apps.push(app); return app; }
describe('Routine UI through the shipped Client factory and public slots', () => {
  it.each(['en', 'zh'] as const)('shows exact whole interval units without rounding in %s', async language => {
    const intervals = [60, 90, 3600, 7200, 86400];
    const labels = language === 'en'
      ? ['Every 1 minute', 'Every 90 seconds', 'Every 1 hour', 'Every 2 hours', 'Every 1 day']
      : ['每 1 分钟', '每 90 秒', '每 1 小时', '每 2 小时', '每 1 天'];
    const app = await mount([bot()], language, remote => {
      remote.data.routines = intervals.map(everySeconds => ({
        ...routine(), rule: { kind: 'every', everySeconds },
      }));
    }, {}, loadBuiltClient());
    for (const label of labels) expect(panel(app).textContent).toContain(label);
  });
  it.each(['en', 'zh'] as const)('exposes exact dialog and control names for all rule variants in %s', async language => {
    const t = language === 'en' ? en.ui : zh.ui;
    const app = await mount([bot()], language, remote => { remote.data.routines = [routine()]; }, {}, loadBuiltClient());
    for (const mode of ['create', 'edit'] as const) {
      await click(button(panel(app), t[mode === 'create' ? 'routine.create' : 'card.edit']));
      const editor = within(app.container).getByRole('dialog', { name: t[mode === 'create' ? 'routine.create' : 'routine.edit'] });
      const queries = within(editor);
      const control = (key: keyof typeof en.ui, role: 'combobox' | 'textbox' | 'checkbox' | 'spinbutton') => {
        const labelMatch = queries.getByLabelText(t[key], { exact: true });
        expect(queries.getByRole(role, { name: t[key] })).toBe(labelMatch);
        expect(labelMatch.id).not.toBe('');
        const label = [...editor.querySelectorAll('label')].find(label => label.htmlFor === labelMatch.id);
        expect(label?.control).toBe(labelMatch);
        expect(label?.textContent).toBe(t[key]);
        return labelMatch as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      };
      const select = control('routine.rule', 'combobox');
      expect(select).toBeInstanceOf(HTMLSelectElement);
      control('routine.bot', 'combobox'); control('routine.policy', 'combobox');
      control('routine.name', 'textbox'); control('routine.prompt', 'textbox');
      control('routine.timeZone', 'textbox'); control('routine.enabled', 'checkbox');
      for (const kind of ['every', 'daily', 'weekly', 'at', 'cron']) {
        await fill(select, kind);
        expect(queries.getByRole('combobox', { name: t['routine.rule'] })).toBe(select);
        if (kind === 'every') control('routine.seconds', 'spinbutton');
        if (kind === 'at') control('routine.at', 'textbox');
        if (kind === 'cron') control('routine.cron', 'textbox');
        if (kind === 'daily' || kind === 'weekly') control('routine.time', 'textbox');
        if (kind === 'weekly') for (const day of [1, 2, 3, 4, 5, 6, 7]) control(`routine.day.${day}` as 'routine.day.1', 'checkbox');
      }
      const ids = [...app.container.querySelectorAll('[id]')].map(node => node.id);
      expect(new Set(ids).size).toBe(ids.length);
      await click(queries.getByRole('button', { name: t['actions.close'] }));
    }
  });

  it.each(['en', 'zh'] as const)('shows Bot-scoped data, overview, status, skip reason and session navigation in %s', async language => {
    const t = language === 'en' ? en.ui : zh.ui; const record = routine();
    const app = await mount([bot(), bot({ id: 'beta-bot', name: 'Beta' })], language, remote => {
      remote.data.routines = [record, { ...routine('beta-bot'), title: 'Other Bot task' }];
      remote.data.runs = [run(record), { ...run(record, 'skipped'), workspaceId: undefined }];
    }, {}, loadBuiltClient());
    expect(panel(app).textContent).toContain(record.title); expect(panel(app).textContent).not.toContain('Other Bot task');
    expect(panel(app).textContent).toContain(t['routine.status.succeeded']);
    await click(button(panel(app), t['routine.history']));
    expect(panel(app).textContent).toContain(t['routine.reason.overlap']);
    expect(panel(app).querySelectorAll('[data-routine-history] button').length).toBe(2);
    await click(button(panel(app), t['routine.openSession'])); expect(app.openSession).toHaveBeenCalledWith('routine-session');
    const tab = app.container.querySelectorAll<HTMLElement>('[role="tab"]')[1];
    if (!tab) throw new Error('Missing overview tab');
    await click(tab);
    expect(panel(app).getAttribute('data-routine-panel')).toBe('overview'); expect(panel(app).textContent).toContain('Other Bot task');
    expect(app.core.entries('sidebar.panellist')).toHaveLength(1);
  });
  it('validates every >=60, creates through Remote and retains drafts on CAS conflict', async () => {
    const record = routine(); const app = await mount([bot()], 'en', remote => {
      remote.data.routines = [record];
      remote.routine.create.mockImplementation(async input => ({ ok: true, value: { ...record, ...input } }));
    });
    await click(button(panel(app), en.ui['routine.create']));
    await fill(field(dialog(app), en.ui['routine.name']), 'New title'); await fill(field(dialog(app), en.ui['routine.prompt']), 'New task');
    await fill(field(dialog(app), en.ui['routine.rule']), 'every'); await fill(field(dialog(app), en.ui['routine.seconds']), '59');
    await submit(dialog(app)); expect(app.remote.routine.create).not.toHaveBeenCalled();
    await fill(field(dialog(app), en.ui['routine.seconds']), '60'); await submit(dialog(app));
    expect(app.remote.routine.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'New title', rule: { kind: 'every', everySeconds: 60 } }));
    await click(button(panel(app), en.ui['card.edit'])); await fill(field(dialog(app), en.ui['routine.name']), 'Draft title');
    app.remote.data.routines = [{ ...record, revision: 2 }];
    await submit(dialog(app)); expect(dialog(app).textContent).toContain(en.ui['routine.conflict']);
    expect(field(dialog(app), en.ui['routine.name']).value).toBe('Draft title');
    expect(app.remote.routine.update).toHaveBeenCalledWith(record.id, expect.objectContaining({ title: 'Draft title' }), 1);
  });
  it.each(['at', 'daily', 'weekly', 'cron'] as const)('submits the %s editor rule with an explicit time zone', async kind => {
    const record = routine(); const app = await mount([bot()], 'en', remote => {
      remote.routine.create.mockImplementation(async input => ({ ok: true, value: { ...record, ...input } }));
    });
    await click(button(panel(app), en.ui['routine.create']));
    await fill(field(dialog(app), en.ui['routine.name']), 'Rule test');
    await fill(field(dialog(app), en.ui['routine.prompt']), 'Task');
    await fill(field(dialog(app), en.ui['routine.timeZone']), 'Asia/Shanghai');
    await fill(field(dialog(app), en.ui['routine.rule']), kind);
    if (kind === 'at') {
      await fill(field(dialog(app), en.ui['routine.at']), '2099-01-01T09:00:00');
      await submit(dialog(app)); expect(app.remote.routine.create).not.toHaveBeenCalled();
      await fill(field(dialog(app), en.ui['routine.at']), '2099-01-01T09:00:00+08:00');
    }
    if (kind === 'daily' || kind === 'weekly') await fill(field(dialog(app), en.ui['routine.time']), '10:30');
    await submit(dialog(app));
    const expected = kind === 'at' ? { kind, at: Date.parse('2099-01-01T09:00:00+08:00') }
      : kind === 'cron' ? { kind, expression: '0 9 * * 1-5' }
        : kind === 'daily' ? { kind, time: '10:30:00' } : { kind, time: '10:30:00', weekdays: [1] };
    expect(app.remote.routine.create).toHaveBeenCalledWith(expect.objectContaining({ rule: expected, timeZone: 'Asia/Shanghai' }));
  });
  it('confirms delete/run, blocks double click, retains operation ID on ambiguous failure and allows paused runs', async () => {
    const record = { ...routine(), enabled: false, nextRunAt: undefined }; const result = run(record);
    const app = await mount([bot()], 'en', remote => { remote.data.routines = [record];
      remote.routine.runNow.mockResolvedValueOnce({ ok: false, error: new RemoteError('automation/unavailable', '', {}) }).mockResolvedValue({ ok: true, value: result });
      remote.routine.delete.mockImplementation(async () => { remote.data.routines = []; return { ok: true, value: record }; });
    });
    await click(button(panel(app), en.ui['routine.runNow'])); expect(app.remote.routine.runNow).not.toHaveBeenCalled();
    await click(button(dialog(app), en.ui['routine.confirm'])); const operation = app.remote.routine.runNow.mock.calls[0]?.[1];
    await act(async () => { button(dialog(app), en.ui['routine.confirm']).click(); button(dialog(app), en.ui['routine.confirm']).click(); });
    expect(app.remote.routine.runNow).toHaveBeenCalledTimes(2); expect(app.remote.routine.runNow.mock.calls[1]?.[1]).toBe(operation);
    expect(panel(app).textContent).toContain(en.ui['routine.accepted']);
    await click(button(panel(app), en.ui['actions.delete'])); expect(app.remote.routine.delete).not.toHaveBeenCalled();
    await click(button(dialog(app), en.ui['routine.confirm'])); expect(app.remote.routine.delete).toHaveBeenCalledWith(record.id, 1);
    expect(panel(app).textContent).toContain(en.ui['routine.empty']);
  });
  it('renders owner read-only and failed transport separately from empty; disables writes', async () => {
    const app = await mount([bot()], 'en', remote => { remote.automation.status.mockResolvedValue({ ok: true, value: { state: 'read_only' } }); });
    expect(panel(app).textContent).toContain(en.ui['routine.readOnly']); expect(button(panel(app), en.ui['routine.create']).disabled).toBe(true);
    app.remote.automation.status.mockResolvedValue({ ok: false, error: new RemoteError('automation/unavailable', '', {}) });
    await click(button(panel(app), en.ui['bots.refresh'])); expect(panel(app).textContent).toContain(en.ui['routine.error']);
    expect(panel(app).textContent).not.toContain(en.ui['routine.empty']);
  });
});
