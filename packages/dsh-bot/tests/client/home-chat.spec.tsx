// @vitest-environment jsdom
import { act } from 'react';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, doubleClick, field, fill, mountClient, submit, workspace } from './helpers.js';
function required<T>(value: T | null): T { if (value === null) throw new Error('Missing fixture node'); return value; }
const apps: Awaited<ReturnType<typeof mountClient>>[] = [];
async function mount(language: 'en' | 'zh') {
  const app = await mountClient([bot({ id: 'alpha-bot', name: 'Alpha Bot', defaultCwd: '/old/custom' })], language, undefined, {}, undefined, true);
  apps.push(app); return app;
}
afterEach(async () => { for (const app of apps.splice(0).reverse()) await app.dispose(); });
describe('single main conversation launch', () => {
  for (const language of ['en', 'zh'] as const) for (const surface of ['page', 'footer', 'right'] as const) {
    it(`opens the Host main from ${surface} in ${language}, regardless of cwd/workspaces`, async () => {
      const app = await mount(language); const t = language === 'en' ? en.ui : zh.ui;
      await app.setWorkspaces({ items: [workspace(), workspace('two')] });
      let container = app.container;
      if (surface !== 'page') { await app.unmountPage(); container = surface === 'footer' ? await app.mountSidebar() : await app.mountRightTab(); }
      if (surface === 'footer') await click(button(container, t['sidebar.sessions']));
      const start = surface === 'right' ? required(container.querySelector<HTMLElement>('[role="option"]'))
        : button(container, surface === 'page' ? t['bots.newSession'] : t['sidebar.newSession'].replace('{name}', 'Alpha Bot'));
      if (surface === 'right') await doubleClick(start);
      else await click(start);
      expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('alpha-bot');
      expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
      expect(app.createSession).not.toHaveBeenCalled(); expect(app.createWorkspace).not.toHaveBeenCalled(); expect(app.openWorkspace).not.toHaveBeenCalled();
      expect(container.querySelector('select')).toBeNull();
    });
  }
  it('reports Host refusal and retries the same main endpoint', async () => {
    const app = await mount('en');
    app.remote.methods.openConversation.mockResolvedValueOnce({ ok: false, error: new RemoteError('bot/unavailable', 'Main unavailable', {}) });
    await click(button(app.container, en.ui['bots.newSession']));
    expect(app.openSession).not.toHaveBeenCalled(); expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    await click(button(app.container, en.ui['bots.newSession']));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
  });
  it('ignores late open completion after the page unmounts', async () => {
    const app = await mount('en'); let finish!: () => void;
    app.remote.methods.openConversation.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ ok: true, value: { sessionId: 'late' } });
    }));
    await click(button(app.container, en.ui['bots.newSession']));
    await app.unmountPage(); await act(async () => finish());
    expect(app.openSession).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('allows editing during main-session loading and ignores late %s', async (outcome) => {
    const app = await mount('en');
    let finish!: () => void;
    app.remote.methods.openConversation.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === 'success'
        ? resolve({ ok: true, value: { sessionId: 'late-main' } })
        : reject(new Error('Late migration failure'));
    }));
    await click(button(app.container, en.ui['bots.newSession']));
    expect(button(app.container, en.ui['bots.newSession']).disabled).toBe(true);
    const edit = button(app.container, en.ui['card.edit']);
    expect(edit.disabled).toBe(false);
    await click(edit);
    const dialog = required(app.container.querySelector('dialog'));
    const name = field(dialog, en.ui['editor.name']) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    await fill(name, 'Edited while loading');
    await act(async () => finish());
    expect(app.openSession).not.toHaveBeenCalled();
    expect(app.container.querySelector('dialog')).toBe(dialog);
    expect(name.value).toBe('Edited while loading');
    expect(app.container.textContent).not.toContain('Late migration failure');
    await submit(dialog);
    expect(app.remote.methods.update).toHaveBeenCalledExactlyOnceWith('alpha-bot', expect.objectContaining({ name: 'Edited while loading' }));
    await click(button(app.container, en.ui['bots.newSession']));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('test-created-session');
  });
  it('does not let cancelled navigation completion unlock an in-flight save', async () => {
    const app = await mount('en');
    let finishOpen!: () => void;
    app.remote.methods.openConversation.mockImplementationOnce(() => new Promise(resolve => {
      finishOpen = () => resolve({ ok: true, value: { sessionId: 'late-main' } });
    }));
    await click(button(app.container, en.ui['bots.newSession']));
    await click(button(app.container, en.ui['card.edit']));
    const update = app.remote.methods.update.getMockImplementation();
    let finishSave!: () => void;
    app.remote.methods.update.mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { finishSave = resolve; });
      if (!update) throw new Error('Missing update fixture');
      return update(...args);
    });
    const dialog = required(app.container.querySelector('dialog'));
    await submit(dialog);
    await act(async () => finishOpen());
    expect((field(dialog, en.ui['editor.name']) as HTMLInputElement).disabled).toBe(true);
    expect(app.openSession).not.toHaveBeenCalled();
    await submit(dialog);
    expect(app.remote.methods.update).toHaveBeenCalledTimes(1);
    await act(async () => finishSave());
    expect(app.container.querySelector('dialog')).toBeNull();
  });
  it('keeps edit available while the catalog, preset status and session list load', async () => {
    const app = await mount('en');
    await app.setSessions({ phase: 'pending' });
    let finish!: () => void;
    const list = app.remote.methods.list.getMockImplementation();
    app.remote.methods.list.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (!list) throw new Error('Missing list fixture');
      return list();
    });
    app.remote.data.statuses = [];
    const reads = app.remote.methods.list.mock.calls.length;
    await click(button(app.container, en.ui['bots.refresh']));
    expect(app.remote.methods.list).toHaveBeenCalledTimes(reads + 1);
    expect(button(app.container, en.ui['card.edit']).disabled).toBe(false);
    await click(button(app.container, en.ui['card.edit']));
    const dialog = required(app.container.querySelector('dialog'));
    await fill(field(dialog, en.ui['editor.name']), 'Preserved draft');
    await act(async () => finish());
    expect(app.container.querySelector('dialog')).toBe(dialog);
    expect((field(dialog, en.ui['editor.name']) as HTMLInputElement).value).toBe('Preserved draft');
    expect(button(app.container, en.ui['bots.newSession']).disabled).toBe(true);
    expect(button(app.container, en.ui['card.edit']).disabled).toBe(false);
  });
  it('uses list keyboard selection for management without opening a main conversation', async () => {
    const app = await mount('zh');
    const list = required(app.container.querySelector<HTMLElement>('[role="listbox"]'));
    await act(async () => { list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(app.container.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('data-bot-id')).toBe('alpha-bot');
    expect(app.remote.methods.openConversation).not.toHaveBeenCalled();
    await click(button(app.container, zh.ui['card.edit']));
    expect(app.container.querySelector('dialog')).not.toBeNull();
    expect(app.openSession).not.toHaveBeenCalled();
  });
  it('clicking a Bot row selects details without opening its main conversation', async () => {
    const app = await mount('en'); await click(required(app.container.querySelector<HTMLElement>('[role="option"]')));
    expect(app.remote.methods.openConversation).not.toHaveBeenCalled();
    expect(app.container.querySelector('[data-bot-detail="alpha-bot"]')).not.toBeNull();
  });
});
