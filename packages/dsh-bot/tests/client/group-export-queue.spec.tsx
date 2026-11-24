// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { GroupExportQueue } from '../../src/client/components/GroupExportQueue.js';
import type { GroupActions } from '../../src/client/groups-state.js';
import type { GroupMethods } from '../../src/shared/groups-contract.js';
import type { GroupDelivery } from '../../src/shared/groups.js';
import { bots, view } from './group-fixture.js';
import { button, click } from './helpers.js';
import en from '../../locale/en.json';
import zh from '../../locale/zh.json';

async function mount(language: 'en' | 'zh' = 'en') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const data = view(), key = { groupId: data.group.id, groupCreatedAt: data.group.createdAt };
  data.turns = [1, 2].map(index => ({ id: `turn:${index}`, group: key, operationId: `op:${index}`, requestDigest: 'digest',
    inputMessageId: `question:${index}`, createdAt: index, updatedAt: index, revision: 1, schemaVersion: 1,
    membershipRevision: 1, orderedMemberIds: ['member:alpha', 'member:beta'], mode: 'natural', state: 'partial', contextThroughSeq: 1 }));
  data.messages = [1, 2].map(index => ({ id: `question:${index}`, seq: index, at: index, text: `Question ${index}`, turnId: `turn:${index}`, authorKind: 'user' }));
  data.deliveries = Array.from({ length: 6 }, (_, index) => ({ id: `delivery:${index}`, turnId: `turn:${index < 3 ? 1 : 2}`, revision: 1,
    memberId: index % 2 ? 'member:beta' : 'member:alpha', ordinal: index, bot: { botId: index % 2 ? 'beta' : 'alpha', botCreatedAt: bots[index % 2]?.createdAt ?? 1 },
    botRevision: 1, presetId: 'bot-alpha', contextOutputMessageIds: [], contextTruncated: false, state: 'failed', reasonCode: 'export-approval-required',
    exportFlowId: crypto.randomUUID(), stopReason: 'completed' } satisfies GroupDelivery));
  const reviewExport = vi.fn<GroupMethods['reviewExport']>(async (_key, id) => ({ ok: true, value: {
    token: id.padEnd(64, '0'), deliveryRevision: 1, flowId: data.deliveries.find(row => row.id === id)?.exportFlowId ?? crypto.randomUUID(),
    groupName: data.group.name, recipients: data.members.map(member => ({ bot: member.bot, name: member.bot.botId })),
    content: `PRIVATE ${id} <img src="https://invalid.example/private">`,
  } }));
  const decideExport = vi.fn<GroupMethods['decideExport']>(async () => ({ ok: true, value: true }));
  const discardExport = vi.fn<GroupMethods['discardExport']>(async () => ({ ok: true, value: true }));
  const closeStaleExports = vi.fn<GroupMethods['closeStaleExports']>(async () => ({ ok: true, value: { closed: 0 } }));
  const refresh = vi.fn(async () => {});
  const actions = { remote: () => ({ reviewExport, decideExport, discardExport, closeStaleExports }), messageView: () => ({ refresh }), catalog: { refresh } } as unknown as GroupActions;
  const element = document.createElement('div'), root = createRoot(element); document.body.append(element);
  const t = ((key: keyof typeof en.ui, params?: Record<string, unknown>) => (language === 'en' ? en : zh).ui[key]
    .replace(/\{(\w+)\}/g, (_match, name) => String(params?.[name] ?? `{${name}}`))) as PropsLocale<'dsh-bot'>['t'];
  const render = async () => act(async () => root.render(<GroupExportQueue view={data} bots={bots} actions={actions} t={t} />));
  await render();
  expect(element.querySelector('[data-export-batch-summary]')).toBeTruthy();
  expect(element.querySelector('[data-group-export-review]')).toBeNull();
  await click(button(element, t('groups.export.queueCount', { count: 6 })));
  const row = (index: number) => element.querySelector<HTMLElement>(`[data-group-export-review="delivery:${index}"]`) as HTMLElement;
  const preview = async (index: number) => click(button(row(index), t('groups.export.review')));
  const select = async (index: number) => click(row(index).querySelector('input') as HTMLInputElement);
  return { data, element, row, root, render, t, preview, select, reviewExport, decideExport, discardExport, closeStaleExports, refresh,
    close: async () => { await act(async () => root.unmount()); element.remove(); } };
}

