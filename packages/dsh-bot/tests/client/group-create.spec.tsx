// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { GroupsPanel } from '../../src/client/components/GroupsPanel.js';
import { bots, view, summary } from './group-fixture.js';
import { button, click } from './helpers.js';
import en from '../../locale/en.json';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
it('saved group survives open failure: retry opens the same identity without creating twice', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), element = document.createElement('div'), root = createRoot(element), saved = view().group;
  document.body.append(element);
  const create = vi.fn<GroupMethods['create']>(async () => ({ ok: true, value: saved }));
  const open = vi.fn<GroupMethods['open']>().mockRejectedValueOnce(new Error('navigation offline')).mockResolvedValue({ ok: true, value: { sessionId: saved.rootSessionId, workspaceId: 'workspace' } });
  const openSession = vi.fn();
  ctx.provide('remote.dshBot.groups', { create, open, list: async () => ({ ok: true, value: [summary()] }), view: async () => ({ ok: true, value: view() }) } as unknown as GroupMethods);
  ctx.provide('uiWorkspace', { openSession } as never);
  const actions = createGroupActions(ctx, {}), t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  try {
    await act(async () => root.render(<GroupsPanel initialCreate actions={actions} bots={bots} onOpenSession={async () => {}} t={t} />));
    expect(element.querySelector('nav')).toBeNull(); expect([...element.querySelectorAll('button')].some(item => item.textContent === en.ui['bots.refresh'])).toBe(false);
    const form = element.querySelector('form'); if (!form) throw new Error('Missing group form');
    const checks = form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    for (const check of checks) await click(check);
    expect(form.querySelector('ol')?.closest('details')?.open).toBe(false);
    expect(button(element, en.ui['integrations.save']).disabled).toBe(false);
    await click(button(element, en.ui['integrations.save']));
    expect(create).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['groups.createdOpenFailed']));
    expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0]?.[0].name).toBe('Same name、Same name');
    expect(form.querySelector('input')?.disabled).toBe(true);
    await click(button(element, en.ui['groups.open']));
    expect(create).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(2); expect(open.mock.calls[0]?.[0]).toEqual(open.mock.calls[1]?.[0]);
    expect(openSession).toHaveBeenCalledWith(saved.rootSessionId);
  } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); element.remove(); }
});
