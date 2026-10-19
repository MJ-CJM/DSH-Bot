// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { MemoryPanel, type MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import type { MemoryCatalog, MemoryCatalogSnapshot } from '../../src/client/memory-state.js';
import { type MemoryRecord, memorySchema } from '../../src/shared/schema.js';
import { bot, button, click, field, fill, mountClient } from './helpers.js';

const t = en.ui;
function record(patch: Partial<MemoryRecord> = {}): MemoryRecord {
  return memorySchema.parse({ id: 'memory-one', botId: 'alpha-bot', content: 'Prefers concise answers',
    kind: 'preference', tags: ['writing', '中文'], pinned: false,
    source: { sessionId: 'session-origin', by: 'model', at: 1_000 }, createdAt: 1_000, updatedAt: 2_000, ...patch });
}
function fakeCatalog(records: MemoryRecord[] = [record()]) {
  let snapshot: MemoryCatalogSnapshot = { records, loading: false, loaded: true, pollIntervalMs: 5000,
    query: '', hasNext: false, total: records.length };
  const listeners = new Set<() => void>();
  const catalog: MemoryCatalog = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: vi.fn(async () => {}), dispose: vi.fn(), setPollIntervalMs: vi.fn(),
    setQuery: vi.fn(), nextPage: vi.fn(), firstPage: vi.fn(),
  };
  return { catalog, listeners, async publish(patch: Partial<MemoryCatalogSnapshot>) {
    await act(async () => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); });
  } };
}

