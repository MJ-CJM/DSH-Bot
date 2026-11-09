import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { proactiveWorker } from './proactive-worker-fixture.js';
import { digest } from '../src/host/proactive/wire.js';
import type { FollowUpBootstrap, FollowUpIngest, Subject } from '../src/shared/proactive/follow-up.js';

const bot = { kind: 'bot', bot: { botId: 'follow-bot', botCreatedAt: 10 } } as const;
const group = { kind: 'group', group: { groupId: 'follow-group', groupCreatedAt: 11 } } as const;
const enable = (subject: Subject, expectedRevision = 0) => ({
  kind: 'follow-up-policy', input: { subject, expectedRevision, action: 'enable-local' },
} as const);

test('normalizes group observations, pages 1,000 rows, and fences stale source input', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(group));
    expect(await core.read({ kind: 'follow-up-subjects' })).toMatchObject({
      kind: 'follow-up-subjects', rows: [{ subject: group, localEnabled: true }],
    });
    const occurredAt = new Date().toISOString();
    const fact = (index: number): FollowUpIngest['facts'][number] => ({
      nativeId: `turn:${index}`, nativeRevision: 2, occurredAt,
      payloadDigest: digest(index), origin: { kind: 'group-turn', turnId: `turn:${index}` },
      title: `Group turn ${index}`, condition: { kind: 'failed', members: [
        { deliveryId: 'delivery-a', memberId: 'a', reason: 'Model error A' },
        { deliveryId: 'delivery-b', memberId: 'b', reason: 'Model error B' },
        { deliveryId: 'delivery-c', memberId: 'c', reason: 'Model error C' },
      ] },
    });
    const input: FollowUpIngest = { kind: 'local-task-state/v1', subject: group, sourceId: 'group-turns',
      sourceGeneration: 11, pauseEpoch: 0, expectedCursor: null, nextCursor: '1', facts: [fact(0)] };
    const op = randomUUID();
    expect(await core.change(op, { kind: 'follow-up-ingest', input })).toMatchObject({ kind: 'receipt', receipt: { stored: 1 } });
    expect(await core.change(op, { kind: 'follow-up-ingest', input })).toMatchObject({ kind: 'receipt', receipt: { status: 'duplicate' } });
    expect(await core.change(op, { kind: 'follow-up-ingest', input: { ...input, nextCursor: 'changed' } })).toMatchObject({ kind: 'rejected', code: 'conflict' });
    const replay = Array.from({ length: 100 }, (_, index) => ({ ...fact(0), nativeRevision: index % 2 ? 1 : 2 }));
    for (let offset = 0; offset < replay.length; offset += 16) {
      const result = await core.submit({ kind: 'follow-up-ingest', input: {
        ...input, expectedCursor: '1', facts: replay.slice(offset, offset + 16),
      } });
      expect(result).toMatchObject({ receipt: { stored: 0 } });
    }
    expect(await core.read({ kind: 'follow-up-source', subject: group, sourceId: input.sourceId, sourceGeneration: 10 }))
      .toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await core.read({ kind: 'follow-up-source', subject: group, sourceId: input.sourceId, sourceGeneration: 11 }))
      .toMatchObject({ kind: 'follow-up-source', cursor: '1' });
    expect(await core.read({ kind: 'follow-up-summary', subject: group })).toMatchObject({
      kind: 'follow-up-summary', summary: { rows: [{ origin: fact(0).origin, revision: 0, condition: fact(0).condition }] },
    });
    const otherGeneration = { ...group, group: { ...group.group, groupCreatedAt: 12 } };
    for (const subject of [bot, otherGeneration]) expect(await core.read({ kind: 'follow-up-summary', subject }))
      .toMatchObject({ summary: { policy: { localEnabled: false }, rows: [] } });

    let cursor = '1';
    for (let offset = 1; offset < 1000; offset += 16) {
      const nextCursor = String(offset + 16);
      await core.submit({ kind: 'follow-up-ingest', input: { ...input, expectedCursor: cursor, nextCursor,
        facts: Array.from({ length: Math.min(16, 1000 - offset) }, (_, i) => fact(offset + i)) } });
      cursor = nextCursor;
    }
    const first = await core.read({ kind: 'follow-up-page', input: { subject: group } });
    if (first.kind !== 'follow-up-page' || !first.page.next) throw new Error('Missing follow-up cursor');
    expect(first.page.rows).toHaveLength(20);
    const ids = new Set(first.page.rows.map(row => row.id));
    let next: string | undefined = first.page.next;
    for (let page = 1; page < 50; page++) {
      if (!next) throw new Error('Missing page cursor');
      const reply = await core.read({ kind: 'follow-up-page', input: { subject: group, cursor: next } });
      if (reply.kind !== 'follow-up-page') throw new Error('Missing follow-up page');
      expect(reply.page.rows).toHaveLength(20);
      for (const row of reply.page.rows) ids.add(row.id);
      next = reply.page.next;
    }
    expect(next).toBeUndefined();
    expect(ids.size).toBe(1000);
    expect(await core.read({ kind: 'follow-up-page', input: { subject: otherGeneration, cursor: first.page.next } }))
      .toMatchObject({ kind: 'rejected', code: 'stale' });

    const card = first.page.rows[0];
    const otherCard = first.page.rows[1];
    if (!card || !otherCard) throw new Error('Missing scoped cards');
    await core.submit({ kind: 'follow-up-action', input: { subject: group, cardId: card.id, expectedRevision: card.revision, expectedPolicyRevision: 1, action: 'stop' } });
    const delayed = { kind: 'follow-up-action', input: {
      subject: group, cardId: otherCard.id, expectedRevision: otherCard.revision, expectedPolicyRevision: 1, action: 'ignore',
    } } as const;
    await core.submit({ kind: 'follow-up-policy', input: { subject: group, expectedRevision: 1, action: 'pause' } });
    expect(await core.change(randomUUID(), { kind: 'follow-up-ingest', input: { ...input, expectedCursor: cursor } }))
      .toMatchObject({ kind: 'rejected', code: 'forbidden' });
    await core.submit(enable(group, 2));
    expect(await core.change(randomUUID(), delayed)).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await core.read({ kind: 'follow-up-summary', subject: group })).toMatchObject({
      summary: { policy: { localEnabled: true, pauseEpoch: 1, legacyCi: 'denied' } },
    });
  } finally { await core.close(); }
}, 15000);

