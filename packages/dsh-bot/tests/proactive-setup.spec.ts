import { expect, test, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { persistScopedBootstrap, setupProactive } from '../src/host/proactive/setup.js';
import type { ProactiveBootstrapToken, ProactiveConfig } from '../src/host/proactive/config.js';
import { proactiveSetupRequest } from '../src/shared/proactive/setup.js';

function fixture(raw: Record<string, unknown> = {}) {
  const entry = { options: { name: 'dsh-botgroup', config: raw } };
  const update = vi.fn(async (_id: string, options: { config: unknown }) => { Object.assign(entry.options, options); });
  const describe = vi.fn(async () => ({ configured: true }));
  const loader = { locate: () => 'own-entry', resolve: () => entry };
  const editor = { entries: () => [entry], edit: async (_entry: unknown, change: (raw: Record<string, unknown>) => unknown) => { await update('own-entry', { config: change(entry.options.config) }); } };
  const ctx = { get: (name: string) => name === 'loader' ? loader : name === 'configEditor' ? editor : name === 'credentials' ? { describe } : undefined, fiber: {} } as unknown as Context;
  return { entry, update, describe, ctx };
}
test('legacy unscoped enable cannot restart a disabled proactive service', async () => {
  const raw = { proactiveEnabled: false, proactiveExecutionEnabled: true, provider: { expression: 'unchanged' }, dataDir: '/fixture/data' };
  const f = fixture(raw);
  expect(await setupProactive(f.ctx, { proactiveEnabled: false } as ProactiveConfig, { action: 'enable-suggestions' })).toBe('conflict');
  expect(await setupProactive(f.ctx, { proactiveEnabled: true } as ProactiveConfig, { action: 'enable-suggestions' })).toBe('unchanged');
  expect(f.update).not.toHaveBeenCalled();
});
test('scoped enable persists installation, epoch and exact operation atomically, and later global disable defeats replay', async () => {
  const raw = { proactiveEnabled: false, proactiveExecutionEnabled: true, dataDir: '/fixture/data' };
  const f = fixture(raw);
  const token: ProactiveBootstrapToken = {
    operation: {
      kind: 'enable-local', operationId: '00000000-0000-4000-8000-000000000001',
      configEpoch: '00000000-0000-4000-8000-000000000002', expectedRevision: null,
      subject: { kind: 'group', group: { groupId: 'fixture-group', groupCreatedAt: 1 } },
    },
    previousConfigEpoch: null,
    installationId: '00000000-0000-4000-8000-000000000003',
    storeId: '00000000-0000-4000-8000-000000000004',
  };
  expect(await persistScopedBootstrap(f.ctx, token, () => false)).toBe('conflict');
  expect(await persistScopedBootstrap(f.ctx, token, () => true)).toBe('updated');
  expect(f.update).toHaveBeenCalledWith('own-entry', { config: { ...raw, proactiveEnabled: true,
    proactiveExecutionEnabled: false, proactiveFollowUpBootstrap: token } });
  f.entry.options.config.proactiveEnabled = false;
  expect(await persistScopedBootstrap(f.ctx, token, () => true)).toBe('conflict');
  expect(f.entry.options.config.proactiveEnabled).toBe(false);
  const next: ProactiveBootstrapToken = {
    ...token, previousConfigEpoch: token.operation.configEpoch,
    operation: { ...token.operation, operationId: '00000000-0000-4000-8000-000000000005',
      configEpoch: '00000000-0000-4000-8000-000000000006',
      subject: { kind: 'bot', bot: { botId: 'fixture-bot', botCreatedAt: 2 } } },
  };
  expect(await persistScopedBootstrap(f.ctx, next, () => true)).toBe('updated');
  expect(f.entry.options.config.proactiveFollowUpBootstrap).toEqual(next);
  expect(f.update).toHaveBeenCalledTimes(2);
});
test('source setup rejects secret payloads and missing credentials, prevents overwrite and detects concurrent native settings edits', async () => {
  const current = { proactiveEnabled: true } as ProactiveConfig;
  const request = { action: 'connect-github' as const, repository: 'owner/repo', branch: 'main', credentialRef: 'GITHUB_TOKEN' };
  expect(proactiveSetupRequest.safeParse({ ...request, token: 'secret' }).success).toBe(false);
  expect(proactiveSetupRequest.safeParse({ ...request, proactiveExecutionEnabled: true }).success).toBe(false);
  const f = fixture({ seedExamples: false, proactiveEnabled: true });
  f.describe.mockResolvedValueOnce({ configured: false });
  expect(await setupProactive(f.ctx, current, request)).toBe('credential-missing');
  expect(f.update).not.toHaveBeenCalled();
  f.describe.mockImplementationOnce(async () => { f.entry.options.config = { anotherSetting: true, proactiveEnabled: false }; return { configured: true }; });
  expect(await setupProactive(f.ctx, current, request)).toBe('conflict');
  expect(f.update).not.toHaveBeenCalled();
  f.entry.options.config.proactiveEnabled = true;
  expect(await setupProactive(f.ctx, current, request)).toBe('updated');
  const saved = f.entry.options.config;
  expect(saved).toMatchObject({ anotherSetting: true, proactiveCiFeed: { scope: { repository: 'owner/repo', branch: 'main', generation: 1 }, github: { credentialRef: 'GITHUB_TOKEN' } } });
  expect(saved).not.toHaveProperty('proactiveExecutionEnabled');
  const configured = { ...current, proactiveCiFeed: saved.proactiveCiFeed } as ProactiveConfig;
  expect(await setupProactive(f.ctx, configured, request)).toBe('unchanged');
  expect(await setupProactive(f.ctx, configured, { ...request, repository: 'owner/other' })).toBe('conflict');
  expect(f.update).toHaveBeenCalledTimes(1);
});
