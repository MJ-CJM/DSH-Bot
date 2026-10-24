import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { bot, button, click, field, fill, mountClient, submit } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { connectorSchema, notificationSchema } from '../../src/shared/p34.js';
import type { BotsPageInjected } from '../../src/client/pages/BotsPage.js';
const record = () => notificationSchema.parse({ id: 'note', operationId: 'note', owner: { botId: 'alpha', botCreatedAt: 1 }, policyId: 'local', policyRevision: 1, scopeDigest: 'scope', targetDigest: 'in-app', text: 'Local report survives quiet hours', source: { kind: 'tool', id: 'one', sessionId: 'source-session' }, state: 'recorded', revision: 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 });
describe('P34 management through the public main slot and shared polling catalog', () => {
  it.each(['en','zh'] as const)('%s saves reference-only connector configuration, retains drafts on refresh and exposes exact Bot identity', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language);
    const t = (language === 'en' ? en : zh).ui;
    try {
      await click(button(app.container, t['p34.connectors']));
      await fill(field(app.container, t['p34.id']), 'connector'); await fill(field(app.container, t['p34.label']), 'Example connector');
      await fill(field(app.container, t['p34.url']), 'https://example.test/mcp'); await fill(field(app.container, t['p34.credentialRef']), 'GITHUB_TOKEN');
      const node = field(app.container, t['p34.label']);
      const actions = app.main.inject?.() as unknown as BotsPageInjected;
      await act(async () => { await actions.p34?.catalog.refresh(); });
      expect(field(app.container, t['p34.label'])).toBe(node); expect(node.value).toBe('Example connector');
      app.remote.connectors.saveDefinition.mockImplementation(async (input, expected) => {
        const saved = connectorSchema.parse({ ...input, revision: expected + 1, createdAt: 1, updatedAt: 1, schemaVersion: 1 });
        app.remote.data.p34.definitions = [saved]; return { ok: true, value: saved };
      });
      await submit(app.container);
      expect(app.remote.connectors.saveDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: 'connector', url: 'https://example.test/mcp', credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: 'GITHUB_TOKEN', format: 'bearer' }] }), 0);
      expect(JSON.stringify(app.remote.connectors.saveDefinition.mock.calls)).not.toContain('Bearer ');
      app.remote.connectors.saveAssignment.mockResolvedValue({ ok: false, error: new RemoteError('p34/conflict', 'P34: conflict', {}) });
      await click(button(app.container, t['p34.assign']));
      expect(app.remote.connectors.saveAssignment).toHaveBeenCalledWith(expect.objectContaining({ bot: { botId: 'alpha', botCreatedAt: 1 }, enabled: true }), 0);
      expect(app.container.textContent).toContain(t['p34.operationFailed']);
      expect(app.container.textContent).toContain(t['p34.credentialsHint']);
    } finally { await app.dispose(); }
  });
  it.each(['en','zh'] as const)('%s shows local notification, unread whale, unsupported transports and read action', async language => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })], language, remote => { remote.data.p34.notifications = [record()]; remote.data.p34.unread = 1; });
    const t = (language === 'en' ? en : zh).ui;
    try {
      const tab = [...app.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes(t['p34.notifications'])); if (!tab) throw new Error('Missing notifications tab');
      await vi.waitFor(() => expect(tab.querySelector('svg')).toBeTruthy());
      await click(tab); expect(app.container.textContent).toContain(record().text); expect(app.container.textContent).toContain(t['p34.recorded']);
      expect(button(app.container, t['p34.desktopUnsupported']).disabled).toBe(true); expect(app.container.textContent).toContain(t['p34.imUnsupported']);
      expect(app.container.textContent).toContain(t['p34.scheduleHint']);
      app.remote.notifications.markRead.mockImplementation(async () => { const next = { ...record(), readAt: 2, revision: 2 }; app.remote.data.p34.notifications = [next]; app.remote.data.p34.unread = 0; return { ok: true, value: next }; });
      await click(button(app.container, t['p34.markRead'])); expect(app.remote.notifications.markRead).toHaveBeenCalledWith('note', 1);
      expect(tab.querySelector('svg')).toBeNull();
    } finally { await app.dispose(); }
  });
  it('uses only native credential write/describe, clears password after success, failure and leaving the tab', async () => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })]); const t = en.ui;
    const describe = vi.fn(async () => ({ ok: true, value: { GITHUB_TOKEN: { configured: false, writable: true } } }));
    const set = vi.fn(async (_ref: string, _value: string) => ({ ok: true as boolean, value: undefined, error: new RemoteError('p34/unavailable', '', {}) }));
    const release = app.ctx.provide('remote.credentials', { describe, set } as never);
    try {
      await click(button(app.container, t['p34.connectors']));
      await fill(field(app.container, t['p34.credentialRef']), 'GITHUB_TOKEN');
      await click(button(app.container, t['p34.describeCredential'])); expect(describe).toHaveBeenCalledWith(['GITHUB_TOKEN']);
      const password = field(app.container, t['p34.secret']) as HTMLInputElement; expect(password.type).toBe('password'); expect(password.value).toBe('');
      await fill(password, 'SYNTHETIC_UI_SECRET'); await click(button(app.container, t['p34.storeCredential']));
      expect(set).toHaveBeenCalledWith('GITHUB_TOKEN', 'SYNTHETIC_UI_SECRET'); expect(password.value).toBe('');
      expect(app.remote.connectors.saveDefinition).not.toHaveBeenCalled(); expect(JSON.stringify(app.remote.data.p34)).not.toContain('SYNTHETIC_UI_SECRET');
      set.mockResolvedValue({ ok: false, value: undefined, error: new RemoteError('p34/unavailable', '', {}) });
      await fill(password, 'SYNTHETIC_UI_FAILURE'); await click(button(app.container, t['p34.storeCredential'])); expect(password.value).toBe('');
      await fill(password, 'SYNTHETIC_NOT_SUBMITTED'); await click(button(app.container, t['p34.notifications'])); await click(button(app.container, t['p34.connectors']));
      expect(field(app.container, t['p34.secret']).value).toBe('');
    } finally { release(); await app.dispose(); }
  });
  it('requires explicit scope confirmation for preapproval and preserves input on conflict', async () => {
    const app = await mountClient([bot({ id: 'alpha', name: 'Alpha' })]); const t = en.ui;
    try {
      await click(button(app.container, t['p34.notifications']));
      await fill(field(app.container, t['p34.id']), 'local');
      await click(field(app.container, t['p34.preapproved']));
      expect((field(app.container, t['p34.confirmScope']) as HTMLInputElement).checked).toBe(false);
      await click(field(app.container, t['p34.confirmScope']));
      app.remote.notifications.savePolicy.mockResolvedValue({ ok: false, error: new RemoteError('p34/conflict', 'P34: conflict', {}) });
      await submit(app.container);
      expect(app.remote.notifications.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ id: 'local', owner: { botId: 'alpha', botCreatedAt: 1 }, authorization: { mode: 'preapproved' }, dailyLimit: 20, cooldownSec: 60 }), 0, true);
      expect(field(app.container, t['p34.id']).value).toBe('local');
      expect(app.container.textContent).toContain(t['p34.operationFailed']);
    } finally { await app.dispose(); }
  });
});
