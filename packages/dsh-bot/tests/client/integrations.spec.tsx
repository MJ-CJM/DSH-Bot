import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { bot, button, click, field, fill, mountClient, submit } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { connectorSchema, notificationSchema } from '../../src/shared/integrations.js';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
const record = () => notificationSchema.parse({ id: 'note', operationId: 'note', owner: { botId: 'alpha', botCreatedAt: 1 }, policyId: 'local', policyRevision: 1, scopeDigest: 'scope', targetDigest: 'in-app', text: 'Local report survives quiet hours', source: { kind: 'tool', id: 'one', sessionId: 'source-session' }, state: 'recorded', revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 });
describe('P34 management through the public main slot and shared polling catalog', () => {
  it.each(['en','zh'] as const)('%s saves reference-only connector configuration, retains drafts on refresh and exposes exact Bot identity', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language);
    const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['connectors.connectors']));
      await fill(field(app.container, t['integrations.id']), 'connector'); await fill(field(app.container, t['integrations.label']), 'Example connector');
      await fill(field(app.container, t['connectors.url']), 'https://example.test/mcp'); await fill(field(app.container, t['connectors.credentialRef']), 'GITHUB_TOKEN');
      const node = field(app.container, t['integrations.label']);
      const actions = app.main.inject?.() as unknown as BotsPageInjected;
      await act(async () => { await actions.integrations?.catalog.refresh(); });
      expect(field(app.container, t['integrations.label'])).toBe(node); expect(node.value).toBe('Example connector');
      app.remote.connectors.saveDefinition.mockImplementation(async (input, expected) => {
        const saved = connectorSchema.parse({ ...input, revision: expected + 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 });
        app.remote.data.integrations.definitions = [saved]; return { ok: true, value: saved };
      });
      await submit(app.container);
      expect(app.remote.connectors.saveDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: 'connector', url: 'https://example.test/mcp', credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: 'GITHUB_TOKEN', format: 'bearer' }] }), 0);
      expect(JSON.stringify(app.remote.connectors.saveDefinition.mock.calls)).not.toContain('Bearer ');
      app.remote.connectors.saveAssignment.mockResolvedValue({ ok: false, error: new RemoteError('dsh-bot/conflict', 'DSH-Bot: conflict', {}) });
      await click(button(app.container, t['connectors.assign']));
      expect(app.remote.connectors.saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ bot: { botId: 'alpha', botCreatedAt: 1 }, enabled: true }), 0);
      expect(app.container.textContent).toContain(t['integrations.operationFailed']);
      expect(app.container.textContent).toContain(t['connectors.credentialsHint']);
    } finally { await app.dispose(); }
  });
  it.each(['en','zh'] as const)('%s shows local notification, unread whale, unsupported transports and read action', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language, remote => { remote.data.integrations.notifications = [record()]; remote.data.integrations.unread = 1; });
    const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['manage.title']));
      const tab = [...app.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes(t['notifications.notifications'])); if (!tab) throw new Error('Missing notifications tab');
      await vi.waitFor(() => expect(tab.querySelector('svg')).toBeTruthy());
      await click(tab); expect(app.container.textContent).toContain(record().text); expect(app.container.textContent).toContain(t['notifications.recorded']);
      expect([...app.container.querySelectorAll('button')].some(b => b.textContent === t['notifications.desktopUnsupported'])).toBe(false); expect(app.container.textContent).toContain(t['notifications.imUnsupported']);
      expect(app.container.textContent).toContain(t['notifications.scheduleHint']);
      app.remote.notifications.markRead.mockImplementation(async () => { const next = { ...record(), readAt: 2, revision: 2 }; app.remote.data.integrations.notifications = [next]; app.remote.data.integrations.unread = 0; return { ok: true, value: next }; });
      await click(button(app.container, t['notifications.markRead'])); expect(app.remote.notifications.markRead).toHaveBeenCalledWith('note', 1);
      expect(tab.querySelector('svg')).toBeNull();
    } finally { await app.dispose(); }
  });
  it('uses only native credential write/describe, clears password after success, failure and leaving the tab', async () => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })]); const t = en.ui;
    const describe = vi.fn(async () => ({ ok: true, value: { GITHUB_TOKEN: { configured: false, writable: true } } }));
    const set = vi.fn(async (_ref: string, _value: string) => ({ ok: true as boolean, value: undefined, error: new RemoteError('dsh-bot/unavailable', '', {}) }));
    const release = app.ctx.provide('remote.credentials', { describe, set } as never);
    try {
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['connectors.connectors']));
      await fill(field(app.container, t['connectors.credentialRef']), 'GITHUB_TOKEN');
      await click(button(app.container, t['connectors.describeCredential'])); expect(describe).toHaveBeenCalledWith(['GITHUB_TOKEN']);
      const password = field(app.container, t['connectors.secret']) as HTMLInputElement; expect(password.type).toBe('password'); expect(password.value).toBe('');
      await fill(password, 'SYNTHETIC_UI_SECRET'); await click(button(app.container, t['connectors.storeCredential']));
      expect(set).toHaveBeenCalledWith('GITHUB_TOKEN', 'SYNTHETIC_UI_SECRET'); expect(password.value).toBe('');
      expect(app.remote.connectors.saveDefinition).not.toHaveBeenCalled(); expect(JSON.stringify(app.remote.data.integrations)).not.toContain('SYNTHETIC_UI_SECRET');
      set.mockResolvedValue({ ok: false, value: undefined, error: new RemoteError('dsh-bot/unavailable', '', {}) });
      await fill(password, 'SYNTHETIC_UI_FAILURE'); await click(button(app.container, t['connectors.storeCredential'])); expect(password.value).toBe('');
      await fill(password, 'SYNTHETIC_NOT_SUBMITTED'); await click(button(app.container, t['manage.title'])); await click(button(app.container, t['notifications.notifications'])); await click(button(app.container, t['manage.title'])); await click(button(app.container, t['connectors.connectors']));
      expect(field(app.container, t['connectors.secret']).value).toBe('');
    } finally { release(); await app.dispose(); }
  });
  it('keeps only three top-level tabs and retains non-secret DOM/drafts across management sections', async () => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })]); const t = en.ui;
    const release = app.ctx.provide('remote.credentials', { describe: vi.fn(), set: vi.fn() } as never);
    try {
      const top = app.container.querySelector('[role="tablist"]');
      expect([...top?.querySelectorAll('button') ?? []].map(b => b.textContent)).toEqual([t['bots.title'], t['groups.title'], t['manage.title']]);
      expect(app.container.textContent).not.toContain(t['connectors.credentialsHint']);
      await click(button(app.container, t['manage.title']));
      await click(button(app.container, t['connectors.connectors']));
      const input = field(app.container, t['integrations.label']);
      await fill(input, 'Persistent non-secret draft');
      await fill(field(app.container, t['connectors.credentialRef']), 'TOKEN');
      await fill(field(app.container, t['connectors.secret']), 'SYNTHETIC_UNSUBMITTED');
      await click(button(app.container, t['notifications.notifications']));
      await click(button(app.container, t['connectors.connectors']));
      expect(field(app.container, t['integrations.label'])).toBe(input);
      expect(input.value).toBe('Persistent non-secret draft');
      expect(field(app.container, t['connectors.secret']).value).toBe('');
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver(records => mutations.push(...records));
      observer.observe(input.closest('form') as HTMLFormElement, { attributes: true, childList: true, subtree: true, characterData: true });
      const actions = app.main.inject?.() as unknown as BotsPageInjected;
      await act(async () => { await actions.integrations?.catalog.refresh(); });
      observer.disconnect(); expect(mutations).toHaveLength(0);
    } finally { release(); await app.dispose(); }
  });
  it('requires explicit scope confirmation for preapproval and preserves input on conflict', async () => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })]); const t = en.ui;
    try {
      await click(button(app.container, t['manage.title'])); await click(button(app.container, t['notifications.notifications']));
      await fill(field(app.container, t['integrations.id']), 'local');
      await click(field(app.container, t['notifications.preapproved']));
      expect((field(app.container, t['notifications.confirmScope']) as HTMLInputElement).checked).toBe(false);
      await click(field(app.container, t['notifications.confirmScope']));
      app.remote.notifications.savePolicy.mockResolvedValue({ ok: false, error: new RemoteError('dsh-bot/conflict', 'DSH-Bot: conflict', {}) });
      await submit(app.container);
      expect(app.remote.notifications.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ id: 'local', owner: { botId: 'alpha', botCreatedAt: 1 }, authorization: { mode: 'preapproved' }, dailyLimit: 20, cooldownSec: 60 }), 0, true);
      expect(field(app.container, t['integrations.id']).value).toBe('local');
      expect(app.container.textContent).toContain(t['integrations.operationFailed']);
    } finally { await app.dispose(); }
  });
});
