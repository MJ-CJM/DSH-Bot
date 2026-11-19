// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GroupConversation, GroupEditor } from '../../src/client/components/GroupsPanel.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import { GROUP_MEMBER_LIMIT } from '../../src/shared/group-limits.js';
import { bots as fixtureBots, view } from './group-fixture.js';
import { button, click, fill } from './helpers.js';
import { requireValue } from './test-required.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

const bots = Array.from({ length: 9 }, (_, index) => ({ ...requireValue(fixtureBots[0]), id: `bot-${index}`, name: `Bot ${index}` }));
const translate = (language: 'en' | 'zh') => ((key: keyof typeof en.ui, params?: Record<string, unknown>) =>
  (language === 'en' ? en : zh).ui[key].replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];
function legacyGroup() {
  const data = view();
  data.members = bots.slice(0, 8).map((bot, order) => ({ ...requireValue(data.members[0]), id: `member:${bot.id}`,
    bot: { botId: bot.id, botCreatedAt: bot.createdAt }, order, enabled: order !== 0,
    ...(order === 7 ? { removedAt: 1 } : {}),
  }));
  return data;
}

it.each(['en', 'zh'] as const)('%s caps selection at six, permits deselection and preserves all fields after a Host limit rejection', async language => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div'), root = createRoot(element), t = translate(language);
  document.body.append(element);
  const onSave = vi.fn<Parameters<typeof GroupEditor>[0]['onSave']>(async () => { throw { code: 'dsh-bot/member-limit' }; });
  try {
    await act(async () => root.render(<GroupEditor bots={bots} onSave={onSave} onCancel={() => {}} t={t} />));
    const memberChecks = () => [...element.querySelectorAll<HTMLInputElement>('fieldset:first-of-type input[type="checkbox"]')];
    for (const check of memberChecks().slice(0, GROUP_MEMBER_LIMIT)) await click(check);
    expect(memberChecks().filter(check => check.checked)).toHaveLength(6);
    expect(memberChecks().filter(check => !check.checked).every(check => check.disabled)).toBe(true);
    expect(memberChecks().filter(check => check.checked).every(check => !check.disabled)).toBe(true);
    await click(requireValue(memberChecks()[0]));
    expect(memberChecks()[6]?.disabled).toBe(false);
    await click(requireValue(memberChecks()[6]));
    await fill(element.querySelector('input') as HTMLInputElement, 'My retained draft');
    const consent = element.querySelector('input[required]') as HTMLInputElement;
    await click(consent);
    expect(button(element, t('integrations.save')).disabled).toBe(false);
    await click(button(element, t('integrations.save')));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(t('groups.memberLimitFailed', { limit: 6 }));
    expect((element.querySelector('input') as HTMLInputElement).value).toBe('My retained draft');
    expect(consent.checked).toBe(true);
    expect(memberChecks().filter(check => check.checked)).toHaveLength(6);
    await click(requireValue(memberChecks()[1]));
    await click(consent);
    await click(button(element, t('integrations.save')));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({ name: 'My retained draft', members: expect.any(Array) });
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it('counts disabled members, ignores removed history and only allows reductions to an old oversized group', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div'), root = createRoot(element), t = translate('en');
  document.body.append(element);
  const onSave = vi.fn<Parameters<typeof GroupEditor>[0]['onSave']>(async () => {});
  try {
    await act(async () => root.render(<GroupEditor bots={bots} initial={legacyGroup()} onSave={onSave} onCancel={() => {}} t={t} />));
    const checks = () => [...element.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    expect(checks().filter(check => check.checked)).toHaveLength(7);
    expect(checks()[0]?.checked).toBe(true);
    expect(checks()[7]?.checked).toBe(false);
    expect(checks()[7]?.disabled).toBe(true);
    const consent = element.querySelector('input[required]') as HTMLInputElement;
    await click(consent);
    expect(button(element, t('integrations.save')).disabled).toBe(true);
    await click(requireValue(checks()[0]));
    await click(requireValue(checks()[1]));
    expect(checks().filter(check => check.checked)).toHaveLength(5);
    // Unsaved reductions never allow a replacement, even after falling below six.
    expect(checks()[0]?.disabled).toBe(true);
    expect(checks()[8]?.disabled).toBe(true);
    await click(consent);
    expect(button(element, t('integrations.save')).disabled).toBe(false);
    await click(button(element, t('integrations.save')));
    expect(onSave.mock.calls[0]?.[0].members.map(member => member.botId)).toEqual(bots.slice(2, 7).map(bot => bot.id));
  } finally { await act(async () => root.unmount()); element.remove(); }
});

it.each([false, true])('preserves a draft and prevents new work in an oversized group (workspace=%s)', async workspace => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = legacyGroup(), ctx = new Context(), element = document.createElement('div'), root = createRoot(element), t = translate('en');
  const send = vi.fn<GroupMethods['send']>();
  const summary = { ...data, turns: undefined, deliveries: undefined, messages: undefined, hasEarlier: undefined };
  ctx.provide('remote.dshBot.groups', { view: async () => ({ ok: true, value: data }), list: async () => ({ ok: true, value: [summary] }), send } as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {});
  try {
    await act(async () => root.render(<GroupConversation workspace={workspace} summary={summary} actions={actions} bots={bots}
      expandedTurns={{}} onExpandTurn={() => {}} onOpenSession={async () => {}} t={t} />));
    const draft = element.querySelector('textarea') as HTMLTextAreaElement;
    await fill(draft, 'Keep my unfinished question');
    expect(element.textContent).toContain(t('groups.memberLimitBlocked', { limit: 6 }));
    expect(button(element, t('groups.send')).disabled).toBe(true);
    await act(async () => element.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).not.toHaveBeenCalled();
    expect(draft.value).toBe('Keep my unfinished question');
    expect(actions.draft(data.group.rootSessionId).text).toBe('Keep my unfinished question');
  } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); }
});

it('reveals and focuses the editor once, without stealing focus on a same-group refresh', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div'), root = createRoot(element), data = legacyGroup(), t = translate('en');
  document.body.append(element);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView'), scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const render = () => act(async () => root.render(<GroupEditor bots={bots} initial={{ ...data }} onSave={async () => {}} onCancel={() => {}} t={t} />));
  try {
    await render();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    expect(document.activeElement).toBe(element.querySelector('input'));
    const checkbox = element.querySelector('fieldset input') as HTMLInputElement;
    checkbox.focus(); await render();
    expect(document.activeElement).toBe(checkbox);
    expect(scroll).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); element.remove();
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});
