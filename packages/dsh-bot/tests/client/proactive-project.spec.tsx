// @vitest-environment jsdom
import { fireEvent, getByLabelText } from '@testing-library/dom';
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { SuggestionPanel } from '../../src/client/proactive/SuggestionPanel.js';
import { botSchema, botCreateSchema } from '../../src/shared/schema.js';
import { responsibilitySchema } from '../../src/shared/proactive/responsibility.js';
import { capabilities, type ActivityPage } from '../../src/shared/proactive/protocol.js';
import { workSchema } from '../../src/shared/proactive/work.js';

test('project reads follow shared refresh, retain last good results on failure and never mix sources', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'quality', name: 'Quality' }), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
  const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
  const sources = ['a', 'b'].map(char => ({ id: `ci:${char.repeat(64)}`, generation: 1, repository: `owner/${char}`, branch: 'main' }));
  const work = workSchema.parse({ ticketId: 'ticket-a', assignmentId: 'assignment-a', decisionId: 'decision', triggerId: 'trigger', sourceId: sources[0]?.id, title: 'Project A initial', target: { bot: owner, botUpdatedAt: 1, provider: 'fixture', model: 'fixture' }, expiresAt: '2099-01-01T00:00:00Z', policyVersion: '1', revision: 1, generation: 1, state: 'accepted' });
  const read = vi.fn<NonNullable<ComponentProps<typeof SuggestionPanel>['actions']['activityPage']>>(async input => ({ collection: input.collection, rows: input.collection === 'work' ? [{ ...work, title: input.sourceId === sources[0]?.id ? 'Project A initial' : 'Project B initial' }] : [] }) as ActivityPage);
  const props: ComponentProps<typeof SuggestionPanel> = {
    bot, actions: { activityPage: read, accept: vi.fn(), change: vi.fn(), feedback: vi.fn(), groupReview: vi.fn(), externalNotice: vi.fn(), pause: vi.fn(), revokeSource: vi.fn(), cancel: vi.fn(), review: vi.fn() },
    onTargetReached: vi.fn(), onOpen: vi.fn(), t: ((key: string) => key) as ComponentProps<typeof SuggestionPanel>['t'],
    snapshot: { loaded: true, loading: false, pollIntervalMs: 5000, refreshedAt: 1, work: [], suggestions: [], status: { state: 'ready', capabilities }, responsibilities: sources.map((source, index) => ({
      responsibility: responsibilitySchema.parse({ id: `duty-${index}`, owner, revision: 1, denyEpoch: 0, deleted: false, createdAt: 1, updatedAt: 1, name: `Project ${index}`, mode: 'suggest', source, conditions: {}, action: 'inspect-ci-result', target: { bot: owner, botUpdatedAt: 1 }, acceptance: { goal: 'Inspect CI', deliverables: ['Report'], checks: [{ id: 'review', title: 'Review', kind: 'human' }] }, limits: {}, expiresAt: '2099-01-01T00:00:00Z' }),
      usage: { utcDay: '2026-11-08', resetsAt: '2099-01-01T00:00:00Z', requestsUsed: 0, requestsAvailable: 8, knownTokens: 0, reservedTokens: 0, unknownTokens: 0, tokensAvailable: 1000, activeTasks: 0, measurementComplete: true, clockSkew: false },
    })) },
  };
  try {
    await act(async () => root.render(<SuggestionPanel {...props} />));
    await act(async () => fireEvent.change(getByLabelText(container, 'proactive.findProject'), { target: { value: sources[0]?.id } }));
    expect(container.textContent).toContain('Project A initial');
    read.mockImplementation(async input => ({ collection: input.collection, rows: input.collection === 'work' ? [{ ...work, title: 'Project A updated' }] : [] }) as ActivityPage);
    await act(async () => root.render(<SuggestionPanel {...props} snapshot={{ ...props.snapshot, refreshedAt: 2 }} />));
    expect(container.textContent).toContain('Project A updated');
    read.mockRejectedValue(new Error('Offline'));
    await act(async () => root.render(<SuggestionPanel {...props} snapshot={{ ...props.snapshot, refreshedAt: 3 }} />));
    expect(container.textContent).toContain('Project A updated');
    await act(async () => fireEvent.change(getByLabelText(container, 'proactive.findProject'), { target: { value: sources[1]?.id } }));
    expect(container.textContent).not.toContain('Project A updated');
    expect(read).toHaveBeenLastCalledWith({ owner, collection: 'suggestions', sourceId: sources[1]?.id });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('opens one exact older task from follow-up and retains it after consuming navigation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const bot = botSchema.parse({ ...botCreateSchema.parse({ id: 'quality', name: 'Quality' }), schemaVersion: 1, createdAt: 1, updatedAt: 1 });
  const target = { kind: 'work', id: 'older-ticket' } as const;
  const old = workSchema.parse({ ticketId: target.id, assignmentId: 'assignment-old', decisionId: 'decision-old',
    triggerId: 'trigger', sourceId: 'source', title: 'Older task to review',
    target: { bot: { botId: bot.id, botCreatedAt: bot.createdAt }, botUpdatedAt: 1, provider: 'fixture', model: 'fixture' },
    expiresAt: '2099-01-01T00:00:00Z', policyVersion: '1', revision: 1, generation: 1, state: 'accepted' });
  const history = vi.fn(async () => ({ versions: [old] }));
  const props: ComponentProps<typeof SuggestionPanel> = {
    bot, actions: { workHistory: history, accept: vi.fn(), change: vi.fn(), feedback: vi.fn(), groupReview: vi.fn(),
      externalNotice: vi.fn(), pause: vi.fn(), revokeSource: vi.fn(), cancel: vi.fn(), review: vi.fn() },
    onTargetReached: vi.fn(), onOpen: vi.fn(), t: ((key: string) => key) as ComponentProps<typeof SuggestionPanel>['t'],
    snapshot: { loaded: true, loading: false, pollIntervalMs: 5000, work: [], suggestions: [], status: { state: 'ready', capabilities } },
  };
  try {
    await act(async () => root.render(<SuggestionPanel {...props} target={target} />));
    expect(history).toHaveBeenCalledExactlyOnceWith({ ticketId: target.id, limit: 1 });
    expect(props.onTargetReached).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-proactive-ticket="older-ticket"]')).toBeTruthy();
    await act(async () => root.render(<SuggestionPanel {...props} />));
    expect(container.querySelector('[data-proactive-ticket="older-ticket"]')).toBeTruthy();
    expect(props.actions.accept).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
