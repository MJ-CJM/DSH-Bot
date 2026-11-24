// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { createSupergroupSettingsSource, SupergroupSettings, type SupergroupSettingsActions } from '../../src/client/supergroup.js';
import { click, mountClient, button } from './helpers.js';
import { requireValue } from './test-required.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

async function fixture(language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let enabled = false;
  const actions = { settings: vi.fn(async () => ({ enabled })),
    configure: vi.fn(async input => { enabled = input.enabled; return { enabled }; }) } satisfies SupergroupSettingsActions;
  const t = ((key: keyof typeof en.ui) => (language === 'en' ? en : zh).ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  const source = createSupergroupSettingsSource(actions);
  await act(async () => root.render(<SupergroupSettings source={source} t={t} />));
  return { actions, element, t,
    toggle: () => element.querySelector<HTMLButtonElement>('[role="switch"]') as HTMLButtonElement,
    close: async () => { await act(async () => root.unmount()); element.remove(); },
  };
}

it.each(['en', 'zh'] as const)('%s shows the automatic collaboration switch and submits exact expected value before displaying confirmed state', async language => {
  const f = await fixture(language);
  try {
    await vi.waitFor(() => expect(f.toggle().disabled).toBe(false));
    expect(f.toggle().getAttribute('aria-label')).toBe(f.t('supergroup.settingsTitle'));
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
    expect(f.element.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(f.element.textContent).toContain(f.t('supergroup.settingsScope'));
    expect(f.element.textContent).toContain(f.t('supergroup.settingsPermissions'));
    expect(f.element.textContent).toContain(f.t('supergroup.settingsReturn'));
    await click(f.toggle());
    expect(f.actions.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedEnabled: false });
    expect(f.toggle().getAttribute('aria-checked')).toBe('true');
    await click(f.toggle());
    expect(f.actions.configure).toHaveBeenLastCalledWith({ enabled: false, expectedEnabled: true });
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
  } finally { await f.close(); }
});

it('keeps last accepted state and blocks duplicate saves while a response is pending; failed save offers an explicit read', async () => {
  const f = await fixture();
  try {
    let reject: ((reason: unknown) => void) | undefined;
    f.actions.configure.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    await click(f.toggle()); await click(f.toggle());
    expect(f.actions.configure).toHaveBeenCalledTimes(1);
    expect(f.toggle().disabled).toBe(true);
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
    await act(async () => reject?.(new Error('Unconfirmed save')));
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
    expect(f.element.querySelector('[role="alert"]')?.textContent).toBe(f.t('supergroup.settingsFailed'));
    expect(f.toggle().disabled).toBe(true);
    f.actions.settings.mockResolvedValue({ enabled: true });
    await click(button(f.element, f.t('bots.refresh')));
    expect(f.toggle().getAttribute('aria-checked')).toBe('true');
    expect(f.actions.configure).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('registers the visible native bundle page under its exact package key and releases it on unload', async () => {
  const app = await mountClient();
  const page = await app.mountEntry('plugins.bundle.config', options => options.key === 'dsh-botgroup', { view: 'page' });
  try {
    expect(app.core.entries('plugins.bundle.config')).toHaveLength(1);
    const toggle = page.container.querySelector<HTMLButtonElement>('[role="switch"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    const inBots = requireValue(app.container.querySelector<HTMLButtonElement>('button[data-supergroup-disclosure]'));
    expect(inBots.textContent).toContain('Off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(inBots.textContent).toContain('On');
    expect(app.ctx.get('remote.dshBotSupergroup')?.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedEnabled: false });
    for (const seat of ['sidebar', 'main.conversation', 'shell.leading'] as const) expect(app.core.entries(seat)).toHaveLength(0);
    expect(app.core.entries('sidebar.panellist')).toHaveLength(1);
    expect(app.core.entries('sidebar.footer.action')).toHaveLength(1);
    await app.unloadPlugin();
    expect(app.core.entries('plugins.bundle.config')).toHaveLength(0);
    expect(app.ctx.get('remote.dshBotSupergroup')).toBeUndefined();
  } finally { await page.unmount(); await app.dispose(); }
});

it.each([
  ['en', 'Off', 'On'],
  ['zh', '已关闭', '已开启'],
] as const)('%s manages the confirmed setting in My Bots without navigating or writing on expand', async (language, off, on) => {
  const app = await mountClient([], language);
  const disclosure = () => requireValue(app.container.querySelector<HTMLButtonElement>('button[data-supergroup-disclosure]'));
  const switchInBots = () => app.container.querySelector<HTMLButtonElement>('[data-supergroup-settings] [role="switch"]');
  const remote = requireValue(app.ctx.get('remote.dshBotSupergroup'));
  try {
    await vi.waitFor(() => expect(disclosure().textContent).toContain(off));
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(switchInBots()).toBeNull();
    await click(disclosure());
    expect(disclosure().getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => expect(requireValue(switchInBots()).disabled).toBe(false));
    expect(remote.configure).not.toHaveBeenCalled();
    await click(requireValue(switchInBots()));
    await vi.waitFor(() => expect(disclosure().textContent).toContain(on));
    expect(remote.configure).toHaveBeenCalledExactlyOnceWith({ enabled: true, expectedEnabled: false });
    await click(disclosure());
    expect(switchInBots()).toBeNull();
    expect(disclosure().textContent).toContain(on);
    expect(app.selectPanel).not.toHaveBeenCalledWith('plugins');
  } finally { await app.dispose(); }
});

it('shows an unconfirmed status after a failed inline read and recovers without writing the setting', async () => {
  const app = await mountClient();
  const disclosure = requireValue(app.container.querySelector<HTMLButtonElement>('button[data-supergroup-disclosure]'));
  const remote = requireValue(app.ctx.get('remote.dshBotSupergroup'));
  try {
    await vi.waitFor(() => expect(disclosure.textContent).toContain(en.ui['supergroup.stateOff']));
    vi.mocked(remote.settings).mockRejectedValueOnce(new Error('Host unavailable'));
    await click(disclosure);
    await vi.waitFor(() => expect(disclosure.textContent).toContain(en.ui['supergroup.stateUnknown']));
    const panel = requireValue(app.container.querySelector<HTMLElement>('[data-supergroup-settings]'));
    const toggle = requireValue(panel.querySelector<HTMLButtonElement>('[role="switch"]'));
    expect(toggle.disabled).toBe(true);
    vi.mocked(remote.settings).mockResolvedValueOnce({ ok: true, value: { enabled: true } });
    await click(button(panel, en.ui['bots.refresh']));
    expect(disclosure.textContent).toContain(en.ui['supergroup.stateOn']);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(remote.configure).not.toHaveBeenCalled();
  } finally { await app.dispose(); }
});
