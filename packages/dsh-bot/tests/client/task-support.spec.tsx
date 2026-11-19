// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { PendingTaskSupport, TaskSupportPanel, type TaskSupportActions } from '../../src/client/task-support.js';
import type { TaskSupport } from '../../src/shared/task-materials.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
import { button, click } from './helpers.js';

const snapshot = (workId = 'work'): TaskSupport => ({ workId, revision: 2, owner: { botId: 'alpha', botCreatedAt: 1 }, readers: [{ botId: 'alpha', botCreatedAt: 1 }, { botId: 'beta', botCreatedAt: 1 }],
  originalQuestion: 'Exact original request', ownerName: 'Alice', readerNames: ['Alice', 'Bob'], originSessionId: 'origin', inputMessageId: 'input', blockers: [{ id: 'blocker', assignmentId: 'github', desiredRevision: 4, state: 'waiting', reason: 'missing-credential', observedAt: 1 }], materials: [], resumes: [],
  inputs: [{ messageId: 'input', name: 'Exact original request', version: 'a'.repeat(64) }], ci: [{ id: 'ci', name: 'Build failed', version: 'ci-v1', citation: 'https://github.com/owner/repo/actions/runs/1' }] });
async function fixture(language: 'en' | 'zh' = 'en', pending = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = snapshot(), listeners = new Set<() => void>();
  const actions = { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, view: vi.fn<TaskSupportActions['view']>(async () => data), pending: vi.fn(async () => [data]), add: vi.fn<TaskSupportActions['add']>(async () => data), resume: vi.fn<TaskSupportActions['resume']>(async () => data) } satisfies TaskSupportActions;
  const open = vi.fn(async () => {}), t = ((key: keyof typeof en.ui) => (language === 'en' ? en : zh).ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('main'); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(pending ? <PendingTaskSupport actions={actions} open={open} t={t} /> : <TaskSupportPanel workId="work" actions={actions} t={t} />));
  const fill = async (target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto = target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(target, value); target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); });
  };
  const renderWork = async (workId: string) => { await act(async () => root.render(<TaskSupportPanel workId={workId} actions={actions} t={t} />)); };
  return { actions, element, t, open, fill, renderWork, invalidate: () => { for (const listener of listeners) listener(); }, close: async () => { await act(async () => root.unmount()); element.remove(); } };
}

test.each(['en', 'zh'] as const)('%s pending aggregation opens original conversation without resolving or resuming', async language => {
  const f = await fixture(language, true);
  try {
    expect(f.element.textContent).toContain(f.t('taskSupport.readReceipt'));
    const target = [...f.element.querySelectorAll('button')].find(row => row.textContent?.includes(f.t('taskSupport.openOrigin')))!;
    await click(target); expect(f.open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ originSessionId: 'origin', workId: 'work' }));
    expect(f.actions.resume).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('selected original input uses original question and one continue action with natural user expression', async () => {
  const f = await fixture();
  try {
    expect(f.element.textContent).toContain('Alice, Bob');
    expect(f.element.querySelector('[data-task-support-advanced]')?.hasAttribute('open')).toBe(false);
    expect(f.element.querySelector('[data-task-support-technical]')?.hasAttribute('open')).toBe(false);
    await f.fill(f.element.querySelector('select')!, 'input:input');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.add).toHaveBeenCalledWith(expect.objectContaining({ workId: 'work', expectedRevision: 2, question: 'Exact original request', source: { kind: 'input-text', messageId: 'input', version: 'a'.repeat(64) } }));
    expect(f.actions.resume).toHaveBeenCalledWith(expect.objectContaining({ workId: 'work', expectedRevision: 2, text: f.t('taskSupport.continueOriginal'), blockerIds: ['blocker'] }));
    expect(JSON.stringify(f.actions.resume.mock.calls)).not.toMatch(/bot_supergroup|workId=/);
  } finally { await f.close(); }
});

test('unknown add response retains exact operation and only resumes after reconciliation', async () => {
  const f = await fixture();
  try {
    f.actions.add.mockRejectedValueOnce(new Error('lost response'));
    await f.fill(f.element.querySelector('select')!, 'ci:ci');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.resume).not.toHaveBeenCalled();
    expect(f.element.querySelector('select')?.matches(':disabled')).toBe(true);
    await click(button(f.element, f.t('taskSupport.reconcile')));
    expect(f.actions.add.mock.calls[0]).toEqual(f.actions.add.mock.calls[1]);
    expect(f.actions.resume).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test.each(['dsh-bot/invalid', 'dsh-bot/conflict', 'dsh-bot/approval-denied', 'dsh-bot/unavailable'])('definitive %s rejection permits correcting the selected material', async code => {
  const f = await fixture();
  try {
    f.actions.add.mockRejectedValueOnce({ code });
    await f.fill(f.element.querySelector('select')!, 'ci:ci');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.element.querySelector('select')?.matches(':disabled')).toBe(false);
    expect(f.element.querySelector('[data-task-reconcile]')).toBeNull();
    await f.fill(f.element.querySelector('select')!, 'input:input');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.add.mock.calls[1]?.[0].source.kind).toBe('input-text');
    expect(f.actions.resume).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

test('unknown resume response retains the exact operation without readmission of selected data', async () => {
  const f = await fixture();
  try {
    f.actions.resume.mockRejectedValueOnce(new Error('lost native result'));
    await f.fill(f.element.querySelector('select')!, 'ci:ci');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    await click(button(f.element, f.t('taskSupport.reconcile')));
    expect(f.actions.add).toHaveBeenCalledTimes(1);
    expect(f.actions.resume.mock.calls[0]).toEqual(f.actions.resume.mock.calls[1]);
  } finally { await f.close(); }
});

async function selectFile(element: HTMLElement, name: string, text: Promise<string>) {
  const upload = element.querySelector('input[type=file]')!, selected = new File(['data'], name, { type: 'text/plain' });
  Object.defineProperty(selected, 'text', { value: () => text });
  Object.defineProperty(upload, 'files', { configurable: true, value: [selected] });
  await act(async () => upload.dispatchEvent(new Event('change', { bubbles: true })));
}
test('file B wins even when earlier file A finishes reading last', async () => {
  const f = await fixture(); let finishA!: (text: string) => void;
  try {
    await f.fill(f.element.querySelector('select')!, 'file');
    await selectFile(f.element, 'A.md', new Promise(resolve => { finishA = resolve; }));
    await selectFile(f.element, 'B.md', Promise.resolve('Selected B body'));
    await act(async () => finishA('Stale A body'));
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.add).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'file', name: 'B.md', text: 'Selected B body' } }));
  } finally { await f.close(); }
});

