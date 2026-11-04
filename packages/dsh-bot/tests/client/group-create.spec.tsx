// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import { GroupsPanel } from '../../src/client/components/GroupsPanel.js';
import { bots, view, summary } from './group-fixture.js';
import { button, click, fill } from './helpers.js';
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

async function mountCreate(props: Partial<Parameters<typeof GroupsPanel>[0]>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), element = document.createElement('div'), root = createRoot(element), saved = view().group;
  document.body.append(element);
  const create = vi.fn<GroupMethods['create']>(async () => ({ ok: true, value: saved }));
  ctx.provide('remote.dshBot.groups', { create, open: async () => ({ ok: true, value: { sessionId: saved.rootSessionId, workspaceId: 'workspace' } }),
    list: async () => ({ ok: true, value: [summary()] }), view: async () => ({ ok: true, value: view() }) } as unknown as GroupMethods);
  ctx.provide('uiWorkspace', { openSession: vi.fn() } as never);
  const actions = createGroupActions(ctx, {}), t = ((key: keyof typeof en.ui) => en.ui[key]) as PropsLocale<'dsh-bot'>['t'];
  await act(async () => root.render(<GroupsPanel initialCreate actions={actions} bots={bots} onOpenSession={async () => {}} t={t} {...props} />));
  const form = element.querySelector('form'); if (!form) throw new Error('Missing group form');
  const save = async () => {
    for (const check of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await click(check);
    await click(button(element, en.ui['integrations.save']));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    return create.mock.calls[0]?.[0];
  };
  return { form, save, close: async () => { await act(async () => root.unmount()); await ctx.fiber.dispose(); element.remove(); } };
}

it('chooses the group workspace from native Workspaces or the Host picker; the default omits cwd', async () => {
  const pick = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce('/picked/project');
  const f = await mountCreate({ workspaces: [{ path: '/work/alpha', title: 'alpha' }, { path: '/work/alpha', title: 'duplicate' }, { path: '/work/beta', title: 'beta' }], onPickDirectory: pick });
  try {
    // The workspace boundary is a top-level field, not hidden in Advanced, and explains its write scope.
    const group = f.form.querySelector('fieldset[data-group-workspace]') as HTMLElement;
    expect(group.closest('details')).toBeNull();
    expect(group.textContent).toContain(en.ui['groups.workspaceDefault']);
    expect(group.textContent).toContain(en.ui['groups.workspaceHint']);
    expect(group.querySelector('input')).toBeNull();
    await click(button(group, en.ui['groups.workspaceChoose']));
    const rows = [...group.querySelectorAll('[role="menu"] [role="menuitem"]')].map(row => row.textContent);
    expect(rows).toEqual([en.ui['groups.workspaceUseDefault'], '/work/alpha', '/work/beta', en.ui['groups.workspaceOtherFolder']]);
    await click(button(group, '/work/beta'));
    expect(group.querySelector('[data-path-label]')?.textContent).toBe('/work/beta');
    await click(button(group, en.ui['groups.workspaceChoose'])); await click(button(group, en.ui['groups.workspaceOtherFolder']));
    expect(group.querySelector('[data-path-label]')?.textContent).toBe('/work/beta');
    await click(button(group, en.ui['groups.workspaceChoose'])); await click(button(group, en.ui['groups.workspaceOtherFolder']));
    await vi.waitFor(() => expect(group.querySelector('[data-path-label]')?.textContent).toBe('/picked/project'));
    expect(pick).toHaveBeenCalledTimes(2);
    expect((await f.save())?.cwd).toBe('/picked/project');
  } finally { await f.close(); }
  const reset = await mountCreate({ workspaces: [{ path: '/work/alpha', title: 'alpha' }], onPickDirectory: pick });
  try {
    const group = reset.form.querySelector('fieldset[data-group-workspace]') as HTMLElement;
    await click(button(group, en.ui['groups.workspaceChoose'])); await click(button(group, '/work/alpha'));
    await click(button(group, en.ui['groups.workspaceChoose'])); await click(button(group, en.ui['groups.workspaceUseDefault']));
    expect(group.textContent).toContain(en.ui['groups.workspaceDefault']);
    expect(await reset.save()).not.toHaveProperty('cwd');
  } finally { await reset.close(); }
});

it('keeps a typed path without a Host picker and reports a failed picker', async () => {
  const typed = await mountCreate({});
  try {
    const group = typed.form.querySelector('fieldset[data-group-workspace]') as HTMLElement;
    await click(button(group, en.ui['groups.workspaceChoose']));
    expect([...group.querySelectorAll('[role="menuitem"]')].map(row => row.textContent)).toEqual([en.ui['groups.workspaceUseDefault']]);
    const input = group.querySelector(`input[aria-label="${en.ui['groups.workspacePath']}"]`) as HTMLInputElement;
    await fill(input, '/typed/project');
    expect((await typed.save())?.cwd).toBe('/typed/project');
  } finally { await typed.close(); }
  const failing = await mountCreate({ onPickDirectory: vi.fn(async () => { throw new Error('picker offline'); }) });
  try {
    const group = failing.form.querySelector('fieldset[data-group-workspace]') as HTMLElement;
    await click(button(group, en.ui['groups.workspaceChoose'])); await click(button(group, en.ui['groups.workspaceOtherFolder']));
    await vi.waitFor(() => expect(group.querySelector('[role="alert"]')?.textContent).toBe(en.ui['groups.workspacePickFailed']));
    expect(group.textContent).toContain(en.ui['groups.workspaceDefault']);
  } finally { await failing.close(); }
});
