// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis';
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createPendingWorkSource, PendingWork, type NativeStatusHook } from '../../src/client/pending-work.js';
import { createPollingCatalog } from '../../src/client/state.js';
import { createFollowUpSource } from '../../src/client/proactive/follow-up-state.js';
import type { FollowUpCard, Subject } from '../../src/shared/proactive/follow-up.js';
import { botStatusSchema } from '../../src/shared/remote-contract.js';
import { workSummarySchema } from '../../src/shared/proactive/activity.js';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { bot } from './remote-double.js';
import { button, click } from './helpers.js';

it('reads all pages of existing paused follow-ups and unknown work without mutations; native hook opens the original interaction', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ctx = new Context(), owner = { botId: 'alpha', botCreatedAt: 1 };
  const entries = [bot({ id: 'alpha', name: 'Alpha Display' }), bot({ id: 'beta', name: 'Beta Display' })].map(value => ({ bot: value,
    status: botStatusSchema.parse({ id: value.id, presetId: `bot-${value.id}`, mainSessionId: `${value.id}-main`, preset: { state: 'ok' } }) }));
  const bots = createPollingCatalog(ctx, { entries }, async () => ({ entries }));
  const row = (id: string, kind: 'waiting-input' | 'needs-review'): FollowUpCard => ({
    id, decisionId: `decision-${id}`, subject: { kind: 'bot', bot: owner }, revision: 1, state: 'open', title: id,
    origin: { kind: 'watch', watchId: id }, observedAt: new Date().toISOString(), condition: kind === 'waiting-input'
      ? { kind, wait: { reason: 'Format needed', request: 'Confirm format' } } : { kind },
  });
  const mutation = vi.fn();
  let betaUnavailable = false;
  const pages = vi.fn(async ({ subject, cursor }: { subject: Subject; cursor?: string }) => ({ ok: true, value:
    subject.kind === 'bot' && subject.bot.botId === 'alpha'
      ? cursor ? { rows: [row('review', 'needs-review')] } : { rows: [row('input', 'waiting-input')], next: 'next-page' } : { rows: [] } }));
  ctx.provide('remote.dshBot.proactive', { followUpPage: pages, followUpAction: mutation, followUpWatchCreate: mutation,
    followUpSummary: async (subject: Subject) => {
      if (betaUnavailable && subject.kind === 'bot' && subject.bot.botId === 'beta') throw new Error('Offline');
      return { ok: true, value: { state: 'ready', configEpoch: '00000000-0000-4000-8000-000000000001', scopeOnly: true,
      summary: { policy: { subject, revision: 2, pauseEpoch: 1, localEnabled: false, legacyCi: 'denied', observationStart: 1 }, legacyCiActive: false, rows: [] } } }; },
  } as unknown as TypertRemoteNamespaceMap['dshBot.proactive']);
  const followUp = createFollowUpSource(ctx, {}), openSession = vi.fn(async (_id: string) => {}), openBot = vi.fn();
  const unknown = workSummarySchema.parse({ ticketId: 'unknown-ticket', assignmentId: 'unknown-assignment', decisionId: 'unknown-decision', triggerId: 'unknown-trigger',
    sourceId: 'ci:test', title: 'UNKNOWN_STATE', target: { bot: owner, botUpdatedAt: 1, provider: 'fixture', model: 'fixture' },
    expiresAt: '2099-01-01T00:00:00Z', policyVersion: '1', revision: 1, generation: 1, state: 'unknown' });
  const work = vi.fn(async (target: typeof owner, cursor?: string) => ({ collection: 'work' as const,
    rows: target.botId === 'alpha' && cursor ? [unknown] : [], ...(target.botId === 'alpha' && !cursor ? { next: 'work-next' } : {}) }));
  const source = createPendingWorkSource(ctx, bots, followUp, { work, openBot, openSession }, {});
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  let status = new Map([['alpha-main', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }]]);
  const listeners = new Set<() => void>();
  const hook = ((selector: (value: typeof status) => unknown) => useSyncExternalStore(listener => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }, () => selector(status), () => selector(status))) as unknown as NativeStatusHook;
  const t = ((key: string, params?: { name?: string }) => params?.name ? key + ' ' + params.name : key) as PropsLocale<'dsh-bot'>['t'];
  try {
    await source.catalog.refresh();
    expect(source.catalog.getSnapshot().rows.map(value => value.kind)).toEqual(['input', 'review', 'unknown']);
    expect(pages.mock.calls.some(([input]) => input.cursor === 'next-page')).toBe(true);
    expect(work.mock.calls.some(([, cursor]) => cursor === 'work-next')).toBe(true);
    await act(async () => root.render(<PendingWork source={source} useSessionStatus={hook} t={t} />));
    expect(container.textContent).toContain('Alpha Display');
    expect(container.querySelector('[data-pending-kind="native"]')).not.toBeNull();
    await click(button(container, 'Alpha Display · pendingWork.openNative'));
    expect(openSession).toHaveBeenCalledExactlyOnceWith('alpha-main');
    await act(async () => { status = new Map(); for (const listener of listeners) listener(); });
    expect(container.querySelector('[data-pending-kind="native"]')).toBeNull();
    await click(button(container, 'Alpha Display · pendingWork.unknown · UNKNOWN_STATE'));
    expect(openBot).toHaveBeenCalledWith(owner, 'unknown-ticket');
    betaUnavailable = true;
    await act(async () => source.catalog.refresh());
    expect(container.textContent).toContain('pendingWork.botUnavailable Beta Display');
    expect(container.querySelectorAll('[data-pending-bot="alpha"]')).toHaveLength(3);
    await click(button(container, 'Alpha Display · pendingWork.unknown · UNKNOWN_STATE'));
    expect(openBot).toHaveBeenCalledTimes(2);
    betaUnavailable = false;
    await click(button(container, 'actions.retry'));
    await vi.waitFor(() => expect(container.textContent).not.toContain('pendingWork.botUnavailable'));
    expect(mutation).not.toHaveBeenCalled();
    expect(source.catalog.getSnapshot().rows).toHaveLength(3);
  } finally { await act(async () => root.unmount()); await ctx.fiber.dispose(); container.remove(); }
});
