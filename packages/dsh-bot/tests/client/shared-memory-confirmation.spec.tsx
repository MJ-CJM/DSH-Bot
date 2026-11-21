// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { SharedMemoryPanel, type SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import en from '../../locale/en.json';

it('invalidates the visible sharing preview after polling and confirms only the newly reviewed version', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
  const owner = { botId: 'alpha', botCreatedAt: 1 };
  const page = (versionId: string, revision: number) => ({ loaded: true, revision, total: 1, input: { scope: 'private', view: 'facts' },
    rows: [{ version: { memoryId: id, versionId, scope: 'private', provenance: { bot: owner }, recordedAt: 1, trust: 'candidate',
      labels: { readers: [owner] }, sourceRefs: [] }, state: 'active', payload: { content: 'Test entry ' + revision, valid: { from: null, to: null, basis: 'unknown' } } }] });
  let state = page(first, 1);
  const listeners = new Set<() => void>();
  const confirm = vi.fn(async () => ({ ok: true, value: id }));
  const binding = { catalog: { select() {}, getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } },
    refresh: vi.fn(async () => {}), remote: () => ({ confirm, autoShareStatus: async () => ({ ok: false }),
      cleanupStatuses: async () => ({ ok: true, value: [] }) }) } as unknown as SharedMemoryBinding;
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const host = document.createElement('main'), root = createRoot(host);
  const action = (key: keyof typeof en.ui) => [...host.querySelectorAll('button')].find(b => b.textContent === t(key));
  try {
    await act(async () => root.render(<SharedMemoryPanel binding={binding} botId="alpha" scope="private" t={t} />));
    await act(async () => action('shared.publish')!.click());
    expect(host.querySelector('fieldset')?.textContent).toContain('Test entry 1');
    await act(async () => { state = page(second, 2); for (const listener of listeners) listener(); });
    expect(host.querySelector('fieldset')).toBeNull();
    expect(host.textContent).toContain(t('shared.previewChanged'));
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => action('shared.publish')!.click());
    expect(host.querySelector('fieldset')?.textContent).toContain('Test entry 2');
    await act(async () => action('shared.confirm')!.click());
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ id, versionId: second, expectedRevision: 2, botId: 'alpha', scope: 'shared' });
  } finally { await act(async () => root.unmount()); }
});
