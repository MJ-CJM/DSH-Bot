// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { MemoryConsolidation } from '../../src/client/components/MemoryConsolidation.js';
import type { SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

test.each(['en', 'zh'] as const)('%s disabled consolidation remains manual and runs no model on opening', async language => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const status = vi.fn(async () => ({ ok: true, value: { enabled: false, revision: 1, runs: [] } }));
  const consolidate = vi.fn();
  const binding = { remote: () => ({ consolidationStatus: status, consolidate,
    query: async () => ({ ok: true, value: { revision: 1, rows: [], total: 0 } }) }) } as unknown as SharedMemoryBinding;
  const t = ((key: keyof typeof en.ui) => (language === 'en' ? en : zh).ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const host = document.createElement('main'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryConsolidation binding={binding} botId="a" t={t} />));
    await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle', { bubbles: true })); });
    expect(host.textContent).toContain(t('memory.consolidation.disabled'));
    expect(host.querySelector('fieldset')).toBeNull(); expect(consolidate).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
test.each(['en', 'zh'] as const)('%s owner can close a persistent unknown without regenerating it', async language => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const id = '11111111-1111-4111-8111-111111111111';
  let closed = false;
  const status = vi.fn(async () => ({ ok: true, value: { enabled: true, revision: 4, runs: [{ id,
    state: closed ? 'rejected' : 'unknown', unresolved: !closed, closedUnknown: closed,
    provider: 'fixture', model: 'fixture', modelRequests: 1 }] } }));
  const consolidate = vi.fn(), decide = vi.fn(async () => { closed = true; return { ok: true, value: {} }; });
  const binding = { refresh: vi.fn(async () => {}), remote: () => ({ consolidationStatus: status, consolidate,
    decideConsolidation: decide, query: async () => ({ ok: true, value: { revision: 4, rows: [], total: 0 } }) }) } as unknown as SharedMemoryBinding;
  const t = ((key: keyof typeof en.ui) => (language === 'en' ? en : zh).ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const host = document.createElement('main'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryConsolidation binding={binding} botId="alpha" t={t} />));
    await act(async () => { const details = host.querySelector('details'); if (!details) throw Error(); details.open = true; details.dispatchEvent(new Event('toggle', { bubbles: true })); });
    expect(host.textContent).toContain(t('memory.consolidation.unknownNotice'));
    const close = [...host.querySelectorAll('button')].find(button => button.textContent === t('memory.consolidation.closeUnknown'));
    if (!close) throw Error('Missing close action'); await act(async () => close.click());
    expect(decide).toHaveBeenCalledWith({ operationId: expect.any(String), runId: id, botId: 'alpha', expectedRevision: 4, action: 'close' });
    expect(host.textContent).toContain(t('memory.consolidation.closedUnknown')); expect(consolidate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
test.each([true, false])('uses an explicit Bot model by default and never guesses a missing route (%s)', async hasRoute => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const source = '22222222-2222-4222-8222-222222222222';
  const consolidate = vi.fn(async () => ({ ok: true, value: {} }));
  const binding = { refresh: vi.fn(async () => {}), remote: () => ({ consolidate,
    consolidationStatus: async () => ({ ok: true, value: { enabled: true, revision: 4, runs: [] } }),
    query: async () => ({ ok: true, value: { revision: 4, rows: [{ version: { versionId: source }, payload: { content: 'Selected source' } }], total: 1 } }) }) } as unknown as SharedMemoryBinding;
  const t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  const host = document.createElement('main'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MemoryConsolidation binding={binding} botId="alpha" t={t} defaultRoute={hasRoute ? { provider: 'bot-provider', model: 'bot-model' } : undefined} />));
    await act(async () => { const details = host.querySelector('details'); if (!details) throw Error(); details.open = true; details.dispatchEvent(new Event('toggle', { bubbles: true })); });
    const sourceBox = host.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]'); if (!sourceBox) throw Error();
    await act(async () => sourceBox.click());
    const generate = [...host.querySelectorAll('button')].find(button => button.textContent === t('memory.consolidation.generate')); if (!generate) throw Error();
    expect(generate.disabled).toBe(!hasRoute);
    if (hasRoute) {
      const advanced = [...host.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === t('chat.advanced'));
      expect(advanced?.open).toBe(false); await act(async () => generate.click());
      expect(consolidate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'bot-provider', model: 'bot-model', sourceIds: [source] }));
    } else expect(consolidate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
