// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ExecutionBridge } from '../../src/client/group-execution.js';
import { GroupStatsSource } from '../../src/client/group-statistics.js';
import { GroupStatisticsBar, GroupMemberStatistics } from '../../src/client/components/GroupStatistics.js';
import type { GroupDelivery, GroupTurn } from '../../src/shared/groups.js';
import { view } from './group-fixture.js';
import { click } from './helpers.js';
import en from '../../locale/en.json';

async function fixture() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), data = view(), releases: string[] = [], listeners = new Set<() => void>();
  const preference = { value: { performanceUsage: 'detailed' } };
  const form = { preference, getSnapshot() { return this.preference; }, subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; } };
  // Live native leases: retained minus released, with the peak since the last reset.
  const lease = { now: 0, peak: 0 };
  const retain = vi.fn((target: { childSessionId: string }) => {
    lease.now++; lease.peak = Math.max(lease.peak, lease.now);
    const usage = { uncachedInputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 20 };
    const binding = { session: { getSnapshot: () => ({ openState: 'ready' }), subscribe: () => () => {}, projections: {
      faceOf: (key: string) => ({ subscribe: () => () => {}, getSnapshot: () => key === 'tokenUsage' ? usage : undefined }),
    } } } as unknown as SessionBinding;
    return { binding, ready: Promise.resolve(binding), release: () => { lease.now--; releases.push(target.childSessionId); } };
  });
  const statistics = new GroupStatsSource(() => ({ retain }) as unknown as ISessions);
  const bridge = { ctx: { get: (name: string) => name === 'configForms' ? { get: () => form } : undefined }, statistics } as unknown as ExecutionBridge;
  for (let n = 0; n < 100; n++) {
    const id = `t${n}`;
    data.turns.push({ id, createdAt: n, state: 'idle', orderedMemberIds: Array.from({ length: 16 }, (_, m) => `m${m}`), inputMessageId: `q${n}` } as GroupTurn);
    data.messages.push({ id: `q${n}`, seq: n, at: n, text: `Question ${n}`, turnId: id, authorKind: 'user' });
    for (let m = 0; m < 16; m++) data.deliveries.push({ id: `${id}-d${m}`, turnId: id, memberId: `m${m}`, childSessionId: `${id}-c${m}`, state: 'completed', bot: { botId: 'alpha', botCreatedAt: 1 } } as GroupDelivery);
  }
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  // Like the framework seat: the namespace first, then the shared common vocabulary (native en values).
  const common: Record<string, string> = { 'number.thousand': '{value}K', 'number.million': '{value}M' };
  const t = ((key: string, params: Record<string, unknown> = {}) => {
    let text = en.ui[key as keyof typeof en.ui] ?? common[key] ?? key;
    for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value)); return text;
  }) as PropsLocale<'dsh-bot'>['t'];
  const render = async (sent?: { turnId: string; followup: boolean; sequence: number }) => act(async () => root.render(<GroupStatisticsBar view={data} bridge={bridge} sent={sent} t={t} />));
  await render();
  return { data, element,
    async renderMember() { await act(async () => root.render(<GroupMemberStatistics bridge={bridge} parentId="p" workers={data.deliveries.slice(0, 2).map(delivery => ({ delivery: { ...delivery, memberId: 'legacy', state: 'cancelled' }, conflict: false }))} t={t} />)); },
    retain, releases, form, listeners, render, lease,
    /** Let the native-ready microtasks of queued reads settle inside act. */
    async settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); },
    trigger: () => element.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement,
    rows: () => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')],
    async select(text: string) { await click(element.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement); const target = [...element.querySelectorAll('[role="menuitem"]')].find(b => b.querySelector('[data-statistics-question] span')?.textContent === text); assert.ok(target); await click(target as HTMLButtonElement); },
    async close() { await act(async () => root.unmount()); statistics.dispose(); await ctx.fiber.dispose(); element.remove(); } };
}
it('retains only 16 selected workers across 100 questions and never follows streaming updates after a manual choice', async () => {
  const f = await fixture();
  try {
    expect(f.retain).toHaveBeenCalledTimes(16); expect(f.element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('t99');
    await f.select('Question 0'); expect(f.releases).toHaveLength(16); expect(f.retain).toHaveBeenCalledTimes(32);
    assert.ok(f.data.turns[99]); f.data.turns[99].state = 'running'; await f.render();
    expect(f.element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('t0');
    await f.render({ turnId: 't99', followup: false, sequence: 1 });
    expect(f.element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('t99');
    await f.render({ turnId: 't0', followup: true, sequence: 2 });
    expect(f.element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('t0');
  } finally { await f.close(); }
  expect(f.releases).toHaveLength(f.retain.mock.calls.length); expect(f.listeners.size).toBe(0);
});
it('follows accepted native preference changes without displaying stale tokens', async () => {
  const f = await fixture();
  try {
    expect(f.element.querySelector('[data-group-token-total="2560"]')).not.toBeNull();
    await act(async () => { f.form.preference = { value: { performanceUsage: 'compact' } }; for (const listener of f.listeners) listener(); });
    expect(f.element.querySelector('[data-group-token-total]')).toBeNull(); expect(f.element.textContent).toContain('Cache hit 28.6%');
  } finally { await f.close(); }
});

it('formats tokens with the native common vocabulary and shows the turn status beside its state dot', async () => {
  const f = await fixture();
  try {
    expect(f.element.querySelector('[data-group-token-total="2560"]')?.textContent).toBe('2.6K tok');
    expect(f.element.querySelector('[data-group-usage]')?.textContent).toBe('2.6K tok·Cache hit 28.6%');
    assert.ok(f.data.turns[99]); f.data.turns[99].state = 'recovery_needed'; await f.render();
    const status = f.element.querySelector('[data-statistics-status]');
    expect(status?.querySelector('[data-state-dot]')?.getAttribute('data-state-dot')).toBe('warning');
    // One name per state: the bar and the menu use the group's own short wording.
    expect(status?.textContent).toBe(en.ui['statistics.status.recovery_needed']);
    expect(en.ui['statistics.status.recovery_needed']).toBe(en.ui['groups.recovery_needed']);
  } finally { await f.close(); }
});

it('names the followed question on the trigger and lists questions as native rows with time, status and members', async () => {
  const f = await fixture();
  try {
    const latest = f.data.messages.find(message => message.id === 'q99');
    assert.ok(latest && f.data.turns[0]);
    latest.text = '\n  Check   the\tbuild\nlog line 1\nlog line 2'; f.data.turns[0].state = 'partial'; await f.render();
    expect(f.trigger().textContent).toBe('Latest: Check the build');
    expect(f.trigger().getAttribute('aria-label')).toBe(`${en.ui['statistics.select']}: Latest: Check the build`);
    await click(f.trigger());
    const rows = f.rows();
    expect(rows).toHaveLength(102);
    expect(rows[1]?.querySelector('[data-statistics-scope="group"]')).not.toBeNull();
    expect(rows[0]?.textContent).toBe(en.ui['statistics.followLatest']); expect(rows[0]?.hasAttribute('data-menu-selected')).toBe(true);
    expect(f.element.querySelector('[role="menu"] hr')).not.toBeNull();
    const first = rows[2], last = rows[101];
    expect(first?.querySelector('[data-statistics-question] span')?.textContent).toBe('Check the build');
    expect(last?.querySelector('[data-state-dot]')?.getAttribute('data-state-dot')).toBe('error');
    const meta = last?.querySelector('[data-statistics-question] span:last-child')?.textContent ?? '';
    expect(meta).toContain(` · ${en.ui['statistics.status.partial']} · alpha`); expect(meta).not.toContain('Question');
    await click(last as HTMLButtonElement);
    expect(f.trigger().textContent).toBe('Question 0');
    await click(f.trigger());
    expect(f.rows().filter(row => row.hasAttribute('data-menu-selected')).map(row => row.querySelector('[data-statistics-question] span')?.textContent)).toEqual(['Question 0']);
    const follow = f.rows()[0]; assert.ok(follow); await click(follow);
    expect(f.trigger().textContent).toBe('Latest: Check the build');
    expect(f.element.querySelector('[data-statistics-turn]')?.getAttribute('data-statistics-turn')).toBe('t99');
  } finally { await f.close(); }
});

it('shows one cumulative legacy member row with separate execution details and no combined speed/context', async () => {
  const f = await fixture();
  try {
    await f.renderMember();
    expect(f.element.querySelectorAll('[data-group-member-statistics]')).toHaveLength(1);
    expect(f.element.textContent).toContain('320 tok'); expect(f.element.textContent).toContain('2 executions');
    expect(f.element.textContent).not.toContain('tok/s'); expect(f.element.textContent).not.toContain('Context ≈');
    const details = [...f.element.querySelectorAll('button')].find(b => b.textContent === 'Statistics'); assert.ok(details); await click(details);
    expect(f.element.textContent).toContain('Execution 1'); expect(f.element.textContent).toContain('Execution 2');
  } finally { await f.close(); }
});

it('names the scope of the readings on hover', async () => {
  const f = await fixture();
  try {
    expect(f.element.querySelector('[data-group-usage]')?.getAttribute('title')).toBe('This question only · 16/16 members readable');
  } finally { await f.close(); }
});

it('totals the whole group on request, reading settled sessions a few at a time and releasing each', async () => {
  const f = await fixture();
  try {
    expect(f.retain).toHaveBeenCalledTimes(16);
    await click(f.trigger());
    const group = f.rows().find(row => row.querySelector('[data-statistics-scope="group"]'));
    assert.ok(group); expect(group.textContent).toBe('Whole groupAll 100 questions; each member session counted once');
    f.lease.peak = 0; await click(group); await f.settle();
    const bar = f.element.querySelector('[data-group-statistics-bar]');
    expect(bar?.getAttribute('data-statistics-scope')).toBe('group'); expect(f.trigger().textContent).toBe('Whole group');
    expect(f.element.querySelector('[data-statistics-status]')?.textContent).toBe('100 questions');
    // 100 questions × 16 members × 160 tokens, each session read once and let go.
    expect(f.element.querySelector('[data-group-token-total]')?.textContent).toBe('256K tok');
    expect(f.element.querySelector('[data-group-usage]')?.getAttribute('title')).toBe('Whole group · 100 questions · 1600/1600 member sessions readable');
    expect(f.retain).toHaveBeenCalledTimes(16 + 1600); expect(f.lease.peak).toBeLessThanOrEqual(4); expect(f.lease.now).toBe(0);
    await click([...f.element.querySelectorAll('button')].find(b => b.textContent === 'Statistics') as HTMLButtonElement);
    const rows = f.element.querySelectorAll('[data-statistics-breakdown-row]');
    expect(rows).toHaveLength(100); expect(rows[0]?.textContent).toBe('Question 992.6K tok · Cache hit 28.6%');
    expect(f.element.querySelector('[data-statistics-breakdown]')?.previousElementSibling?.textContent).not.toContain('Context');
    // Leaving and re-entering the scope reuses the settled readings.
    await f.select('Question 5'); await click(f.trigger());
    await click(f.rows().find(row => row.querySelector('[data-statistics-scope="group"]')) as HTMLButtonElement); await f.settle();
    expect(f.retain).toHaveBeenCalledTimes(16 + 1600 + 16); expect(f.element.querySelector('[data-group-token-total]')?.textContent).toBe('256K tok');
    // Sending a question shows that question again.
    await f.render({ turnId: 't99', followup: false, sequence: 1 });
    expect(f.element.querySelector('[data-group-statistics-bar]')?.getAttribute('data-statistics-scope')).toBe('question');
  } finally { await f.close(); }
  expect(f.lease.now).toBe(0);
});

it('keeps sessions of a running question subscribed in the whole-group scope', async () => {
  const f = await fixture();
  try {
    assert.ok(f.data.turns[99]); f.data.turns[99].state = 'running'; await f.render();
    await click(f.trigger());
    await click(f.rows().find(row => row.querySelector('[data-statistics-scope="group"]')) as HTMLButtonElement); await f.settle();
    // The running question's 16 sessions stay leased for live updates; the 1584 settled ones are released.
    expect(f.lease.now).toBe(16); expect(f.element.querySelector('[data-group-token-total]')?.textContent).toBe('256K tok');
  } finally { await f.close(); }
  expect(f.lease.now).toBe(0);
});