test('projects the original work and independent watch in their existing coordinator transactions', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(bot));
    await core.submit({ kind: 'follow-up-watch-create', input: { subject: bot, expectedRevision: 1, id: 'watch-1',
      watch: { title: 'Review the launch plan', completion: 'Owner has read it', source: { kind: 'manual' } } } });
    const page = await core.read({ kind: 'follow-up-page', input: { subject: bot } });
    if (page.kind !== 'follow-up-page') throw new Error('Missing watch');
    expect(page.page.rows).toMatchObject([{ origin: { kind: 'watch', watchId: 'watch-1' }, condition: { kind: 'tracking', completion: 'Owner has read it' } }]);
    const watch = page.page.rows[0];
    if (!watch) throw new Error('Missing watch card');
    await core.submit({ kind: 'follow-up-action', input: { subject: bot, cardId: watch.id, expectedRevision: 0, expectedPolicyRevision: 1, action: 'ignore' } });
    expect(await core.change(randomUUID(), { kind: 'follow-up-action', input: { subject: bot, cardId: watch.id, expectedRevision: 0, expectedPolicyRevision: 1, action: 'complete' } }))
      .toMatchObject({ kind: 'rejected', code: 'stale' });
    await core.submit({ kind: 'follow-up-action', input: { subject: bot, cardId: watch.id, expectedRevision: 1, expectedPolicyRevision: 1, action: 'complete' } });
    await core.submit({ kind: 'submit-document', approved: true,
      target: { bot: bot.bot, botUpdatedAt: 10, provider: 'fixture', model: 'test' },
      document: { kind: 'document-analysis', version: 1, name: 'Project notes', sourceVersion: 1,
        content: 'Notes from the owner.', question: 'What changed?', acceptance: 'Identify the evidence.' },
      taskLimits: { maxAttempts: 2, maxTokens: 1024, deadlineAt: new Date(Date.now() + 60000).toISOString() } });
    const work = async () => {
      const result = await core.read({ kind: 'work-list', owner: bot.bot });
      if (result.kind !== 'work-list' || !result.work[0]) throw new Error('Missing original work');
      return result.work[0];
    };
    const original = await work();
    const key = { ticketId: original.ticketId, assignmentId: original.assignmentId };
    await core.submit({ kind: 'follow-up-policy', input: { subject: bot, expectedRevision: 1, action: 'pause' } });
    await core.submit({ kind: 'dispatch-claim', ...key, expectedRevision: original.revision, sessionId: randomUUID() });
    await core.submit({ kind: 'dispatch-send', ...key, expectedRevision: (await work()).revision, inputId: 'doc-input' });
    await core.submit({ kind: 'report-result', ...key, expectedRevision: (await work()).revision, result: {
      state: 'delivered', evidence: { inputId: 'doc-input', assistantId: 'result', turn: 1, outputDigest: digest('notes'),
        checks: ['source-match', 'turn-completed', 'transcript-flushed'] },
    } });
    expect(await core.read({ kind: 'follow-up-summary', subject: bot })).toMatchObject({ summary: { rows: [] } });
    await core.submit(enable(bot, 2));
    expect(await core.read({ kind: 'follow-up-summary', subject: bot })).toMatchObject({ summary: { rows: expect.arrayContaining([
      expect.objectContaining({ origin: { kind: 'work', ...key }, condition: { kind: 'needs-review' } }),
      expect.objectContaining({ id: watch.id, condition: { kind: 'closed', reason: 'completed' } }),
    ]) } });
    const snapshot = await core.read({ kind: 'snapshot' });
    expect(snapshot).toMatchObject({ snapshot: { ticketCount: 1 } });
  } finally { await core.close(); }
});