const cleanups: (() => Promise<void>)[] = [];
async function mount(options: { records?: MemoryRecord[]; language?: 'en' | 'zh'; bot?: MemoryPanelProps['bot'] } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const source = fakeCatalog(options.records);
  const actions = { onSave: vi.fn<MemoryPanelProps['onSave']>(async () => {}),
    onUpdate: vi.fn<MemoryPanelProps['onUpdate']>(async () => {}),
    onRemove: vi.fn<MemoryPanelProps['onRemove']>(async () => {}),
    onOpenSession: vi.fn<MemoryPanelProps['onOpenSession']>(async () => {}) };
  const dictionary: Record<string, string> = options.language === 'zh' ? zh.ui : en.ui;
  const translate: MemoryPanelProps['t'] = (key, parameters) => {
    const value = dictionary[key];
    if (value === undefined) throw new Error(`Missing locale ${key}`);
    return value.replace(/\{(\w+)\}/g, (_match, name: string) => String((parameters as Record<string, unknown> | undefined)?.[name] ?? `{${name}}`));
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let props: MemoryPanelProps = { bot: options.bot ?? bot(), catalog: source.catalog, ...actions, t: translate };
  await act(async () => { root.render(<MemoryPanel {...props} />); });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await act(async () => { root.unmount(); });
    container.remove();
  };
  cleanups.push(dispose);
  return { ...source, ...actions, container, dispose, async rerender(patch: Partial<MemoryPanelProps>) {
    props = { ...props, ...patch };
    await act(async () => { root.render(<MemoryPanel {...props} />); });
  } };
}
async function submitForm(container: ParentNode, name: string) {
  const form = container.querySelector<HTMLFormElement>(`form[aria-label="${name}"]`);
  if (!form) throw new Error(`Form ${name} not found`);
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MemoryPanel with React and external catalog doubles', () => {
  it('renders contents, localized kinds, tags, attribution, timestamps and source-session navigation', async () => {
    const app = await mount();
    expect(app.container.textContent).toContain('Prefers concise answers');
    expect(app.container.textContent).toContain(t['memory.kindPreference']);
    expect(app.container.textContent).toContain(t['memory.sourceModel']);
    expect(app.container.querySelector(`ul[aria-label="${t['memory.tags']}"]`)?.textContent).toBe('writing中文');
    expect([...app.container.querySelectorAll('time')].map((node) => node.dateTime))
      .toEqual(['1970-01-01T00:00:01.000Z', '1970-01-01T00:00:02.000Z']);
    await click(button(app.container, t['memory.sourceSession']));
    expect(app.onOpenSession).toHaveBeenCalledWith('session-origin');
    expect(app.listeners.size).toBe(1);
    expect(app.container.querySelectorAll('style[data-dsh-bot-memory-styles]')).toHaveLength(1);
    await app.publish({ records: [record({ content: 'Changed by another client' })] });
    expect(app.container.textContent).toContain('Changed by another client');
    expect(app.container.querySelectorAll('style[data-dsh-bot-memory-styles]')).toHaveLength(1);
    await app.dispose();
    expect(app.listeners.size).toBe(0);
    expect(document.querySelectorAll('style[data-dsh-bot-memory-styles]')).toHaveLength(0);
  });

  it('delegates submitted search and pagination, disables navigation during loading and distinguishes errors from empty results', async () => {
    const app = await mount();
    await fill(field(app.container, t['memory.search']), '中文 answers');
    await act(async () => { app.container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(app.catalog.setQuery).toHaveBeenCalledWith('中文 answers');
    await app.publish({ hasNext: true });
    await click(button(app.container, t['memory.nextPage']));
    expect(app.catalog.nextPage).toHaveBeenCalledTimes(1);
    await app.publish({ before: { id: 'previous-page', pinned: false, updatedAt: 3_000 } });
    await click(button(app.container, t['memory.firstPage']));
    expect(app.catalog.firstPage).toHaveBeenCalledTimes(1);
    await app.publish({ loading: true });
    expect(button(app.container, t['memory.nextPage']).disabled).toBe(true);
    expect(button(app.container, t['memory.firstPage']).disabled).toBe(true);
    await app.publish({ loading: false, error: { code: 'store/unavailable', message: 'DO_NOT_ECHO_PAYLOAD' } });
    expect(app.container.textContent).toContain(t['memory.loadError']);
    expect(app.container.textContent).toContain('Prefers concise answers');
    expect(app.container.textContent).not.toContain(t['memory.empty']);
    expect(app.container.textContent).not.toContain('DO_NOT_ECHO_PAYLOAD');
    await click(button(app.container, t['actions.retry']));
    expect(app.catalog.refresh).toHaveBeenCalledTimes(1);
    await app.publish({ error: undefined, records: [], query: 'missing', hasNext: false, before: undefined });
    expect(app.container.textContent).toContain(t['memory.noMatches']);
  });

  it('updates only the requested pin field and prevents duplicate writes while pending', async () => {
    const app = await mount();
    let resolve: (() => void) | undefined;
    app.onUpdate.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await click(button(app.container, t['memory.pin']));
    expect(app.onUpdate).toHaveBeenCalledExactlyOnceWith('memory-one', { pinned: true });
    expect(button(app.container, t['memory.pin']).disabled).toBe(true);
    await click(button(app.container, t['memory.pin']));
    expect(app.onUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { resolve?.(); });
    await app.publish({ records: [record({ pinned: true })] });
    await click(button(app.container, t['memory.unpin']));
    expect(app.onUpdate).toHaveBeenLastCalledWith('memory-one', { pinned: false });
  });

  it('requires an explicit second delete action, permits cancellation and retains confirmation on failure', async () => {
    const app = await mount();
    await click(button(app.container, t['actions.delete']));
    expect(app.onRemove).not.toHaveBeenCalled();
    expect(app.container.querySelector('[role="dialog"]')).toBeNull();
    await click(button(app.container, t['actions.cancel']));
    expect(app.container.textContent).not.toContain(t['memory.deleteConfirm']);
    await click(button(app.container, t['actions.delete']));
    app.onRemove.mockRejectedValueOnce({ code: 'store/unavailable' });
    await click(button(app.container, t['memory.deleteAction']));
    expect(app.container.textContent).toContain(t['memory.removeError']);
    expect(app.container.textContent).toContain(t['memory.deleteConfirm']);
    await click(button(app.container, t['memory.deleteAction']));
    expect(app.onRemove).toHaveBeenNthCalledWith(1, 'memory-one');
    expect(app.onRemove).toHaveBeenNthCalledWith(2, 'memory-one');
    expect(app.container.textContent).toContain(t['memory.removed']);
    expect(app.container.textContent).not.toContain(t['memory.deleteConfirm']);
  });

  it('adds validated memories without accepting provenance and localizes Host secret rejection without echoing diagnostics', async () => {
    const app = await mount({ records: [] });
    await click(button(app.container, t['memory.add']));
    await fill(field(app.container, t['memory.content']), '  Remember this preference  ');
    await fill(field(app.container, t['memory.kind']), 'preference');
    await fill(field(app.container, t['memory.tags']), 'work, 中文\nwork');
    await click(field(app.container, t['memory.pinned']));
    app.onSave.mockRejectedValueOnce({ code: 'memory/rejected', message: 'DO_NOT_ECHO_SECRET' });
    await submitForm(app.container, t['memory.add']);
    expect(app.onSave).toHaveBeenCalledExactlyOnceWith({ content: 'Remember this preference', kind: 'preference', tags: ['work', '中文'], pinned: true });
    expect(app.container.textContent).toContain(t['memory.secretRejected']);
    expect(app.container.textContent).not.toContain('DO_NOT_ECHO_SECRET');
    expect(field(app.container, t['memory.content']).value).toBe('  Remember this preference  ');
    await fill(field(app.container, t['memory.content']), 'Corrected safe text');
    await submitForm(app.container, t['memory.add']);
    expect(app.onSave).toHaveBeenCalledTimes(2);
    expect(app.container.querySelector(`form[aria-label="${t['memory.add']}"]`)).toBeNull();
    expect(app.container.textContent).toContain(t['memory.saved']);
  });

  it('rejects blank and oversized UTF-8 input before the Remote action and accepts the exact byte boundary', async () => {
    const app = await mount({ records: [] });
    await click(button(app.container, t['memory.add']));
    await submitForm(app.container, t['memory.add']);
    expect(app.container.textContent).toContain(t['memory.contentInvalid']);
    expect(app.onSave).not.toHaveBeenCalled();
    await fill(field(app.container, t['memory.content']), '😀'.repeat(513));
    await submitForm(app.container, t['memory.add']);
    expect(app.onSave).not.toHaveBeenCalled();
    await fill(field(app.container, t['memory.content']), '😀'.repeat(512));
    await submitForm(app.container, t['memory.add']);
    expect(app.onSave).toHaveBeenCalledTimes(1);
  });

  it('edits visible fields while preserving unchanged comma-containing tags and leaves provenance to the Host', async () => {
    const app = await mount({ records: [record({ tags: ['one,two', '中文'] })] });
    await click(button(app.container, t['card.edit']));
    await fill(field(app.container, t['memory.content']), 'Updated content');
    await submitForm(app.container, t['memory.edit']);
    expect(app.onUpdate).toHaveBeenCalledExactlyOnceWith('memory-one', {
      content: 'Updated content', kind: 'preference', pinned: false, tags: ['one,two', '中文'],
    });
    expect(app.onSave).not.toHaveBeenCalled();
  });

  it('shows the localized disabled or complete-persona notice and explains live versus cold-restored snapshots', async () => {
    const app = await mount({ language: 'zh', bot: bot({ id: 'alpha-bot', name: 'Alpha', memory: { enabled: false, injectLimit: 20 }, persona: { prefix: '', complete: true } }) });
    expect(app.container.textContent).toContain(zh.ui['memory.disabled']);
    expect(app.container.textContent).not.toContain(zh.ui['memory.complete']);
    expect(app.container.textContent).toContain(zh.ui['memory.sessionNotice']);
    expect(button(app.container, zh.ui['memory.add']).disabled).toBe(false);
    await app.rerender({ bot: bot({ id: 'alpha-bot', name: 'Alpha', persona: { prefix: '', complete: true } }) });
    expect(app.container.textContent).toContain(zh.ui['memory.complete']);
    expect(app.container.textContent).not.toContain(zh.ui['memory.disabled']);
  });

  it('does not let a late save completion clear the editor after switching to another Bot', async () => {
    const app = await mount({ records: [] });
    let resolve: (() => void) | undefined;
    app.onSave.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await click(button(app.container, t['memory.add']));
    await fill(field(app.container, t['memory.content']), 'Alpha content');
    await submitForm(app.container, t['memory.add']);
    const second = fakeCatalog([]);
    await app.rerender({ bot: bot({ id: 'beta-bot', name: 'Beta' }), catalog: second.catalog });
    expect(app.listeners.size).toBe(0);
    await click(button(app.container, t['memory.add']));
    await fill(field(app.container, t['memory.content']), 'Beta content');
    await act(async () => { resolve?.(); });
    expect(field(app.container, t['memory.content']).value).toBe('Beta content');
    expect(app.container.textContent).not.toContain(t['memory.saved']);
    await app.dispose();
    expect(second.listeners.size).toBe(0);
  });

  it('renders a localized fallback for persisted timestamps outside the JavaScript Date range', async () => {
    const app = await mount({ records: [record({ createdAt: 8_640_000_000_000_001, updatedAt: 8_640_000_000_000_001 })] });
    expect(app.container.querySelectorAll('time')).toHaveLength(2);
    expect(app.container.querySelectorAll('time[datetime]')).toHaveLength(0);
    expect(app.container.textContent).toContain(t['memory.timeUnavailable']);
  });
});

describe('MemoryPanel integrated with the public Client slots', () => {
  function panelOf(container: ParentNode): HTMLElement {
    const panel = container.querySelector<HTMLElement>(`section[aria-label="${t['memory.title']}"]`);
    if (!panel) throw new Error('Memory panel is not mounted');
    return panel;
  }
  it('opens from Bot details and binds navigation, pin, delete and save to the selected Bot with refresh after writes', async () => {
    const app = await mountClient([bot()], 'en', (remote) => {
      remote.data.memories = [record(), record({ id: 'other-memory', botId: 'beta-bot', content: 'Other Bot private memory' })];
      remote.methods.memory.save.mockImplementation(async (botId, input) => {
        remote.data.memories.push(record({ id: 'memory-test', botId, ...input,
          source: { by: 'user', at: 3_000 } }));
        return { ok: true, value: { id: 'memory-test', deduplicated: false } };
      });
    });
    cleanups.push(app.dispose);
    expect(app.remote.methods.memory.list).not.toHaveBeenCalled();
    await click(button(app.container, t['card.edit']));
    await click(button(app.container, t['memory.title']));
    const panel = panelOf(app.container);
    expect(app.remote.methods.memory.list).toHaveBeenCalledExactlyOnceWith('alpha-bot', { limit: 51, before: undefined });
    expect(app.container.querySelectorAll('dialog')).toHaveLength(1);
    expect(panel.textContent).not.toContain('Other Bot private memory');
    await click(button(panel, t['memory.sourceSession']));
    expect(app.openSession).toHaveBeenCalledExactlyOnceWith('session-origin');
    await click(button(panel, t['memory.pin']));
    expect(app.remote.methods.memory.update).toHaveBeenCalledExactlyOnceWith('alpha-bot', 'memory-one', { pinned: true });
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(2);
    expect(button(panel, t['memory.unpin'])).toBeDefined();
    await click(button(panel, t['actions.delete']));
    expect(app.remote.methods.memory.delete).not.toHaveBeenCalled();
    await click(button(panel, t['memory.deleteAction']));
    expect(app.remote.methods.memory.delete).toHaveBeenCalledExactlyOnceWith('alpha-bot', 'memory-one');
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(3);
    expect(panel.textContent).toContain(t['memory.empty']);
    await click(button(panel, t['memory.add']));
    await fill(field(panel, t['memory.content']), 'Manually entered preference');
    await submitForm(panel, t['memory.add']);
    expect(app.remote.methods.memory.save).toHaveBeenCalledExactlyOnceWith('alpha-bot', {
      content: 'Manually entered preference', kind: 'note', tags: [], pinned: false,
    });
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(4);
    expect(panel.textContent).toContain('Manually entered preference');
    expect(panel.textContent).toContain(t['memory.sourceUser']);
    expect(app.remote.data.memories.find((row) => row.id === 'other-memory')).toBeDefined();
  });

  it('releases memory polling, reset subscription and styles when leaving its tab or closing details', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const app = await mountClient([bot()], 'en', (remote) => { remote.data.memories = [record()]; });
    cleanups.push(app.dispose);
    await click(button(app.container, t['card.edit']));
    const dialog = app.container.querySelector('dialog');
    if (!dialog) throw new Error('Bot editor missing');
    await click(button(dialog, t['memory.title']));
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(2);
    await click(button(dialog, t['editor.settings']));
    expect(app.container.querySelector('style[data-dsh-bot-memory-styles]')).toBeNull();
    await act(async () => { app.ctx.emit('connection/reset'); await vi.advanceTimersByTimeAsync(15_000); });
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(2);
    await click(button(dialog, t['memory.title']));
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(3);
    await click(button(app.container, t['actions.close']));
    await act(async () => { app.ctx.emit('connection/reset'); await vi.advanceTimersByTimeAsync(15_000); });
    expect(app.remote.methods.memory.list).toHaveBeenCalledTimes(3);
    expect(app.container.querySelector('style[data-dsh-bot-memory-styles]')).toBeNull();
    await app.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
