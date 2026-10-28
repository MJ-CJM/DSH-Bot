// @vitest-environment jsdom
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SharedMemoryPanel } from '../../src/client/components/SharedMemoryPanel.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import { createSharedMemoryCatalog } from '../../src/client/shared-memory-state.js';
import type { DshBotMemoryRemoteMethods } from '../../src/shared/remote-contract.js';
import type { ManagedMemoryPage, MemoryQuery } from '../../src/shared/memory-management.js';
import { annotatedFact } from './shared-fixtures.js';
import { button, click, fill } from '../client/helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
const row = { ...annotatedFact({ id: 'row', content: 'SHARED_CURRENT', scope: 'shared', trust: 'user_confirmed',
  from: 1, to: null, basis: 'explicit', seq: 1, kind: 'user_fact', subject: 'user', factKey: 'city', qualifiers: {} }),
  state: 'active' as const, deletedBot: true };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function setup(language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), dict: Record<string, string> = language === 'en' ? en.ui : zh.ui;
  const t: MemoryPanelProps['t'] = (key, parameters) => {
    if (!dict[key]) throw new Error(`Missing locale ${key}`);
    return dict[key].replace(/\{(\w+)\}/g, (_, name: string) => String((parameters as Record<string, unknown>)?.[name] ?? ''));
  };
  let page: ManagedMemoryPage = { revision: 1, total: 1, rows: [row] };
  const query = vi.fn(async (_input: MemoryQuery) => ({ ok: true as const, value: structuredClone(page) }));
  const revise = vi.fn(async () => ({ ok: false as const, error: { code: 'bot/conflict' } }));
  const remote = { query, revise, cleanupStatuses: async () => ({ ok: true, value: [] }) } as unknown as DshBotMemoryRemoteMethods;
  ctx.provide('remote.dshBot.memory', remote);
  const catalog = createSharedMemoryCatalog(ctx, 'alpha'), binding = { catalog, remote: () => remote, refresh: () => catalog.refresh() };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = async (scope: MemoryQuery['scope'] = 'shared') => {
    await act(async () => { root.render(<SharedMemoryPanel binding={binding} scope={scope} botId="alpha" t={t} />); });
  };
  await render();
  return { ctx, container, catalog, query, revise, dict, render, setPage: (p: ManagedMemoryPage) => { page = p; },
    async close() { await act(async () => { root.unmount(); }); catalog.dispose(); await ctx.fiber.dispose(); container.remove(); } };
}
describe('I29 real polling catalog, volatile drafts and stable React rows (DOM evidence)', () => {
  it.each(['en', 'zh'] as const)('keeps DOM identity, focus, drafts and subscriber snapshots for 100 unchanged %s refreshes', async language => {
    const f = await setup(language);
    try {
      const list = f.container.querySelector('[data-shared-memory-list]'), item = list?.firstElementChild;
      if (!list || !item) throw new Error('Missing shared row');
      await click(button(f.container, f.dict['memory.edit'] ?? ''));
      const editor = f.container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${f.dict['shared.content']}"]`);
      if (!editor) throw new Error('Missing draft'); await fill(editor, 'UNSAVED_USER_DRAFT'); editor.focus();
      let adds = 0, removes = 0;
      const observer = new MutationObserver(records => { for (const record of records) {
        adds += record.addedNodes.length; removes += record.removedNodes.length;
      } }); observer.observe(list, { childList: true, subtree: true });
      const snapshot = f.catalog.getSnapshot(), changed = vi.fn(), off = f.catalog.observe(changed);
      await act(async () => { await f.catalog.refresh(); }); changed.mockClear();
      for (let i = 0; i < 100; i++) await act(async () => { await f.catalog.refresh(); });
      expect(f.catalog.getSnapshot()).toBe(snapshot); expect(changed).not.toHaveBeenCalled();
      expect(list.firstElementChild).toBe(item); expect(document.activeElement).toBe(editor); expect(editor.value).toBe('UNSAVED_USER_DRAFT');
      observer.disconnect(); off(); expect(adds).toBe(0); expect(removes).toBe(0);
      const dir = resolve('../../.dsh-dev/deepening/b5'); await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, `memory-state-${language}.json`), JSON.stringify({ level: 'DOM', refreshes: 100,
        rowRemounts: adds, rowRemovals: removes, focusLosses: 0, draftLosses: 0, publishedSnapshots: changed.mock.calls.length }));
    } finally { await f.close(); }
  });
  it('preserves a conflicting draft, explicitly compares/adopts a revision, and keeps per-scope drafts across switching', async () => {
    const f = await setup();
    try {
      await click(button(f.container, en.ui['memory.edit']));
      const field = () => f.container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${en.ui['shared.content']}"]`);
      await fill(field() as HTMLTextAreaElement, 'MY_CAS_DRAFT');
      const form = f.container.querySelector(`form[aria-label="${en.ui['shared.editor']}"]`);
      await act(async () => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      expect(field()?.value).toBe('MY_CAS_DRAFT'); expect(f.container.textContent).toContain(en.ui['shared.changed']);
      f.setPage({ revision: 2, rows: [{ ...row, payload: { ...row.payload, content: 'OTHER_CLIENT_EDIT' } }], total: 1 });
      await click(button(f.container, en.ui['shared.compare']));
      expect(f.container.textContent).toContain('OTHER_CLIENT_EDIT'); expect(field()?.value).toBe('MY_CAS_DRAFT');
      await click(button(f.container, en.ui['shared.adoptRevision']));
      await f.render('private'); await f.render('shared'); expect(field()?.value).toBe('MY_CAS_DRAFT');
      expect(f.catalog.getSnapshot().revision).toBe(2);
    } finally { await f.close(); }
  });
  it('discards old scope responses and pending completions after disposal', async () => {
    const f = await setup();
    try {
      const old = deferred<Awaited<ReturnType<typeof f.query>>>(), next = deferred<Awaited<ReturnType<typeof f.query>>>();
      f.query.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
      let waiting!: Promise<void>;
      await act(async () => { waiting = f.catalog.refresh(); f.catalog.select({ scope: 'quarantine' }); });
      await act(async () => { next.resolve({ ok: true, value: { revision: 3, rows: [], total: 0 } }); });
      await act(async () => { old.resolve({ ok: true, value: { revision: 1, rows: [row], total: 1 } }); await waiting; });
      expect(f.catalog.getSnapshot().input.scope).toBe('quarantine'); expect(f.catalog.getSnapshot().rows).toEqual([]);
      const final = deferred<Awaited<ReturnType<typeof f.query>>>(); f.query.mockImplementationOnce(() => final.promise);
      await act(async () => { waiting = f.catalog.refresh(); }); const before = f.catalog.getSnapshot();
      f.catalog.dispose(); final.resolve({ ok: true, value: { revision: 99, rows: [], total: 0 } }); await waiting;
      expect(f.catalog.getSnapshot().revision).toBe(before.revision);
    } finally { await f.close(); }
  });
});
