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
