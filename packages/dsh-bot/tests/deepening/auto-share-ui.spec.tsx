// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { AutoShareStatus } from '../../src/client/components/AutoShareStatus.js';
import { ForgetPreview } from '../../src/client/components/ForgetPreview.js';
import type { SharedMemoryBinding } from '../../src/client/components/SharedMemoryPanel.js';
import type { MemoryPanelProps } from '../../src/client/components/MemoryPanel.js';
import { autoShareToggleSchema } from '../../src/shared/data-flow.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';
describe('B6a capability notice and radio accessibility (DOM only)', () => {
  it.each(['en', 'zh'] as const)('shows the unavailable gate, saves explicit disable, and keeps labelled radios in %s', async language => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const dictionary: Record<string, string> = language === 'zh' ? zh.ui : en.ui;
    const t: MemoryPanelProps['t'] = (key, args) => dictionary[key]?.replace(/\{(\w+)\}/g,
      (_, name) => String((args as Record<string, unknown>)?.[name] ?? '')) ?? key;
    const status = { configured: true, effectiveAutoShare: false as const, reason: 'unverifiable-user-input' as const,
      botDaily: 5, domainDaily: 20, timeZone: 'Asia/Shanghai', revision: 2 };
    const remote = { autoShareStatus: vi.fn(async () => ({ ok: true as const, value: status })),
      setAutoShare: vi.fn(async (raw: unknown) => {
        const f = autoShareToggleSchema.parse(raw);
        return { ok: true as const, value: { ...status, configured: f.enabled, revision: f.expectedRevision + 1 } };
      }) };
    const binding = { remote: () => remote } as unknown as SharedMemoryBinding;
    const div = document.createElement('div'); document.body.append(div); const root = createRoot(div);
    try {
      await act(async () => root.render(<><AutoShareStatus binding={binding} t={t} />
        <ForgetPreview memoryId="synthetic" t={t} close={() => {}} actions={{ preview: vi.fn(), choose: vi.fn(), retry: vi.fn() }} /></>));
      expect(div.textContent).toContain(dictionary['autoShare.unavailable']); expect(div.textContent).toContain('Asia/Shanghai');
      const radios = [...div.querySelectorAll<HTMLInputElement>('input[type=radio]')]; expect(radios).toHaveLength(2);
      expect(radios.map(r => r.closest('label')?.querySelector('span')?.textContent))
        .toEqual([dictionary['forget.version'], dictionary['forget.related']]);
      expect(radios[0]?.name).toBeTruthy(); expect(radios[0]?.name).toBe(radios[1]?.name);
      await act(async () => radios[1]?.click()); expect(radios[1]?.checked).toBe(true); expect(radios[0]?.checked).toBe(false);
      const button = [...div.querySelectorAll('button')].find(b => b.textContent === dictionary['autoShare.disable']);
      if (!button) throw new Error('Missing disable');
      const identity = div.querySelector('aside'); button.focus();
      for (let i = 0; i < 100; i++) await act(async () => root.render(<>
        <AutoShareStatus binding={binding} t={t} />
        <ForgetPreview memoryId="synthetic" t={t} close={() => {}}
          actions={{ preview: vi.fn(), choose: vi.fn(), retry: vi.fn() }} />
      </>));
      expect(div.querySelector('aside')).toBe(identity); expect(document.activeElement).toBe(button);
      expect(remote.autoShareStatus).toHaveBeenCalledTimes(1);
      await act(async () => { button.click(); button.click(); });
      expect(remote.setAutoShare).toHaveBeenCalledTimes(1);
      expect(remote.setAutoShare).toHaveBeenCalledWith({ enabled: false, expectedRevision: 2 });
      expect(div.textContent).toContain(dictionary['autoShare.enable']);
      expect(div.textContent).toContain(dictionary['autoShare.unavailable']);
    } finally { await act(async () => root.unmount()); div.remove(); }
  });
  it('rejects forged capability fields in policy updates', () => {
    expect(autoShareToggleSchema.safeParse({ enabled: true, expectedRevision: 2, effectiveAutoShare: true }).success).toBe(false);
  });
});
