import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { proactiveWorker } from './proactive-worker-fixture.js';
import { digest } from '../src/host/proactive/wire.js';
import type { FollowUpCompletionTarget, FollowUpIngest } from '../src/shared/proactive/follow-up.js';

const subject = { kind: 'bot', bot: { botId: 'conditional-owner', botCreatedAt: 1 } } as const;
type Core = Awaited<ReturnType<typeof proactiveWorker>>;
async function rows(core: Core) {
  const reply = await core.read({ kind: 'follow-up-page', input: { subject } });
  if (reply.kind !== 'follow-up-page') throw new Error('Missing page'); return reply.page.rows;
}
async function enable(core: Core) {
  await core.submit({ kind: 'follow-up-policy', input: { subject, action: 'enable-local', expectedRevision: 0 } });
}
async function watch(core: Core, target: FollowUpCompletionTarget, id: string, deadlineAt = new Date(Date.now() + 60000).toISOString()) {
  await core.submit({ kind: 'follow-up-watch-create', input: { subject, expectedRevision: 1, id,
    watch: { source: { kind: 'manual' }, title: id, completion: 'Review the original work result', when: target, deadlineAt } } });
  const row = (await rows(core)).find(row => row.origin.kind === 'watch' && row.origin.watchId === id);
  if (!row) throw new Error('Watch missing'); return row;
}

it('binds exact native child lineage/generation, consumes completion once and keeps unknown commands on the same receipt', async () => {
  const core = await proactiveWorker();
  try {
    await enable(core);
    const origin = { kind: 'native-subagent', sessionId: 'parent', childSessionId: 'child', turn: 1 } as const;
    const input: FollowUpIngest = { kind: 'local-task-state/v1', subject, sourceId: 'native-child', sourceGeneration: 8,
      pauseEpoch: 0, expectedCursor: null, nextCursor: 'start', facts: [{ origin, nativeId: 'child', nativeRevision: 10,
        occurredAt: new Date().toISOString(), title: 'Original child task', payloadDigest: digest('start'), condition: { kind: 'tracking' } }] };
    await core.submit({ kind: 'follow-up-ingest', input });
    const target = (await rows(core))[0]?.completionTarget;
    if (!target) throw new Error('Missing structured target');
    const commandId = randomUUID();
    const create = { kind: 'follow-up-watch-create', input: { subject, expectedRevision: 1, id: 'watched', watch: {
      source: { kind: 'manual' }, title: 'Watch child', completion: 'Review result', when: target,
      deadlineAt: new Date(Date.now() + 60000).toISOString() } } } as const;
    await core.change(commandId, create);
    expect(await core.change(commandId, create)).toMatchObject({ kind: 'receipt', receipt: { status: 'duplicate' } });
    const started = (await rows(core)).find(row => row.origin.kind === 'watch');
    await core.restart();
    const complete: FollowUpIngest = { ...input, expectedCursor: 'start', nextCursor: 'end', facts: input.facts.map(fact => ({ ...fact,
      nativeRevision: 11, payloadDigest: digest('done'), condition: { kind: 'closed', reason: 'resolved' } })) };
    await core.submit({ kind: 'follow-up-ingest', input: complete });
    const settled = (await rows(core)).find(row => row.origin.kind === 'watch');
    expect(settled).toMatchObject({ when: target, state: 'open', condition: { kind: 'needs-review' }, revision: (started?.revision ?? 0) + 1 });
    await core.submit({ kind: 'follow-up-ingest', input: { ...complete, expectedCursor: 'end' } });
    expect((await rows(core)).find(row => row.origin.kind === 'watch')).toEqual(settled);
    expect(await core.read({ kind: 'work-list', owner: subject.bot })).toMatchObject({ work: [] });
    expect(await core.change(randomUUID(), { ...create, input: { ...create.input, id: 'forged', watch: {
      ...create.input.watch, when: { ...target, cardId: 'other-work' } } } })).toMatchObject({ kind: 'rejected', code: 'stale' });
  } finally { await core.close(); }
});

