// @vitest-environment jsdom
import { act } from 'react';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { bot, button, click, mountClient, workspace } from './helpers.js';
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
      await click(start);
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
    app.remote.methods.openConversation.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true, value: { sessionId: 'late' } }); }));
    await click(button(app.container, en.ui['bots.newSession']));
    await app.unmountPage(); await act(async () => finish());
    expect(app.openSession).not.toHaveBeenCalled();
  });
  it('clicking a Bot row opens its main conversation', async () => {
    const app = await mount('en'); await click(required(app.container.querySelector<HTMLElement>('[role="option"]')));
    expect(app.remote.methods.openConversation).toHaveBeenCalledExactlyOnceWith('alpha-bot');
  });
});