test('work switch discards old draft, pending closure and late file reads', async () => {
  const f = await fixture(); let finishA!: (text: string) => void;
  try {
    await f.fill(f.element.querySelector('select')!, 'file');
    await selectFile(f.element, 'old-work.md', new Promise(resolve => { finishA = resolve; }));
    f.actions.view.mockResolvedValueOnce(snapshot('other-work'));
    await f.renderWork('other-work');
    await act(async () => finishA('Old work body'));
    expect(f.element.querySelector('[data-task-support]')?.getAttribute('data-task-support')).toBe('other-work');
    expect(f.element.querySelector('select')?.value).toBe('');
    expect(f.element.textContent).not.toContain('old-work.md');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.add).not.toHaveBeenCalled();
    expect(f.actions.resume).toHaveBeenCalledWith(expect.objectContaining({ workId: 'other-work' }));
  } finally { await f.close(); }
});


test('late lower-revision views after mutation never replace the accepted revision', async () => {
  const f = await fixture();
  try {
    f.actions.resume.mockResolvedValueOnce({ ...snapshot(), revision: 7 });
    f.actions.view.mockResolvedValue(snapshot());
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.element.querySelector('[data-task-support-technical]')?.textContent).toContain('v7');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.resume.mock.calls[1]?.[0].expectedRevision).toBe(7);
  } finally { await f.close(); }
});


test('an already-started subscribed view is invalidated by mutation, and skipped busy invalidations get a fresh read', async () => {
  const f = await fixture(); let resolveView!: (value: TaskSupport) => void, resolveResume!: (value: TaskSupport) => void;
  try {
    f.actions.view.mockReturnValueOnce(new Promise(resolve => { resolveView = resolve; }));
    await act(async () => f.invalidate());
    const viewCalls = f.actions.view.mock.calls.length;
    f.actions.resume.mockReturnValueOnce(new Promise(resolve => { resolveResume = resolve; }));
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    await act(async () => f.invalidate());
    expect(f.actions.view.mock.calls.length).toBe(viewCalls);
    await act(async () => resolveResume({ ...snapshot(), revision: 7 }));
    expect(f.actions.view.mock.calls.length).toBeGreaterThan(viewCalls);
    await act(async () => resolveView({ ...snapshot(), revision: 3 }));
    expect(f.element.querySelector('[data-task-support-technical]')?.textContent).toContain('v7');
  } finally { resolveView?.(snapshot()); resolveResume?.(snapshot()); await f.close(); }
});

test('switching work while material admission is in flight never continues the old or new task implicitly', async () => {
  const f = await fixture(); let finishAdd!: (value: TaskSupport) => void;
  try {
    f.actions.add.mockReturnValueOnce(new Promise(resolve => { finishAdd = resolve; }));
    await f.fill(f.element.querySelector('select')!, 'ci:ci');
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    f.actions.view.mockResolvedValueOnce(snapshot('new-work'));
    await f.renderWork('new-work');
    await act(async () => finishAdd({ ...snapshot(), revision: 3 }));
    expect(f.actions.resume).not.toHaveBeenCalled();
    expect(f.element.querySelector('[data-task-reconcile]')).toBeNull();
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workId: 'new-work' }));
  } finally { finishAdd?.(snapshot()); await f.close(); }
});

test('attaches a file directly without configuring a source and preserves the original question', async () => {
  const f = await fixture();
  try {
    await selectFile(f.element, 'brief.md', Promise.resolve('Budget limit: 3000'));
    expect(f.actions.add).not.toHaveBeenCalled();
    expect(f.actions.resume).not.toHaveBeenCalled();
    await click(button(f.element, f.t('taskSupport.continueOriginal')));
    expect(f.actions.add).toHaveBeenCalledWith(expect.objectContaining({ question: 'Exact original request', source: { kind: 'file', name: 'brief.md', text: 'Budget limit: 3000' } }));
    expect(f.actions.resume).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
