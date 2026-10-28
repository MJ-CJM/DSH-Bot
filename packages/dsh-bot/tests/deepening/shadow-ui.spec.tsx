// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { AutoShareStatus } from '../../src/client/components/AutoShareStatus.js';
import type { SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import { autoShareStatusSchema } from '../../src/shared/data-flow.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
describe('I66 offline state through existing strict Remote and localized Client', () => {
  it.each(['en', 'zh'] as const)('shows OFF and synthetic counters without a real-run control in %s', async language => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dictionary: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
    const t: MemoryPanelProps['t'] = (key, args) => dictionary[key]?.replace(/\{(\w+)\}/g,
      (_, name) => String((args as Record<string, unknown>)?.[name] ?? '')) ?? key;
    const status = autoShareStatusSchema.parse({ configured: false, effectiveAutoShare: false, reason: 'unverifiable-user-input',
      botDaily: 5, domainDaily: 20, timeZone: 'UTC', revision: 1,
      shadow: { mode: 'offline-only', shadowEnabled: false, offlineOrganizeEnabled: false,
        opportunities: 100, candidates: 20, modelRequests: 0, notifications: 0, memoryWrites: 0 } });
    const binding = { remote: () => ({ autoShareStatus: async () => ({ ok: true, value: status }) }) } as unknown as SharedMemoryBinding;
    const div = document.createElement('div'), root = createRoot(div);
    try {
      await act(async () => root.render(<AutoShareStatus binding={binding} t={t} />));
      expect(div.textContent).toContain(dictionary['shadow.offline']);
      expect(div.textContent).toContain(t('shadow.status', { shadow: dictionary['shadow.off'], organize: dictionary['shadow.off'],
        opportunities: 100, candidates: 20 }));
      expect([...div.querySelectorAll('button')].map(button => button.textContent)).toEqual([dictionary['autoShare.enable']]);
      expect(autoShareStatusSchema.safeParse({ ...status, shadow: { ...status.shadow, modelRequests: 1 } }).success).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });
});
