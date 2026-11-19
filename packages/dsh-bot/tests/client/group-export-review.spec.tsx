// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { GroupExportReview } from '../../src/client/components/GroupExportReview.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import type { GroupDelivery } from '../../src/shared/groups.js';
import en from '../../locale/en.json';

it.each([true, false] as const)('requires full plaintext preview before the explicit decision (%s)', async allow => {
  const flowId = crypto.randomUUID();
  const decideExport = vi.fn(async (..._args: unknown[]) => ({ ok: true, value: true }));
  const reviewExport = vi.fn(async () => ({ ok: true, value: { token: 'a'.repeat(64), deliveryRevision: 1, flowId, groupName: 'Group',
    recipients: [{ name: 'Alpha' }, { name: 'Beta' }], content: '<img src="https://example.invalid/private"> PRIVATE_BODY' } }));
  const refresh = vi.fn(async () => {});
  const actions = { remote: () => ({ reviewExport, decideExport }), messageView: () => ({ refresh }), catalog: { refresh } } as unknown as GroupActions;
  const delivery = { id: 'delivery', revision: 1, exportFlowId: flowId } as GroupDelivery;
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element);
  const t = ((key: keyof typeof en.ui, p?: Record<string, string>) => en.ui[key].replace(/\{(\w+)\}/g, (_, k) => p?.[k] ?? k)) as PropsLocale<'dsh-bot'>['t'];
  try {
    await act(async () => root.render(<GroupExportReview group={{ groupId: 'group', groupCreatedAt: 1 }} delivery={delivery} actions={actions} t={t} />));
    expect(element.textContent).not.toContain('PRIVATE_BODY'); expect(decideExport).not.toHaveBeenCalled();
    await act(async () => element.querySelector('button')?.click());
    expect(element.querySelector('pre')?.textContent).toContain('PRIVATE_BODY'); expect(element.querySelector('img')).toBeNull();
    expect(element.textContent).toContain('Alpha'); expect(element.textContent).toContain('Beta');
    expect(element.querySelectorAll('button')).toHaveLength(3);
    const button = [...element.querySelectorAll('button')].find(b => b.textContent === en.ui[allow ? 'groups.export.allow' : 'groups.export.reject']);
    await act(async () => { button?.click(); button?.click(); });
    expect(decideExport).toHaveBeenCalledTimes(1); expect(decideExport.mock.calls[0]?.at(-1)).toBe(allow);
    expect(element.querySelector('pre')).toBeNull();
  } finally { await act(async () => root.unmount()); element.remove(); }
});