it.each(['en', 'zh'] as const)('%s groups six pending replies by turn and batches only individually previewed selections once', async language => {
  const f = await mount(language);
  try {
    expect(f.element.querySelectorAll('h4')).toHaveLength(2);
    expect(f.element.textContent).toContain('Question 1'); expect(f.element.textContent).toContain('Question 2');
    expect(f.element.textContent).not.toContain('PRIVATE');
    expect(f.element.querySelectorAll('input:disabled')).toHaveLength(6);
    await f.preview(0); await f.preview(1);
    expect(f.row(0).querySelector('pre')?.textContent).toContain('PRIVATE delivery:0');
    expect(f.element.querySelector('img')).toBeNull();
    expect(f.row(0).textContent).toContain('alpha'); expect(f.row(0).textContent).toContain('beta');
    expect((f.row(0).querySelector('input') as HTMLInputElement).checked).toBe(false);
    await f.select(0); await f.select(1);
    const send = button(f.element, f.t('groups.export.sendSelection', { count: 2, group: f.data.group.name, readers: 2 }));
    await act(async () => { send.click(); send.click(); });
    expect(f.decideExport.mock.calls.map(call => [call[1], call[3]])).toEqual([['delivery:0', true], ['delivery:1', true]]);
    expect(f.element.querySelectorAll('pre')).toHaveLength(0);
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.reviewExport).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('%s opens the latest round with one click and sends only checked complete replies on a separate confirmation', async language => {
  const f = await mount(language);
  try {
    await click(button(f.element, f.t('groups.export.queueCount', { count: 6 })));
    await click(button(f.element, f.t('groups.export.reviewRound', { count: 3 })));
    expect(f.reviewExport.mock.calls.map(call => call[1])).toEqual(['delivery:3', 'delivery:4', 'delivery:5']);
    expect(f.decideExport).not.toHaveBeenCalled();
    expect(f.element.querySelectorAll('pre')).toHaveLength(3);
    expect(f.element.querySelectorAll('input:checked')).toHaveLength(3);
    expect(f.element.querySelectorAll('[data-send-one]')).toHaveLength(0);
    expect(f.row(2)).toBeNull();
    for (const index of [3, 4, 5]) await f.select(index);
    expect(f.element.querySelector('[data-send-selection]')).toBeNull();
    for (const index of [3, 5]) await f.select(index);
    await click(button(f.element, f.t('groups.export.sendSelection', { count: 2, group: f.data.group.name, readers: 2 })));
    expect(f.decideExport.mock.calls.map(call => call.slice(1))).toEqual([3, 5].map(index => [
      `delivery:${index}`, `delivery:${index}`.padEnd(64, '0'), true,
    ]));
    expect(f.row(4).querySelector('pre')).toBeTruthy();
    expect(f.row(4).querySelector<HTMLInputElement>('input')?.checked).toBe(false);
  } finally { await f.close(); }
});

it('freezes the displayed list and reading position while additional replies arrive in the same round', async () => {
  const f = await mount();
  try {
    await click(f.element.querySelector<HTMLButtonElement>('[data-review-round="turn:2"]')!);
    const reading = f.row(4).querySelector('pre')!, list = f.element.querySelector<HTMLElement>('[id]')!;
    reading.focus(); list.scrollTop = 80;
    f.data.deliveries = [{ ...f.data.deliveries[5]!, id: 'delivery:6', exportFlowId: crypto.randomUUID() }, ...f.data.deliveries];
    await f.render();
    expect(f.row(6)).toBeNull();
    expect(document.activeElement).toBe(reading);
    expect(list.scrollTop).toBe(80);
    expect([...f.element.querySelectorAll('input:checked')]).toHaveLength(3);
    expect(f.reviewExport).toHaveBeenCalledTimes(3);
    await click(f.element.querySelector<HTMLButtonElement>('[data-other-replies]')!);
    expect(f.row(6).querySelector('pre')).toBeNull();
    expect(f.row(6).querySelector<HTMLInputElement>('input')?.checked).toBe(false);
    expect(f.decideExport).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps changed and mismatched-audience replies outside the confirmed selection and reports individual review failures', async () => {
  const f = await mount();
  try {
    const success = f.reviewExport.getMockImplementation()!;
    f.reviewExport.mockImplementation(async (group, id) => {
      const response = await success(group, id);
      if (!response.ok) return response;
      if (id === 'delivery:4') {
        response.value.recipients[1] = { ...response.value.recipients[0]! };
      }
      if (id === 'delivery:5') {
        response.value.deliveryRevision++;
      }
      return response;
    });
    await click(f.element.querySelector<HTMLButtonElement>('[data-review-round="turn:2"]')!);
    for (const index of [4, 5]) {
      expect(f.row(index).querySelector('pre')).toBeNull();
      expect(f.row(index).textContent).toContain(f.t('groups.export.receipt.changed'));
    }
    expect(f.element.querySelectorAll('input:checked')).toHaveLength(1);
    await click(button(f.element, f.t('groups.export.sendSelection', { count: 1, group: f.data.group.name, readers: 2 })));
    expect(f.decideExport.mock.calls.map(call => call[1])).toEqual(['delivery:3']);
  } finally { await f.close(); }
});

it('reports partial batch failures per item, never retries unknown, and distinguishes sent content from failed preference or receipt writes', async () => {
  const f = await mount();
  try {
    for (let index = 0; index < 3; index++) { await f.preview(index); await f.select(index); }
    f.decideExport.mockResolvedValueOnce({ ok: true, value: true })
      .mockRejectedValueOnce({ code: 'dsh-bot/recovery-needed' })
      .mockRejectedValueOnce({ code: 'dsh-bot/group-export-preference-failed' });
    await click(button(f.element, f.t('groups.export.sendSelection', { count: 3, group: f.data.group.name, readers: 2 })));
    expect(f.decideExport).toHaveBeenCalledTimes(3);
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.uncertain'));
    expect(f.row(2).textContent).toContain(f.t('groups.export.receipt.preferenceFailed'));
    await f.preview(3);
    f.decideExport.mockRejectedValueOnce({ code: 'dsh-bot/group-export-sent-receipt-failed' });
    await click(button(f.row(3), f.t('groups.export.sendToGroup', { group: f.data.group.name, readers: 2 })));
    expect(f.row(3).textContent).toContain(f.t('groups.export.receipt.sentReceiptFailed'));
    expect(f.row(1).querySelector('pre')).toBeNull();
    expect([...f.row(1).querySelectorAll('button')].some(node => node.textContent === f.t('groups.export.review'))).toBe(false);
    f.data.group = { ...f.data.group, membershipRevision: 2 };
    await f.render(); expect(f.decideExport).toHaveBeenCalledTimes(4);
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.uncertain'));
    expect([...f.row(1).querySelectorAll('button')].some(node => node.textContent === f.t('groups.export.review'))).toBe(false);
  } finally { await f.close(); }
});

it.each(['en', 'zh'] as const)('%s removes stale reviews and their private previews while preserving a selected current review', async language => {
  const f = await mount(language);
  try {
    await f.preview(0); await f.select(0);
    f.data.group = { ...f.data.group, membershipRevision: 2 };
    f.data.turns = f.data.turns.map((turn, index) => index === 1 ? { ...turn, membershipRevision: 2 } : turn);
    f.data.deliveries = f.data.deliveries.map((delivery, index) => index === 1
      ? { ...delivery, state: 'unknown', reasonCode: 'native-failure', exportFlowId: undefined } : delivery);
    await f.render();
    expect(f.element.querySelector('[data-group-expired-exports]')?.getAttribute('data-expired-count')).toBe('3');
    expect(f.element.textContent).toContain(f.t('groups.export.expiredReason'));
    expect(button(f.element, f.t('groups.export.queueCount', { count: 3 }))).toBeTruthy();
    expect([...f.element.querySelectorAll('button')].some(node => node.textContent === f.t('groups.export.clearReceipts'))).toBe(false);
    expect(f.row(0)).toBeNull(); expect(f.row(1)).toBeNull();
    expect(f.element.textContent).not.toContain('PRIVATE delivery:0');
    expect(f.decideExport).not.toHaveBeenCalled(); expect(f.discardExport).not.toHaveBeenCalled();

    await f.preview(3); await f.select(3);
    const original = f.data.deliveries.slice(0, 3);
    f.closeStaleExports.mockImplementationOnce(async () => {
      f.data.deliveries = f.data.deliveries.map((delivery, index) => index < 3 ? { ...delivery, staleExportClosedAt: 100 } : delivery);
      return { ok: true, value: { closed: 3 } };
    });
    const closeButton = button(f.element, f.t('groups.export.closeExpired'));
    await act(async () => { closeButton.click(); closeButton.click(); });
    await f.render();
    expect(f.closeStaleExports).toHaveBeenCalledExactlyOnceWith({ groupId: f.data.group.id, groupCreatedAt: f.data.group.createdAt }, 2);
    expect(f.element.querySelector('[data-group-expired-exports]')).toBeNull();
    expect(f.element.querySelector('[data-stale-exports-result]')?.getAttribute('data-closed-count')).toBe('3');
    expect(f.data.deliveries.slice(0, 3)).toEqual(original.map(delivery => ({ ...delivery, staleExportClosedAt: 100 })));
    expect((f.row(3).querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(f.row(3).querySelector('pre')?.textContent).toContain('PRIVATE delivery:3');
    await click(button(f.element, f.t('groups.export.sendSelection', { count: 1, group: f.data.group.name, readers: 2 })));
    expect(f.decideExport.mock.calls.map(call => call[1])).toEqual(['delivery:3']);
  } finally { await f.close(); }
});

it('offers bulk close when every reply expired and keeps the list after a conflicting close', async () => {
  const f = await mount();
  try {
    f.data.group = { ...f.data.group, membershipRevision: 2 };
    await f.render();
    expect(f.element.querySelector('[data-group-expired-exports]')?.getAttribute('data-expired-count')).toBe('6');
    expect(f.element.querySelector('button[aria-expanded]')).toBeNull();
    expect(f.element.querySelectorAll('[data-group-export-review]')).toHaveLength(0);
    f.closeStaleExports.mockRejectedValueOnce({ code: 'dsh-bot/conflict' });
    await click(button(f.element, f.t('groups.export.closeExpired')));
    expect(f.element.querySelector('[data-stale-exports-result]')?.textContent).toBe(f.t('groups.export.closeExpiredResult.conflict'));
    expect(f.element.querySelector('[data-group-expired-exports]')?.getAttribute('data-expired-count')).toBe('6');
    expect(f.refresh).toHaveBeenCalledTimes(2);
    expect(button(f.element, f.t('groups.export.closeExpired')).disabled).toBe(false);
    expect(f.reviewExport).not.toHaveBeenCalled(); expect(f.decideExport).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('discards a known invalid current review without revealing content', async () => {
  const f = await mount();
  try {
    f.reviewExport.mockRejectedValueOnce({ code: 'dsh-bot/group-data-blocked' });
    await f.preview(1);
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.unavailable'));
    expect(button(f.element, f.t('groups.export.queueCount', { count: 6 }))).toBeTruthy();
    await click(button(f.row(1), f.t('groups.export.reject')));
    expect(f.discardExport).toHaveBeenCalledWith({ groupId: f.data.group.id, groupCreatedAt: f.data.group.createdAt }, 'delivery:1', 1);
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.rejected'));
  } finally { await f.close(); }
});

it('defers a reply without granting or denying it and restores the pending item on request', async () => {
  const f = await mount();
  try {
    await f.preview(0); await f.select(0);
    await click(button(f.row(0), f.t('groups.export.close')));
    expect(f.row(0)).toBeNull();
    expect(f.decideExport).not.toHaveBeenCalled(); expect(f.discardExport).not.toHaveBeenCalled();
    await click(button(f.element, f.t('groups.export.showLater', { count: 1 })));
    expect(f.row(0).querySelector('pre')).toBeNull();
    expect((f.row(0).querySelector('input') as HTMLInputElement).disabled).toBe(true);
    await f.preview(0);
    expect(f.reviewExport).toHaveBeenCalledTimes(2);
    expect((f.row(0).querySelector('input') as HTMLInputElement).checked).toBe(false);
  } finally { await f.close(); }
});

it('keeps the message-box focus when a delayed preview arrives after the user resumes typing', async () => {
  const f = await mount(), input = document.createElement('textarea');
  document.body.append(input);
  let settle: (value: Awaited<ReturnType<GroupMethods['reviewExport']>>) => void = () => {};
  f.reviewExport.mockReturnValueOnce(new Promise(accept => { settle = accept; }));
  try {
    const trigger = button(f.row(0), f.t('groups.export.review'));
    trigger.focus(); await click(trigger);
    input.value = 'My untouched draft'; input.focus();
    await act(async () => settle({ ok: true, value: { token: 't'.repeat(64), flowId: f.data.deliveries[0]?.exportFlowId ?? crypto.randomUUID(),
      deliveryRevision: 1, groupName: f.data.group.name, recipients: f.data.members.map(m => ({ bot: m.bot, name: m.bot.botId })), content: 'PRIVATE_DELAYED_REPLY' } }));
    await vi.waitFor(() => expect(f.row(0).querySelector('pre')?.textContent).toBe('PRIVATE_DELAYED_REPLY'));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(input); expect(input.value).toBe('My untouched draft');
    f.data.deliveries = [...f.data.deliveries]; await f.render();
    expect(document.activeElement).toBe(input);
  } finally { input.remove(); await f.close(); }
});

it('keeps the exact legacy reconciliation revision and a sent receipt after the pending delivery disappears', async () => {
  const f = await mount(), delivery = f.data.deliveries[0] as GroupDelivery;
  try {
    f.data.deliveries[0] = { ...delivery, state: 'unknown', reasonCode: 'native-failure', exportFlowId: undefined };
    await f.render();
    const flowId = crypto.randomUUID();
    f.reviewExport.mockImplementationOnce(async () => {
      f.data.deliveries[0] = { ...delivery, revision: 2, exportFlowId: flowId };
      return { ok: true, value: { token: 'r'.repeat(64), flowId, deliveryRevision: 2, groupName: f.data.group.name, recipients: f.data.members.map(m => ({ bot: m.bot, name: m.bot.botId })), content: 'Recovered exact reply' } };
    });
    await f.preview(0); await f.render();
    f.decideExport.mockImplementationOnce(async () => {
      f.data.deliveries[0] = { ...delivery, revision: 3, reasonCode: undefined, exportFlowId: undefined, state: 'completed' };
      return { ok: true, value: true };
    });
    await click(button(f.row(0), f.t('groups.export.sendToGroup', { group: f.data.group.name, readers: 2 }))); await f.render();
    expect(f.decideExport).toHaveBeenCalledTimes(1);
    expect(f.decideExport.mock.calls[0]?.[2]).toBe('r'.repeat(64));
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.row(0).querySelector('pre')).toBeNull();
  } finally { await f.close(); }
});

it('clears selections from a different round so one batch can never span two questions', async () => {
  const f = await mount();
  try {
    await f.preview(0); await f.select(0);
    await f.preview(3); await f.select(3);
    expect((f.row(0).querySelector('input') as HTMLInputElement).checked).toBe(false);
    expect((f.row(3).querySelector('input') as HTMLInputElement).checked).toBe(true);
    await click(button(f.element, f.t('groups.export.sendSelection', { count: 1, group: f.data.group.name, readers: 2 })));
    expect(f.decideExport.mock.calls.map(call => call[1])).toEqual(['delivery:3']);
    expect(f.row(0).querySelector('pre')).toBeTruthy();
  } finally { await f.close(); }
});

it('reconciles an uncertain decision from the exact published or rejected delivery without dispatching', async () => {
  const f = await mount();
  try {
    for (const index of [0, 1]) {
      await f.preview(index);
      f.decideExport.mockRejectedValueOnce(new Error('Response lost'));
      await click(button(f.row(index), f.t('groups.export.sendToGroup', { group: f.data.group.name, readers: 2 })));
    }
    f.data.deliveries = f.data.deliveries.map((row, i) => i > 1 ? row : { ...row, revision: 2, exportFlowId: undefined,
      ...(i === 0 ? { state: 'completed', outputMessageId: 'published', outputSeq: 99, reasonCode: undefined }
        : { state: 'failed', reasonCode: 'export-rejected' }) });
    await f.render();
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.sent'));
    expect(f.row(1).textContent).toContain(f.t('groups.export.receipt.rejected'));
    await click(button(f.element, f.t('groups.export.clearReceipts')));
    expect(f.row(0)).toBeNull(); expect(f.row(1)).toBeNull();
    expect(f.decideExport).toHaveBeenCalledTimes(2);
  } finally { await f.close(); }
});

it('rechecks an unchanged pending decision with a fresh Host preview and no selection', async () => {
  const f = await mount();
  try {
    await f.preview(0);
    f.decideExport.mockRejectedValueOnce(new Error('Response lost'));
    await click(button(f.row(0), f.t('groups.export.sendToGroup', { group: f.data.group.name, readers: 2 })));
    await click(button(f.row(0), f.t('groups.export.checkReceipt')));
    expect(f.reviewExport).toHaveBeenCalledTimes(2);
    expect(f.row(0).querySelector('pre')).not.toBeNull();
    expect(f.row(0).querySelector<HTMLInputElement>('input')?.checked).toBe(false);
    expect(f.decideExport).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});

it('separates a private outside answer for the requesting member from that member’s group report', async () => {
  const f = await mount('zh');
  try {
    const turn = f.data.turns[0]!, outside = f.data.deliveries[0]!, member = f.data.deliveries[1]!;
    const via = { name: 'Alpha', bot: member.bot, memberId: member.memberId, botRevision: 1, presetId: member.presetId };
    turn.guestQuestion = { name: 'Jarvis', bot: outside.bot, via };
    await f.render();
    await click(f.element.querySelector<HTMLButtonElement>('[data-review-round="turn:1"]')!);
    expect(f.reviewExport.mock.calls.map(call => call[1])).toEqual(['delivery:1', 'delivery:2']);
    expect(f.row(0)).toBeNull();
    await click(f.element.querySelector<HTMLButtonElement>('[data-other-replies]')!);
    const review = () => click(button(f.row(0), f.t('groups.relay.reviewHandoff', { sender: via.name })));
    await review();
    expect(f.row(0).querySelector('pre')).toBeNull();
    expect(f.row(0).textContent).toContain(f.t('groups.export.receipt.changed'));
    f.reviewExport.mockResolvedValueOnce({ ok: true, value: { token: 'a'.repeat(64), deliveryRevision: 1,
      flowId: outside.exportFlowId!, groupName: f.data.group.name, recipients: [{ bot: via.bot, name: via.name }], content: 'Only for Alpha' } });
    await review();
    expect(f.row(0).textContent).toContain(f.t('groups.relay.handoffScope', { sender: via.name }));
    expect(f.row(0).textContent).not.toContain(f.t('groups.export.policySettingsHint'));
    await click(button(f.row(0), f.t('groups.relay.approveHandoff', { sender: via.name })));
    expect(f.row(0).textContent).toContain(f.t('groups.relay.handoffApproved', { sender: via.name }));
    expect(f.row(0).querySelector('input')).toBeNull();
    expect(f.row(1).textContent).toContain(f.t('groups.export.scope', { group: f.data.group.name, members: 'alpha、beta' }));
    expect(f.row(1).textContent).not.toContain(f.t('groups.relay.handoffScope', { sender: via.name }));
  } finally { await f.close(); }
});
