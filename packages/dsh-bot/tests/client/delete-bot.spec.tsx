import { requireValue } from './test-required.js';
import { refreshBots } from './bot-ui-helpers.js';
// @vitest-environment jsdom
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import additions from '../../../../docs/implementation/workspace-delete-locales.json';
import { bot, button, click, field, mountClient } from './helpers.js';
Object.assign(en.ui, additions.en); Object.assign(zh.ui, additions.zh);
const mounted: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(...args: Parameters<typeof mountClient>) { const app = await mountClient(...args); mounted.push(app); return app; }
afterEach(async () => { for (const app of mounted.splice(0)) await app.dispose(); });
function summary(running: boolean): SessionSummary {
  return { id: 'active-main' as SessionSummary['id'], title: 'Alpha Bot', displayTitle: 'Alpha Bot', updatedAt: 1, running, blank: false,
    retainedBy: {}, projectionValues: { agentPreset: 'host-selected/alpha-bot' } };
}
describe('discoverable Bot deletion with the existing confirmation and Host method', () => {
  it.each(['en', 'zh'] as const)('opens deletion from More, preserves by cancel, deletes selected and retains the next Bot (%s)', async language => {
    const t = language === 'en' ? en.ui : zh.ui;
    const app = await mount([{ ...bot(), createdAt: 13, updatedAt: 29 }, bot({ id: 'beta-bot', name: 'Beta Bot' })], language);
    const detail = app.container.querySelector('li') as HTMLElement;
    await click(requireValue(detail.querySelector('summary')));
    await click(button(detail, t['actions.delete']));
    let dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.textContent).toContain(additions[language]['delete.workspaceRetained']);
    expect(app.remote.methods.delete).not.toHaveBeenCalled();
    await click(button(dialog, t['actions.cancel'])); expect(app.remote.methods.delete).not.toHaveBeenCalled();
    await click(button(detail, t['actions.delete'])); dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    await click(field(dialog, t['delete.memories'])); await click(field(dialog, t['delete.home']));
    await click(button(dialog, t['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledExactlyOnceWith('alpha-bot', { deleteMemories: false, deleteHome: true, expectedCreatedAt: 13, expectedUpdatedAt: 29 });
    expect(app.container.querySelector('li > [data-bot-id="beta-bot"]')).not.toBeNull();
    expect(app.createSession).not.toHaveBeenCalled();
  });
  it('retains confirmation and chosen options on a Host conflict, displays the failure inside the dialog, and retries', async () => {
    const app = await mount([bot()]); await click(button(app.container, en.ui['actions.delete']));
    const dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    await click(field(dialog, en.ui['delete.memories']));
    app.remote.methods.delete.mockResolvedValueOnce({ ok: false, error: new RemoteError('bot/conflict', 'Synthetic conflict', {}) });
    await click(button(dialog, en.ui['actions.delete']));
    expect(dialog.isConnected).toBe(true); expect(dialog.querySelector('[role=alert]')?.textContent).toContain('Synthetic conflict');
    expect((field(dialog, en.ui['delete.memories']) as HTMLInputElement).checked).toBe(false);
    await click(button(dialog, en.ui['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledTimes(2); expect(app.container.querySelector('dialog')).toBeNull();
  });
  it('handles a committed delete with home-cleanup failure by clearing the removed selection and reporting remaining files', async () => {
    const app = await mount([bot()]); await click(button(app.container, en.ui['actions.delete']));
    const dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    await click(field(dialog, en.ui['delete.home']));
    app.remote.methods.delete.mockImplementationOnce(async id => {
      app.remote.data.records = app.remote.data.records.filter(record => record.id !== id);
      return { ok: false, error: new RemoteError('bot/home-cleanup-failed', 'Synthetic owned-home failure', {}) };
    });
    await click(button(dialog, en.ui['actions.delete']));
    expect(app.container.querySelector('dialog')).toBeNull(); expect(app.container.querySelector('[data-bot-detail]')).toBeNull();
    expect(app.container.textContent).toContain(en.ui['delete.homeCleanupFailed']);
  });
  it('invalidates a confirmation when a different Bot incarnation arrives under the same ID', async () => {
    const app = await mount([bot()]); await click(button(app.container, en.ui['actions.delete']));
    app.remote.data.records = app.remote.data.records.map(record => ({ ...record, createdAt: record.createdAt + 1 }));
    await refreshBots(app);
    const dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    expect(button(dialog, en.ui['actions.delete']).disabled).toBe(true);
    expect(dialog.textContent).toContain(additions.en['delete.changed']); expect(app.remote.methods.delete).not.toHaveBeenCalled();
  });
  it('blocks deletion of a known running main until it stops and retains the existing conversation', async () => {
    const running = summary(true);
    const app = await mount([bot()], 'en', remote => { remote.data.sessionRows = [running]; }, {}, undefined, false, { ids: [running.id], byId: { [running.id]: running } });
    await click(button(app.container, en.ui['actions.delete'])); let dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    expect(button(dialog, en.ui['actions.delete']).disabled).toBe(true); expect(dialog.textContent).toContain(additions.en['delete.running']);
    await app.setSessions({ ids: [running.id], byId: { [running.id]: summary(false) } });
    dialog = app.container.querySelector('dialog') as HTMLDialogElement;
    expect(button(dialog, en.ui['actions.delete']).disabled).toBe(false);
    await click(button(dialog, en.ui['actions.delete']));
    expect(app.remote.methods.delete).toHaveBeenCalledOnce(); expect(app.openSession).not.toHaveBeenCalled();
  });
});
