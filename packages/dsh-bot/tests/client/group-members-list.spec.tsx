// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { expect, it, vi } from 'vitest';
import { GroupMembersList } from '../../src/client/components/GroupOverview.js';
import { createGroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupDelivery, GroupSummary, GroupView } from '../../src/shared/groups.js';
import type { BotRecord } from '../../src/shared/schema.js';
import { bots, view } from './group-fixture.js';
import { click } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

async function fixture(language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context();
  let data: GroupView = view(), registry: BotRecord[] = bots.map((bot, i) => ({ ...bot, description: `Responsibility ${i}` }));
  const remote = { view: vi.fn(async () => ({ ok: true, value: data })), list: vi.fn(async () => ({ ok: true, value: [] })) };
  ctx.provide('remote.dshBot.groups', remote as unknown as GroupMethods);
  const actions = createGroupActions(ctx, {}), onOpenBot = vi.fn();
  const createView = actions.createView;
  const stores: ReturnType<typeof createView>[] = [];
  vi.spyOn(actions, 'createView').mockImplementation(key => {
    const store = createView(key); vi.spyOn(store, 'dispose'); stores.push(store); return store;
  });
  const followup = { summary: vi.fn(), page: vi.fn() };
  actions.followUp = followup as unknown as NonNullable<typeof actions.followUp>;
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? name))) as PropsLocale<'dsh-bot'>['t'];
  const element = document.createElement('main'), root = createRoot(element);
  let summary: GroupSummary = data;
  const render = (strict = false) => act(async () => {
    const list = <GroupMembersList summary={summary} actions={actions} bots={registry} onOpenBot={onOpenBot} t={t} />;
    root.render(strict ? <StrictMode>{list}</StrictMode> : list);
  });
  return { element, remote, actions, stores, onOpenBot, followup, t, render,
    data: () => data,
    bots: () => registry,
    setBots(value: BotRecord[]) { registry = value; },
    async navigate(value: GroupSummary) { summary = value; await render(); },
    async refresh() { await act(async () => { await stores.at(-1)?.refresh(); }); },
    async close() { await act(async () => root.unmount()); await ctx.fiber.dispose(); },
  };
}

it.each(['en', 'zh'] as const)('%s compact members preserve real roles, state and model sources and only navigate exact Bots', async language => {
  const f = await fixture(language);
  try {
    const data = f.data(), alpha = data.members[0], beta = data.members[1];
    if (!alpha || !beta) throw new Error('Missing roster');
    data.group.memberModelSelections = [{ memberId: alpha.id, modelSelection: { provider: 'native-provider', model: 'member-model' } }];
    data.members.push({ ...alpha, id: 'removed-member', enabled: false, removedAt: 10 });
    const delivery: GroupDelivery = { id: 'real-delivery', turnId: 'real-turn', memberId: alpha.id, ordinal: 0,
      bot: alpha.bot, botRevision: 1, presetId: 'bot-alpha', contextOutputMessageIds: [], contextTruncated: false,
      state: 'completed', startedAt: 10 };
    data.deliveries = [delivery, { ...delivery, id: 'wrong-generation', bot: { ...alpha.bot, botCreatedAt: 999 }, state: 'running', startedAt: 20 }];
    await f.render();
    await vi.waitFor(() => expect(f.element.querySelectorAll('[data-group-member]')).toHaveLength(2));
    const row = f.element.querySelector('[data-group-member="member:alpha"]');
    expect(row?.textContent).toContain('Responsibility 0');
    expect(row?.textContent).toContain('native-provider / member-model');
    expect(row?.textContent).toContain(f.t('groups.modelSourceMember'));
    expect(row?.getAttribute('data-group-member-state')).toBe('completed');
    expect(row?.querySelector('[data-bot-avatar]')?.getAttribute('data-avatar-variant')).toBe('glasses');
    expect(f.element.querySelector('[data-group-member="member:beta"]')?.textContent).toContain(f.t('groups.modelSourceDsh'));
    const navigate = row?.querySelector('button');
    if (!navigate) throw new Error('Missing existing Bot navigation');
    expect(navigate.getAttribute('aria-label')).toBe(`${f.bots()[0]!.name} · ${f.t('chat.profile')}`);
    expect(navigate.title).toBe(`${f.bots()[0]!.name} · ${f.t('chat.profile')}`);
    await click(navigate);
    expect(f.onOpenBot).toHaveBeenCalledExactlyOnceWith(f.bots()[0]);
    expect(f.followup.summary).not.toHaveBeenCalled(); expect(f.followup.page).not.toHaveBeenCalled();
    expect(f.element.querySelector('[data-follow-up]')).toBeNull();
    expect(f.element.querySelector('[data-group-overview]')).toBeNull();
    expect(f.element.querySelector('table, input, textarea, [data-group-statistics]')).toBeNull();
  } finally { await f.close(); }
});