it('requires a deadline and honours stop, expiry and exact source generation before completion', async () => {
  const core = await proactiveWorker();
  try {
    await enable(core);
    const input: FollowUpIngest = { kind: 'local-task-state/v1', subject, sourceId: 'delegate-source', sourceGeneration: 1,
      pauseEpoch: 0, expectedCursor: null, nextCursor: 'one', facts: [{ origin: { kind: 'delegate', runId: 'run-1' },
        nativeId: 'run-1', nativeRevision: 1, occurredAt: new Date().toISOString(), title: 'Original delegate',
        payloadDigest: digest('running'), condition: { kind: 'tracking' } }] };
    await core.submit({ kind: 'follow-up-ingest', input });
    const target = (await rows(core))[0]?.completionTarget;
    if (!target) throw new Error('Missing target');
    expect(await core.change(randomUUID(), { kind: 'follow-up-watch-create', input: { subject, expectedRevision: 1, id: 'no-deadline',
      watch: { title: 'No deadline', completion: 'Should fail', source: { kind: 'manual' }, when: target } } }))
      .toMatchObject({ kind: 'rejected', code: 'invalid' });
    const stopped = await watch(core, target, 'stopped');
    await core.submit({ kind: 'follow-up-action', input: { subject, cardId: stopped.id, expectedRevision: stopped.revision,
      expectedPolicyRevision: 1, action: 'stop' } });
    await watch(core, target, 'expires', new Date(Date.now() + 1000).toISOString());
    await watch(core, target, 'wrong-generation');
    await delay(1050);
    await core.submit({ kind: 'follow-up-work-reconcile', input: { subject, expectedPolicyRevision: 1 } });
    await core.submit({ kind: 'follow-up-ingest', input: { ...input, sourceGeneration: 2, expectedCursor: null, nextCursor: 'new-generation',
      facts: input.facts.map(fact => ({ ...fact, nativeRevision: 2, payloadDigest: digest('completed'), condition: { kind: 'closed', reason: 'resolved' } })) } });
    const all = await rows(core);
    expect(all.find(row => row.title === 'stopped')?.state).toBe('stopped');
    expect(all.find(row => row.title === 'expires')).toMatchObject({ state: 'closed', condition: { kind: 'closed', reason: 'cancelled' } });
    expect(all.find(row => row.title === 'wrong-generation')?.condition.kind).toBe('tracking');
  } finally { await core.close(); }
});

it('binds the existing CI work and consumes a later observed result without dispatching another work', async () => {
  const core = await proactiveWorker();
  try {
    await enable(core);
    const sourceId = 'ci:conditional';
    await core.submit({ kind: 'ingest-batch', sourceId, generation: 3, expectedCheckpoint: null, nextCheckpoint: 'first', events: [{
      nativeId: 'ci-run', nativeRevision: 'failure-1', threadId: 'ci-thread', occurredAt: new Date().toISOString(),
      summary: 'Original failing CI', ci: { attempt: 1, conclusion: 'failure' } }] });
    const suggestions = await core.read({ kind: 'suggestions' });
    if (suggestions.kind !== 'suggestions' || !suggestions.suggestions[0]) throw new Error('No CI suggestion');
    const suggestion = suggestions.suggestions[0];
    await core.submit({ kind: 'accept-decision', decisionId: suggestion.id, sourceId, policyVersion: suggestion.policyVersion,
      expectedRevision: suggestion.revision, approved: true, target: { bot: subject.bot, botUpdatedAt: 1, provider: 'fixture', model: 'fixture' } });
    const target = (await rows(core)).find(row => row.origin.kind === 'work')?.completionTarget;
    if (!target) throw new Error('No original CI target');
    await watch(core, target, 'ci-follow-up');
    await core.submit({ kind: 'ingest-batch', sourceId, generation: 3, expectedCheckpoint: 'first', nextCheckpoint: 'second', events: [{
      nativeId: 'ci-run', nativeRevision: 'success-2', threadId: 'ci-thread', occurredAt: new Date(Date.now() + 1).toISOString(),
      summary: 'Next passing CI', ci: { attempt: 2, conclusion: 'success' } }] });
    expect((await rows(core)).find(row => row.title === 'ci-follow-up')).toMatchObject({ when: target, condition: { kind: 'needs-review' }, state: 'open' });
    const work = await core.read({ kind: 'work-list', owner: subject.bot });
    expect(work.kind === 'work-list' && work.work).toHaveLength(1);
    await watch(core, target, 'revoked-source-watch');
    await core.submit({ kind: 'revoke-source', sourceId, generation: 3 });
    await core.submit({ kind: 'follow-up-work-reconcile', input: { subject, expectedPolicyRevision: 1 } });
    expect((await rows(core)).find(row => row.title === 'revoked-source-watch')).toMatchObject({
      state: 'closed', condition: { kind: 'closed', reason: 'cancelled' },
    });
  } finally { await core.close(); }
});
