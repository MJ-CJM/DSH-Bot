// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { TeamRecipes } from '../../src/client/components/TeamRecipes.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import type { TeamRecipe } from '../../src/shared/team-recipes.js';
import { view } from './group-fixture.js';
import { button, click, fill } from './helpers.js';
import en from '../../locale/en.json';
const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => en.ui[key]
  .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];

it('captures, previews and explicitly applies a mapped recipe, and rejects unsupported imports before Remote', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view();
  const recipe: TeamRecipe = { format: 'dsh-bot-team', version: 1, name: 'Portable', mode: 'natural', onDemand: false,
    roles: data.members.map((member, index) => ({ id: `role-${index}`, role: index ? 'CSS' : 'SQL', preferredBotId: member.bot.botId, template: 'standard' })) };
  const preview = { recipe, roles: data.members.map((member, index) => ({ roleId: `role-${index}`, bot: member.bot,
    match: 'preferred', capabilityMatch: true, candidates: data.members.map(row => ({ bot: row.bot, name: row.bot.botId, template: 'standard' })) })) };
  const remote = { teamList: vi.fn(async () => ({ ok: true, value: [] })), teamCapture: vi.fn(async () => ({ ok: true, value: recipe })),
    teamPreview: vi.fn(async () => ({ ok: true, value: preview })), teamSave: vi.fn(async () => ({ ok: true, value: { id: 'saved-1', savedAt: 1, recipe } })),
    teamApply: vi.fn(async () => ({ ok: true, value: data.group })) };
  const actions = { remote: () => remote } as unknown as GroupActions;
  const element = document.createElement('div'), root = createRoot(element), onSaved = vi.fn(async () => {}), onClose = vi.fn();
  try {
    await act(async () => root.render(<TeamRecipes view={data} actions={actions} onSaved={onSaved} onClose={onClose} t={t} />));
    await click(button(element, en.ui['teams.capture']));
    expect(element.querySelector('[data-team-preview]')).toBeTruthy();
    expect(element.textContent).toContain('SQL'); expect(element.textContent).toContain('CSS');
    expect(remote.teamApply).not.toHaveBeenCalled();
    await click(button(element, en.ui['teams.save']));
    expect(remote.teamSave).toHaveBeenCalledWith(recipe);
    await click(button(element, en.ui['teams.apply']));
    expect(remote.teamApply).toHaveBeenCalledWith({ groupId: data.group.id, groupCreatedAt: data.group.createdAt }, recipe,
      data.members.map((member, index) => ({ roleId: `role-${index}`, bot: member.bot })), data.group.revision, data.group.membershipRevision);
    expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
    const count = remote.teamPreview.mock.calls.length;
    await fill(element.querySelector('textarea') as HTMLTextAreaElement, JSON.stringify({ ...recipe, version: 2 }));
    await click(button(element, en.ui['teams.preview']));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.ui['teams.failed']);
    expect(remote.teamPreview.mock.calls).toHaveLength(count);
    expect(element.querySelector('[data-team-preview]')).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it('rejects oversized recipe imports locally, retains the JSON draft and still exposes saved recipes after a capture refusal', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view();
  const recipe: TeamRecipe = { format: 'dsh-bot-team', version: 1, name: 'Saved team', mode: 'natural', onDemand: false,
    roles: data.members.map((member, index) => ({ id: `role-${index}`, role: member.bot.botId, preferredBotId: member.bot.botId, template: 'standard' })) };
  const remote = { teamList: vi.fn(async () => ({ ok: true, value: [{ id: 'saved', recipe }] })),
    teamCapture: vi.fn(async () => ({ ok: false, error: { code: 'dsh-bot/member-limit' } })), teamPreview: vi.fn() };
  const actions = { remote: () => remote } as unknown as GroupActions;
  const element = document.createElement('div'), root = createRoot(element);
  const large = JSON.stringify({ ...recipe, roles: Array.from({ length: 7 }, (_, index) => ({ ...recipe.roles[0], id: `role-${index}` })) });
  try {
    await act(async () => root.render(<TeamRecipes view={data} actions={actions} onSaved={async () => {}} onClose={() => {}} t={t} />));
    expect(element.textContent).toContain('Saved team');
    await fill(element.querySelector('textarea') as HTMLTextAreaElement, large);
    await click(button(element, en.ui['teams.preview']));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(t('groups.memberLimitFailed', { limit: 6 }));
    expect((element.querySelector('textarea') as HTMLTextAreaElement).value).toBe(large);
    expect(remote.teamPreview).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});