it('a recreated Bot cannot supply a removed incarnation’s face, role, model or navigation', async () => {
  const f = await fixture();
  try {
    const original = f.bots()[0];
    if (!original) throw new Error('Missing original Bot');
    f.data().messages.push({ id: 'historical-alpha', seq: 2, at: 2, text: 'Public reply', turnId: 'old-turn',
      speaker: { bot: { botId: original.id, botCreatedAt: original.createdAt }, name: 'Original expert', avatar: '🧪' } });
    f.setBots([{ ...original, createdAt: 999, name: 'Wrong replacement', description: 'Private replacement role', model: { provider: 'replacement', model: 'private-model' } }]);
    await f.render();
    await vi.waitFor(() => expect(f.element.querySelector('[data-group-members-list]')).toBeTruthy());
    const row = f.element.querySelector('[data-group-member="member:alpha"]');
    expect(row?.textContent).toContain('Original expert');
    expect(row?.textContent).not.toContain('Wrong replacement');
    expect(row?.textContent).not.toContain('Private replacement role');
    expect(row?.textContent).not.toContain('private-model');
    expect(row?.getAttribute('data-group-member-state')).toBe('unavailable');
    expect(row?.querySelector('[data-bot-avatar]')?.textContent).toBe('🧪');
    expect(row?.querySelector('button')).toBeNull();
  } finally { await f.close(); }
});

it('retains a labelled prior roster on disconnection and disposes its view on a generation change', async () => {
  const f = await fixture();
  try {
    await f.render();
    await vi.waitFor(() => expect(f.element.querySelector('[data-group-members-list]')).toBeTruthy());
    f.remote.view.mockRejectedValueOnce(new Error('Disconnected')); await f.refresh();
    expect(f.element.querySelector('[role="alert"]')?.textContent).toContain(f.t('groups.disconnected'));
    expect(f.element.querySelectorAll('[data-group-member]')).toHaveLength(2);
    await f.navigate({ ...f.data(), group: { ...f.data().group, createdAt: 999 } });
    expect(f.stores[0]?.dispose).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.element.querySelector('[role="alert"]')).toBeTruthy());
    expect(f.element.querySelector('[data-group-member]')).toBeNull();
  } finally { await f.close(); }
  expect(f.stores[1]?.dispose).toHaveBeenCalledOnce();
});

it('recreates a usable view after a strict effect replay and releases every view on exit', async () => {
  const f = await fixture();
  try {
    await f.render(true);
    await vi.waitFor(() => expect(f.element.querySelectorAll('[data-group-member]')).toHaveLength(2));
    expect(f.stores).toHaveLength(2);
    expect(f.stores[0]?.dispose).toHaveBeenCalledOnce();
    expect(f.stores[1]?.dispose).not.toHaveBeenCalled();
  } finally { await f.close(); }
  expect(f.stores[1]?.dispose).toHaveBeenCalledOnce();
});
