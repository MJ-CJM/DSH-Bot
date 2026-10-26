// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { botCreateSchema, botSchema, memorySchema } from '../../src/shared/schema.js';
import { MemoryPanel, type MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import type { MemoryCatalogSnapshot } from '../../src/client/memory-state.js';
import type { CleanupStatus, ForgetPreview } from '../../src/shared/memory-forget.js';

const id = '00000000-0000-4000-8000-000000000001';
async function mount(lang: 'en' | 'zh') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dict: Record<string, string> = lang === 'zh' ? zh.ui : en.ui;
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }),
    schemaVersion: 1, createdAt: 1, updatedAt: 1 });
  const memory = memorySchema.parse({ id, botId: 'alpha', content: 'SYNTHETIC_UI', kind: 'note',
    tags: [], pinned: false, createdAt: 1, updatedAt: 1 });
  let snapshot: MemoryCatalogSnapshot = { records: [memory], query: '', loading: false, loaded: true, hasNext: false,
    total: 1, pollIntervalMs: 5000, cleanups: [],
    roots: { root: '/synthetic', files: [{ path: '/synthetic/AGENTS.md', state: 'present' }] } };
  const listeners = new Set<() => void>(), container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const result: CleanupStatus = { id, stopped: true, strong: false, phase: 'blocked', reasons: ['copies'], sessions: 3 };
  const preview: ForgetPreview = { previewRevision: id, memoryId: id, mode: 'version', revision: 1, targets: [id],
    sessionIds: ['alpha', 'beta', 'gamma'], versions: 2, historyNodes: 8, summaries: 1, copies: 3,
    pendingMessages: 1, conservative: true, rootInstructions: true };
  const actions = { preview: vi.fn(async () => preview), choose: vi.fn(async () => result), retry: vi.fn(async () => {}) };
  const publish = async (patch: Partial<MemoryCatalogSnapshot> = {}) => act(async () => {
    snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener();
  });
  const props: MemoryPanelProps = { bot,
    t: (key, args) => dict[key]?.replace(/\{(\w+)\}/g, (_all, name) => String((args as Record<string, unknown>)?.[name] ?? name)) ?? key,
    catalog: { getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      refresh: async () => {}, dispose: () => {}, setPollIntervalMs: () => {}, setQuery: () => {}, nextPage: () => {}, firstPage: () => {} },
    onSave: async () => {}, onUpdate: async () => {}, onRemove: async () => {}, onOpenSession: async () => {}, forgetting: actions };
  await act(async () => root.render(<MemoryPanel {...props} />));
  const click = async (key: string) => {
    const element = [...container.querySelectorAll('button')].find(b => b.textContent === dict[key]);
    if (!element) throw new Error(`Missing button ${key}`);
    await act(async () => element.click());
  };
  return { container, dict, actions, click, publish, async close() { await act(async () => root.unmount()); container.remove(); } };
}
describe('I19/I20 DOM evidence, separate from Chromium', () => {
  it.each(['en', 'zh'] as const)('previews before choice and distinguishes stopped/verified in %s', async lang => {
    const app = await mount(lang);
    try {
      expect(app.container.textContent).toContain('/synthetic/AGENTS.md');
      expect(app.container.textContent).toContain(app.dict['forget.rootWarning']);
      await app.click('actions.delete'); await app.click('actions.cancel');
      expect(app.actions.preview).not.toHaveBeenCalled(); expect(app.actions.choose).not.toHaveBeenCalled();
      await app.click('actions.delete'); await app.click('forget.preview');
      expect(app.actions.preview).toHaveBeenCalledWith({ memoryId: id, mode: 'version' });
      await app.click('forget.stop');
      expect(app.actions.choose).toHaveBeenCalledWith({ previewRevision: id, choice: 'stop' });
      await app.publish({ records: [], cleanups: [{ id, stopped: true, strong: false, phase: 'blocked', reasons: ['copies'], sessions: 3 }] });
      expect(app.container.textContent).toContain(app.dict['forget.stopped']);
      expect(app.container.textContent).not.toContain(app.dict['forget.strong']);
      expect(app.container.textContent).toContain(app.dict['forget.reason.copies']);
      await app.publish({ cleanups: [{ id, stopped: true, strong: true, phase: 'verified', reasons: [], sessions: 3 }] });
      expect(app.container.textContent).toContain(app.dict['forget.strong']);
      expect(app.container.textContent).not.toContain(app.dict['forget.stopped']);
    } finally { await app.close(); }
  });
  it('retains the chosen scope after CAS failure and keeps preview DOM/focus across 100 catalog refreshes', async () => {
    const app = await mount('en');
    try {
      await app.click('actions.delete');
      const scope = app.container.querySelectorAll<HTMLInputElement>('input[type=radio]')[1];
      if (!scope) throw new Error('Missing scope');
      await act(async () => scope.click()); scope.focus();
      await app.click('forget.preview');
      scope.focus();
      for (let index = 0; index < 100; index++) await app.publish();
      expect(app.container.querySelectorAll('input[type=radio]')[1]).toBe(scope);
      expect(document.activeElement).toBe(scope);
      expect(scope.checked).toBe(true);
      app.actions.choose.mockRejectedValueOnce(new Error('Synthetic CAS conflict'));
      await app.click('forget.clean');
      expect(app.container.textContent).toContain(app.dict['forget.changed']);
      expect(scope.checked).toBe(true);
      await app.click('forget.preview');
      expect(app.actions.preview).toHaveBeenLastCalledWith({ memoryId: id, mode: 'related' });
    } finally { await app.close(); }
  });
});