test('migrates v8 and fences previous scopes before any cold recovery', async () => {
  const core = await proactiveWorker(true);
  try {
    const updateDb = (sql: string) => {
      const db = new DatabaseSync(join(core.root, 'store', 'core.sqlite'));
      try { db.exec(sql); } finally { db.close(); }
    };
    await core.submit({ kind: 'submit-document', approved: true,
      target: { bot: bot.bot, botUpdatedAt: 10, provider: 'fixture', model: 'test' },
      document: { kind: 'document-analysis', version: 1, name: 'Before global disable', sourceVersion: 1,
        content: 'Frozen notes.', question: 'What changed?', acceptance: 'Use only the notes.' },
      taskLimits: { maxAttempts: 2, maxTokens: 1024, deadlineAt: new Date(Date.now() + 60000).toISOString() } });
    const old = await core.read({ kind: 'work-list', owner: bot.bot });
    if (old.kind !== 'work-list' || !old.work[0]) throw new Error('Missing historical pending work');
    await core.restart({ prepare: () => updateDb(`UPDATE pb_meta SET schema_version=8;
      DROP TABLE pb_follow_up_head; DROP TABLE pb_follow_up_policy; DROP TABLE pb_follow_up_recovery;`) });
    expect(await core.read({ kind: 'follow-up-summary', subject: bot })).toMatchObject({ summary: { policy: { revision: 0, localEnabled: false } } });
    const first: FollowUpBootstrap = { kind: 'enable-local', subject: bot, expectedRevision: null, operationId: randomUUID(), configEpoch: randomUUID() };
    expect(await core.restart({ bootstrap: first })).toMatchObject({ kind: 'hello', scopedRecovery: true });
    expect(await core.read({ kind: 'receipt', commandId: first.operationId })).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    expect(await core.read({ kind: 'work-list', owner: bot.bot })).toMatchObject({ work: old.work });
    expect(await core.change(randomUUID(), { kind: 'dispatch-claim', ticketId: old.work[0].ticketId,
      assignmentId: old.work[0].assignmentId, expectedRevision: old.work[0].revision, sessionId: randomUUID() }))
      .toMatchObject({ kind: 'rejected', code: 'forbidden' });
    const second: FollowUpBootstrap = { ...first, subject: group, operationId: randomUUID(), configEpoch: randomUUID() };
    expect(await core.restart({ bootstrap: second })).toMatchObject({ kind: 'hello', scopedRecovery: true });
    expect(await core.restart({ bootstrap: first })).toMatchObject({ kind: 'hello', scopedRecovery: true });
    expect(await core.read({ kind: 'follow-up-subjects' })).toMatchObject({ rows: [{ subject: group, localEnabled: true }] });
    expect(await core.read({ kind: 'follow-up-summary', subject: bot })).toMatchObject({ summary: { policy: { localEnabled: false, pauseEpoch: 1 } } });
    expect(await core.read({ kind: 'auto-candidates' })).toMatchObject({ rows: [] });
    expect(await core.read({ kind: 'notice-candidates' })).toMatchObject({ work: [] });
    expect(await core.restart({ bootstrap: { ...first, subject: group }, expectRejection: true })).toMatchObject({ code: 'conflict' });
    expect(await core.restart({ prepare: () => updateDb('UPDATE pb_meta SET schema_version=10'), expectRejection: true }))
      .toMatchObject({ kind: 'rejected', code: 'forbidden' });
    const db = new DatabaseSync(join(core.root, 'store', 'core.sqlite'), { readOnly: true });
    try { expect(db.prepare('SELECT schema_version FROM pb_meta').get()).toMatchObject({ schema_version: 10 }); }
    finally { db.close(); }
  } finally { await core.close(); }
});

