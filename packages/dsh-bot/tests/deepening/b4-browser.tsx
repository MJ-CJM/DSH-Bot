import { createRoot } from 'react-dom/client';
import { MemoryPanel } from '../../src/client/components/MemoryPanel.js';
import { botSchema, botCreateSchema, memorySchema } from '../../src/shared/schema.js';
import type { MemoryCatalogSnapshot } from '../../src/client/memory-state.js';
import type { CleanupStatus, ForgetPreview } from '../../src/shared/memory-forget.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
const id = '00000000-0000-4000-8000-000000000001';
const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'alpha', name: 'Alpha' }), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
const record = memorySchema.parse({ id, botId: 'alpha', content: 'SYNTHETIC_BROWSER_MEMORY', kind: 'note',
  tags: [], pinned: false, createdAt: 1, updatedAt: 1 });
let snapshot: MemoryCatalogSnapshot = { records: [record], query: '', loading: false, loaded: true,
  hasNext: false, total: 1, pollIntervalMs: 5000, cleanups: [],
  roots: { root: '/synthetic/Bots', files: [{ path: '/synthetic/Bots/AGENTS.md', state: 'present' }] } };
const listeners = new Set<() => void>();
const publish = () => { snapshot = { ...snapshot }; for (const fn of listeners) fn(); };
const language = new URLSearchParams(location.search).get('lang') === 'zh' ? 'zh' : 'en';
const dictionary: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
const t: MemoryPanelProps['t'] = (key, parameters) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g,
  (_all, name: string) => String((parameters as Record<string, unknown> | undefined)?.[name] ?? `{${name}}`));
const fixture = { fail: false, calls: [] as string[], refreshes: 0 };
const root = createRoot(document.getElementById('root') as HTMLElement);
root.render(<MemoryPanel bot={bot} t={t}
  catalog={{ getSnapshot: () => snapshot, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: async () => { fixture.refreshes++; publish(); }, dispose: () => {}, setPollIntervalMs: () => {},
    setQuery: () => {}, firstPage: () => {}, nextPage: () => {} }}
  onSave={async () => {}} onUpdate={async () => {}} onRemove={async () => { throw new Error('Preview required'); }}
  onOpenSession={async () => {}} forgetting={{
    preview: async selection => {
      fixture.calls.push('preview');
      return { previewRevision: id, memoryId: selection.memoryId, mode: selection.mode, revision: 1, targets: [id],
        sessionIds: ['alpha', 'beta', 'gamma'], versions: 2, historyNodes: 8, summaries: 1, copies: 3,
        pendingMessages: 1, conservative: true, rootInstructions: true } satisfies ForgetPreview;
    },
    choose: async choice => {
      fixture.calls.push(choice.choice);
      if (fixture.fail) throw new Error('Synthetic CAS conflict');
      const result: CleanupStatus = { id, stopped: true, strong: false, phase: 'blocked', sessions: 3, reasons: ['copies'] };
      snapshot = { ...snapshot, records: [], total: 0, cleanups: [result] }; publish(); return result;
    },
    retry: async () => { fixture.calls.push('retry'); },
  }} />);
Object.assign(window, { b4: {
  fixture, dictionary,
  refresh: () => { fixture.refreshes++; publish(); },
  complete: () => {
    snapshot = { ...snapshot, cleanups: [{ id, stopped: true, strong: true, phase: 'verified', sessions: 3, reasons: [] }] }; publish();
  },
  dispose: () => root.unmount(),
} });
