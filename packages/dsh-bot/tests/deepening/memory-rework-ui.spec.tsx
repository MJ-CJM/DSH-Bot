// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getByLabelText } from '@testing-library/dom';
import { expect, it, vi } from 'vitest';
import { MemoryCleanupStatus } from '../../src/client/components/MemoryCleanupStatus.js';
import { ForgetPreview } from '../../src/client/components/ForgetPreview.js';
import { MemoryConflicts } from '../../src/client/components/MemoryConflicts.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import type { CleanupStatus } from '../../src/shared/memory-forget.js';
import { memoryResolveSchema } from '../../src/shared/memory-management.js';
import { annotatedFact, uid } from './shared-fixtures.js';
import { button, click, fill } from '../client/helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

it.each(['en', 'zh'] as const)('replaces cleanup states, labels radio controls, collapses impact, accepts plain qualifiers (%s)', async lang => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dict = lang === 'en' ? en.ui : zh.ui;
  const t: MemoryPanelProps['t'] = (key, params) => {
    const value = (dict as Record<string, string>)[key]; if (!value) throw new Error(`Missing locale: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => String((params as Record<string, unknown>)?.[name] ?? ''));
  };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); }); };
  try {
    const status = (id: string, strong: boolean): CleanupStatus => ({ id, strong, stopped: true,
      phase: strong ? 'verified' : 'stopped', reasons: [], sessions: 0 });
    await render(<MemoryCleanupStatus statuses={[status('a', false), status('a', true), status('b', true)]} retry={vi.fn()} t={t} />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.textContent).toBe(dict['forget.strong']); expect(container.textContent).not.toContain(dict['forget.stopped']);
    const preview = { previewRevision: uid('preview'), memoryId: uid('memory'), mode: 'version' as const,
      revision: 1, targets: [uid('memory')], sessionIds: ['synthetic'], versions: 2, historyNodes: 3, summaries: 1,
      copies: 1, pendingMessages: 0, conservative: true, rootInstructions: true };
    await render(<ForgetPreview memoryId={uid('memory')} close={vi.fn()} t={t}
      actions={{ preview: async () => preview, choose: vi.fn(), retry: vi.fn() }} />);
    expect(getByLabelText(container, dict['forget.version'])).toHaveProperty('type', 'radio');
    expect(getByLabelText(container, dict['forget.related'])).toHaveProperty('type', 'radio');
    expect(container.querySelectorAll('input:not([type="radio"])')).toHaveLength(0);
    await click(button(container, dict['forget.preview']));
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toBe(dict['forget.details']);
    expect(container.textContent).toContain(t('forget.summary', { versions: 2, sessions: 1 }));
    const rows = ['a', 'b'].map(id => ({ ...annotatedFact({ id, content: `FACT_${id}`, scope: 'shared', trust: 'user_confirmed',
      from: null, to: null, basis: 'unknown', seq: 1, kind: 'user_fact', subject: 'user', factKey: 'city', qualifiers: {} }),
      state: 'disputed' as const, deletedBot: false }));
    const resolve = vi.fn();
    await render(<MemoryConflicts rows={rows} revision={1} resolve={resolve} busy={false} t={t} />);
    for (const input of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await click(input);
    await click(button(container, dict['shared.coexist'])); expect(resolve).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(inputs).toHaveLength(2); expect(container.querySelector('textarea')).toBeNull();
    for (const [i, input] of inputs.entries()) {
      expect(input.closest('label')?.textContent).toBe(dict['shared.appliesTo']); await fill(input, i ? 'Personal travel' : 'Work account');
    }
    await click(button(container, dict['shared.coexist']));
    const result = memoryResolveSchema.parse(resolve.mock.calls[0]?.[0]);
    expect(result.qualifiers?.map(q => q.values.context)).toEqual(['Work account', 'Personal travel']);
    resolve.mockClear(); await click(button(container, dict['shared.reject']));
    expect(resolve.mock.calls[0]?.[0].choice).toBe('reject');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