test('continues a bounded Work baseline after restart and rejects a paused revision', async () => {
  const core = await proactiveWorker();
  try {
    for (let index = 0; index < 103; index++) {
      if (index === 100) await core.restart({ prepare: () => {
        // Represent retained work from a previous budget day.
        const db = new DatabaseSync(join(core.root, 'store', 'core.sqlite'));
        try { db.exec("UPDATE pb_execution_budget SET utc_day='2000-01-01'"); } finally { db.close(); }
      } });
      await core.submit({ kind: 'submit-document', approved: true,
        target: { bot: bot.bot, botUpdatedAt: 10, provider: 'fixture', model: 'test' },
        document: { kind: 'document-analysis', version: 1, name: `Original Work ${index}`, sourceVersion: 1,
          content: 'Owner material.', question: 'What changed?', acceptance: 'Cite the material.' },
        taskLimits: { maxAttempts: 2, maxTokens: 1024, deadlineAt: new Date(Date.now() + 60000).toISOString() },
      });
      const work = async () => {
        const reply = await core.read({ kind: 'work-list', owner: bot.bot });
        if (reply.kind !== 'work-list' || !reply.work[0]) throw new Error('Missing original Work');
        return reply.work[0];
      };
      const row = await work();
      const key = { ticketId: row.ticketId, assignmentId: row.assignmentId };
      await core.submit({ kind: 'dispatch-claim', ...key, expectedRevision: row.revision, sessionId: randomUUID() });
      await core.submit({ kind: 'dispatch-send', ...key, expectedRevision: (await work()).revision, inputId: `doc:${index}` });
      await core.submit({ kind: 'report-result', ...key, expectedRevision: (await work()).revision, result: {
        state: 'delivered', evidence: { inputId: `doc:${index}`, assistantId: `assistant:${index}`, turn: 1,
          outputDigest: digest(index), checks: ['source-match', 'turn-completed', 'transcript-flushed'] },
      } });
    }
    async function projected() {
      const tickets = new Set<string>();
      let cursor: string | undefined;
      do {
        const reply = await core.read({ kind: 'follow-up-page', input: { subject: bot, ...(cursor ? { cursor } : {}) } });
        if (reply.kind !== 'follow-up-page') throw new Error('Missing scoped Work');
        for (const row of reply.page.rows) {
          if (row.origin.kind !== 'work') throw new Error('Expected original Work');
          expect(tickets.has(row.origin.ticketId)).toBe(false);
          tickets.add(row.origin.ticketId);
        }
        cursor = reply.page.next;
      } while (cursor);
      return tickets;
    }
    const reconcile = (expectedPolicyRevision: number) => ({
      kind: 'follow-up-work-reconcile', input: { subject: bot, expectedPolicyRevision },
    } as const);
    await core.submit(enable(bot));
    const firstPage = await projected();
    expect(firstPage.size).toBe(100);
    await core.submit({ kind: 'follow-up-policy', input: { subject: bot, expectedRevision: 1, action: 'pause' } });
    expect(await core.change(randomUUID(), reconcile(1))).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await core.change(randomUUID(), reconcile(2))).toMatchObject({ kind: 'rejected', code: 'forbidden' });
    await core.submit(enable(bot, 2));
    await core.restart();
    expect(await core.submit(reconcile(3))).toMatchObject({ receipt: { stored: 3 } });
    expect(await core.submit(reconcile(3))).toMatchObject({ receipt: { stored: 0 } });
    const completed = await projected();
    expect(completed.size).toBe(103);
    for (const ticket of firstPage) expect(completed.has(ticket)).toBe(true);
    expect(await core.read({ kind: 'snapshot' })).toMatchObject({ snapshot: { ticketCount: 103 } });
  } finally { await core.close(); }
}, 15000);

test('only real policy mutations invalidate enabled Subject pagination', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(bot));
    for (let i = 0; i < 20; i++) await core.submit(enable({
      kind: 'bot', bot: { botId: `scope-${String(i).padStart(2, '0')}`, botCreatedAt: 10 },
    }));
    const page = await core.read({ kind: 'follow-up-subjects' });
    if (page.kind !== 'follow-up-subjects' || !page.next) throw new Error('Missing policy page');
    await core.submit({ kind: 'follow-up-watch-create', input: { subject: bot, expectedRevision: 1, id: 'page-watch',
      watch: { title: 'Unrelated activity', completion: 'Reviewed', source: { kind: 'manual' } } } });
    const tail = await core.read({ kind: 'follow-up-subjects', cursor: page.next });
    expect(tail).toMatchObject({ kind: 'follow-up-subjects', rows: [
      { subject: { kind: 'bot', bot: { botId: 'scope-19', botCreatedAt: 10 } } },
    ] });
    await core.submit({ kind: 'follow-up-policy', input: { action: 'pause', subject: bot, expectedRevision: 1 } });
    expect(await core.read({ kind: 'follow-up-subjects', cursor: page.next })).toMatchObject({ kind: 'rejected', code: 'stale' });
  } finally { await core.close(); }
});
