// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MemoryChanges } from '../../src/client/components/MemoryChanges.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import type { MemoryChangesPage } from '../../src/shared/memory-management.js';
import { annotatedFact, uid } from '../deepening/shared-fixtures.js';
import { button, click } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

it.each(['en', 'zh'] as const)('shows source/time/diff and never automatically retries an unknown restore (%s)', async lang => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dict = lang === 'en' ? en.ui : zh.ui;
  const t: MemoryPanelProps['t'] = (key, params) => {
    const value = (dict as Record<string, string>)[key]; if (!value) throw new Error(`Missing translation ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, field: string) => String((params as Record<string, unknown>)?.[field] ?? ''));
  };
  const fact = annotatedFact({ id: 'restorable', content: 'Before', scope: 'private', trust: 'user_confirmed',
    from: null, to: null, basis: 'unknown', seq: 1, kind: 'user_fact', subject: 'user', factKey: null, qualifiers: {} });
  const page: MemoryChangesPage = { revision: 8, rows: [{ ...fact, opId: uid('change'), kind: 'revise',
    previous: { content: 'Older', valid: fact.payload.valid }, changed: ['content'], restorable: true }] };
  const load = vi.fn().mockResolvedValue(page), restore = vi.fn().mockRejectedValue(new Error('Outcome unknown'));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryChanges t={t} binding={{ load, restore }} />));
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      const details = container.querySelector('details'); if (!details) throw new Error('Missing changes');
      const toggled = new Promise<void>(resolve => details.addEventListener('toggle', () => resolve(), { once: true }));
      details.open = true; await toggled;
    });
    expect(container.textContent).toContain(t('memory.changes.source.management'));
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(new Date(100).toISOString());
    expect(container.querySelector(`[aria-label="${t('memory.changes.before')}"]`)?.textContent).toContain('Older');
    await click(button(container, t('memory.changes.restore')));
    expect(restore).toHaveBeenCalledExactlyOnceWith({ id: fact.version.memoryId, versionId: fact.version.versionId, expectedRevision: 8 });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('memory.changes.error'));
    expect(container.querySelector('[data-memory-change]')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    await click(button(container, t('memory.changes.refresh')));
    expect(load).toHaveBeenCalledTimes(2); expect(restore).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
