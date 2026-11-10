import { expect, test } from 'vitest';
import { proactiveWorker } from './proactive-worker-fixture.js';

test('work list filters the exact Bot generation before its recent-window limit', async () => {
  const worker = await proactiveWorker();
  const current = { botId: 'current-bot', botCreatedAt: 2 };
  const previous = { ...current, botCreatedAt: 1 };
  const other = { botId: 'another-bot', botCreatedAt: 1 };
  try {
    const sourceId = 'ci:work-window';
    await worker.submit({
      kind: 'ingest-batch', sourceId, generation: 1, expectedCheckpoint: null, nextCheckpoint: 'first',
      events: Array.from({ length: 32 }, (_, index) => ({
        nativeId: `job-${index}`, nativeRevision: '1', threadId: `thread-${index}`,
        occurredAt: new Date().toISOString(), summary: `Work window fixture ${index}`,
        ci: { job: 'test', attempt: 1, conclusion: 'failure' },
      })),
    });
    const candidates = await worker.read({ kind: 'suggestions' });
    if (candidates.kind !== 'suggestions') throw new Error('Fixture suggestions missing');
    expect(candidates.suggestions).toHaveLength(32);
    for (const [index, suggestion] of candidates.suggestions.entries()) {
      const bot = index === 0 ? current : index === 1 ? previous : other;
      await worker.submit({
        kind: 'accept-decision', decisionId: suggestion.id, sourceId, policyVersion: suggestion.policyVersion,
        expectedRevision: suggestion.revision, approved: true,
        target: { bot, botUpdatedAt: 2, provider: 'fixture', model: 'synthetic' },
      });
      const work = await worker.read({ kind: 'work', decisionId: suggestion.id });
      if (work.kind !== 'work' || !work.work) throw new Error('Admitted work missing');
      await worker.submit({ kind: 'cancel', ticketId: work.work.ticketId, expectedRevision: work.work.revision });
    }
    const legacy = await worker.read({ kind: 'work-list' });
    if (legacy.kind !== 'work-list') throw new Error('Legacy work list missing');
    expect(legacy.work).toHaveLength(30);
    expect(legacy.work.every(row => row.target.bot.botId === other.botId)).toBe(true);

    const first = await worker.read({ kind: 'activity-page', input: { owner: other, collection: 'work' } });
    if (first.kind !== 'activity-page' || first.page.collection !== 'work') throw new Error('Missing page');
    expect(first.page.rows).toHaveLength(20);
    expect(first.page.next).toBeTruthy();
    const second = await worker.read({ kind: 'activity-page', input: { owner: other, collection: 'work', cursor: first.page.next } });
    if (second.kind !== 'activity-page') throw new Error('Missing continuation');
    expect(second.page.rows).toHaveLength(10);
    expect(new Set([...first.page.rows, ...second.page.rows].map(row => 'ticketId' in row && row.ticketId)).size).toBe(30);
    expect(await worker.read({ kind: 'activity-page', input: { owner: current, collection: 'work', cursor: first.page.next } })).toMatchObject({ kind: 'rejected', code: 'stale' });
    const summary = first.page.rows[0];
    if (!summary) throw new Error('Missing summary');
    expect(summary).not.toHaveProperty('evidence');
    expect(summary).not.toHaveProperty('repair');
    expect(await worker.read({ kind: 'work-detail', input: { owner: other, ticketId: summary.ticketId, expectedRevision: summary.revision } })).toMatchObject({ kind: 'work', work: { ticketId: summary.ticketId } });
    expect(await worker.read({ kind: 'work-detail', input: { owner: current, ticketId: summary.ticketId, expectedRevision: summary.revision } })).toMatchObject({ kind: 'rejected', code: 'stale' });
    await worker.submit({ kind: 'revoke-source', sourceId, generation: 1 });
    expect(await worker.read({ kind: 'activity-page', input: { owner: other, collection: 'work', cursor: first.page.next } })).toMatchObject({ kind: 'rejected', code: 'stale' });

    const scoped = await worker.read({ kind: 'work-list', owner: current });
    if (scoped.kind !== 'work-list') throw new Error('Bot work list missing');
    expect(scoped.work.map(row => row.target.bot)).toEqual([current]);
    expect(scoped.work[0]?.decisionId).toBe(candidates.suggestions[0]?.id);
  } finally { await worker.close(); }
});

test('project references reuse source IDs; two projects never mix their task summaries', async () => {
  const worker = await proactiveWorker();
  const owner = { botId: 'personal', botCreatedAt: 1 };
  try {
    for (const sourceId of ['ci:project-a', 'ci:project-b']) {
      await worker.submit({ kind: 'ingest-batch', sourceId, generation: 1, expectedCheckpoint: null, nextCheckpoint: 'one', events: [
        { nativeId: 'run', nativeRevision: '1', threadId: 'run', occurredAt: new Date().toISOString(), summary: sourceId, ci: { job: 'check', attempt: 1, conclusion: 'failure' } },
      ] });
      const read = await worker.read({ kind: 'activity-page', input: { owner, collection: 'suggestions', sourceId } });
      if (read.kind !== 'activity-page' || read.page.collection !== 'suggestions') throw new Error();
      expect(read.page.rows).toHaveLength(1);
      const candidate = read.page.rows[0];
      if (!candidate) throw new Error('Missing candidate');
      await worker.submit({ kind: 'accept-decision', decisionId: candidate.id, sourceId, policyVersion: candidate.policyVersion, expectedRevision: candidate.revision, approved: true, target: { bot: owner, botUpdatedAt: 1, provider: 'fixture', model: 'fixture' } });
      const selected = await worker.read({ kind: 'work', decisionId: candidate.id });
      if (selected.kind !== 'work' || !selected.work) throw new Error();
      await worker.submit({ kind: 'cancel', ticketId: selected.work.ticketId, expectedRevision: selected.work.revision });
    }
    for (const sourceId of ['ci:project-a', 'ci:project-b']) {
      const read = await worker.read({ kind: 'activity-page', input: { owner, collection: 'work', sourceId } });
      if (read.kind !== 'activity-page' || read.page.collection !== 'work') throw new Error();
      expect(read.page.rows.map(row => row.sourceId)).toEqual([sourceId]);
    }
  } finally { await worker.close(); }
});
