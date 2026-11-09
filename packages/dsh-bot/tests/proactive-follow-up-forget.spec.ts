import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import type { Decision, Thread, Trigger, TriggerDisposition } from '../coordinator/vendor/src/core/model.js';
import { digest } from '../src/host/proactive/wire.js';
import { subjectKey, type FollowUpCard, type Subject } from '../src/shared/proactive/follow-up.js';
import type { FollowUpGroupInput } from '../src/shared/proactive/group-follow-up.js';
import type { CommandBody } from '../src/shared/proactive/protocol.js';
import { proactiveWorker } from './proactive-worker-fixture.js';

interface Store {
  db: DatabaseSync;
  close(): void;
  read: { threadTriggers(key: string, limit: number): Trigger[] };
  triggers: { save(trigger: Trigger): void; disposition(id: string): TriggerDisposition | undefined;
    saveDisposition(id: string, disposition: TriggerDisposition): void };
  decisions: { byThread(key: string): Decision[]; save(decision: Decision): void };
  threads: { get(key: string): Thread | undefined; save(thread: Thread): void };
}
const CoreStore = (await import(pathToFileURL(resolve('lib/proactive-coordinator/core.mjs')).href)).Store as { new(path: string): Store };
const bot = { kind: 'bot', bot: { botId: 'forget-bot', botCreatedAt: 10 } } as const;
const group = { kind: 'group', group: { groupId: 'forget-group', groupCreatedAt: 11 } } as const;
type Core = Awaited<ReturnType<typeof proactiveWorker>>;
const enable = (subject: Subject, expectedRevision = 0): CommandBody => ({
  kind: 'follow-up-policy', input: { subject, expectedRevision, action: 'enable-local' },
});
const createWatch = (subject: Subject, title: string): CommandBody => ({
  kind: 'follow-up-watch-create', input: { subject, id: 'watch-same-id', expectedRevision: 1,
    watch: { title, completion: `${title}-complete`, source: { kind: 'manual' },
      wait: { reason: `${title}-reason`, request: `${title}-request` } } },
});
const threadKey = (card: FollowUpCard) => `local:${digest(subjectKey(card.subject))}:${card.id}`;
function withStore<T>(core: Core, use: (store: Store) => T): T {
  const store = new CoreStore(join(core.root, 'store', 'core.sqlite'));
  try { return use(store); } finally { store.close(); }
}
async function cards(core: Core, subject: Subject) {
  const result = await core.read({ kind: 'follow-up-page', input: { subject } });
  if (result.kind !== 'follow-up-page') throw new Error('Expected follow-up page');
  return result.page.rows;
}
async function oneCard(core: Core, subject: Subject) {
  const result = (await cards(core, subject))[0];
  if (!result) throw new Error('Expected a scoped follow-up card');
  return result;
}
function action(card: FollowUpCard, value: 'forget' | 'complete', expectedPolicyRevision: number): CommandBody {
  return { kind: 'follow-up-action', input: { subject: card.subject, cardId: card.id, expectedRevision: card.revision,
    expectedPolicyRevision, action: value } };
}
function assertRedacted(store: Store, card: FollowUpCard, expected: number) {
  const key = threadKey(card);
  const triggers = store.read.threadTriggers(key, expected + 1);
  expect(triggers).toHaveLength(expected);
  for (const trigger of triggers) {
    expect(trigger).toMatchObject({ text: '[redacted]', meta: { bodyRedacted: true, bodyDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(trigger.url).toBeUndefined();
    expect(trigger.channel).toBeUndefined();
    const disposition = store.triggers.disposition(trigger.id);
    expect(String(JSON.stringify(disposition))).not.toContain('LEGACY_PRIVATE');
  }
  const decisions = store.decisions.byThread(key);
  expect(decisions).toHaveLength(expected);
  expect(decisions.every(row => row.audit === undefined && row.reason.every(item => item.code === 'redacted'))).toBe(true);
  expect(store.threads.get(key)?.meta).toEqual({ bodyRedacted: true });
  const tombstone = store.db.prepare("SELECT * FROM pb_governance_tombstone WHERE kind='follow-up' AND id=?").get(card.id);
  expect(tombstone).toMatchObject({ id: card.id, digest: expect.stringMatching(/^[a-f0-9]{64}$/), audit: '{}' });
  expect(JSON.stringify(tombstone)).not.toContain(card.title);
  expect(store.db.prepare('SELECT card,watch FROM pb_follow_up_head WHERE id=?').get(card.id)).toBeUndefined();
}

test('forgets all historical versions of an exact closed watch even while paused and keeps only receipts and tombstones', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(bot));
    await core.submit(enable(group));
    await core.submit(createWatch(bot, 'PRIVATE_WATCH_ORIGINAL'));
    await core.submit(createWatch(group, 'PRESERVE_GROUP_WATCH'));
    const initial = await oneCard(core, bot);
    for (let version = 0; version < 65; version++) {
      await core.submit({ kind: 'follow-up-watch-update', input: { subject: bot, cardId: initial.id,
        expectedRevision: version, expectedPolicyRevision: 1,
        watch: { title: `PRIVATE_WATCH_${version}`, completion: `PRIVATE_COMPLETION_${version}`,
          wait: { reason: `PRIVATE_WAIT_${version}`, request: `PRIVATE_REQUEST_${version}` }, source: { kind: 'manual' } } } });
    }
    await core.submit(action(await oneCard(core, bot), 'complete', 1));
    await core.submit({ kind: 'follow-up-policy', input: { subject: bot, action: 'pause', expectedRevision: 1 } });
    const forgotten = await oneCard(core, bot);
    const preserved = await oneCard(core, group);
    expect(forgotten.state).toBe('closed');
    await core.restart({ prepare: () => withStore(core, store => {
      const key = threadKey(forgotten);
      const triggers = store.read.threadTriggers(key, 100);
      expect(triggers).toHaveLength(66);
      expect(triggers.every(row => row.text === 'Local follow-up fact')).toBe(true);
      for (const [index, trigger] of triggers.entries()) {
        store.triggers.save({ ...trigger, text: `LEGACY_PRIVATE_TRIGGER_${index}`, url: 'https://fixture.invalid/private' });
        const disposition = store.triggers.disposition(trigger.id);
        if (!disposition) throw new Error('Expected legacy trigger disposition');
        store.triggers.saveDisposition(trigger.id, { ...disposition, filtered: { code: 'LEGACY_PRIVATE_DISPOSITION' } });
      }
      for (const row of store.decisions.byThread(key)) store.decisions.save({ ...row, audit: { proposal: 'LEGACY_PRIVATE_AUDIT' } });
      const thread = store.threads.get(key);
      if (!thread) throw new Error('Expected legacy thread');
      store.threads.save({ ...thread, meta: { details: 'LEGACY_PRIVATE_THREAD' } });
    }) });
    expect(await core.change(randomUUID(), action(forgotten, 'forget', 1))).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await core.change(randomUUID(), { kind: 'follow-up-action', input: {
      subject: group, cardId: forgotten.id, expectedRevision: forgotten.revision, expectedPolicyRevision: 1, action: 'forget',
    } })).toMatchObject({ kind: 'rejected', code: 'stale' });
    const op = randomUUID();
    const request = action(forgotten, 'forget', 2);
    const original = await core.change(op, request);
    expect(original).toMatchObject({ kind: 'receipt', receipt: { status: 'committed', stored: 1 } });
    expect(await cards(core, bot)).toEqual([]);
    expect(await cards(core, group)).toEqual([preserved]);
    await core.restart({ prepare: () => withStore(core, store => {
      assertRedacted(store, forgotten, 66);
      const inbox = store.db.prepare('SELECT * FROM pb_inbox').all();
      expect(Object.keys(inbox[0] ?? {}).sort()).toEqual(['digest', 'id', 'receipt']);
      expect(JSON.stringify(inbox)).not.toMatch(/PRIVATE_WATCH|PRIVATE_REQUEST|PRIVATE_COMPLETION|PRIVATE_WAIT/);
      expect(store.db.prepare('SELECT watch FROM pb_follow_up_head WHERE id=?').get(preserved.id)?.watch)
        .toContain('PRESERVE_GROUP_WATCH');
    }) });
    const duplicate = await core.change(op, request);
    expect(duplicate).toMatchObject({ kind: 'receipt', receipt: { status: 'duplicate' } });
    if (original.kind === 'receipt' && duplicate.kind === 'receipt') expect(duplicate.receipt?.receiptId).toBe(original.receipt?.receiptId);
    await core.submit(enable(bot, 2));
    const recreate = createWatch(bot, 'LATE_PRIVATE_WATCH');
    if (recreate.kind !== 'follow-up-watch-create') throw new Error('Invalid test command');
    expect(await core.change(randomUUID(), { ...recreate, input: { ...recreate.input, expectedRevision: 3 } }))
      .toMatchObject({ kind: 'rejected', code: 'conflict' });
    expect(await cards(core, bot)).toEqual([]);
  } finally { await core.close(); }
}, 15000);

test('fences a newly revised forgotten group turn without dropping an unrelated fact or blocking its source cursor', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(group));
    const fact = { nativeId: 'same-group-turn', nativeRevision: 1, occurredAt: new Date().toISOString(),
      payloadDigest: digest('sensitive'), origin: { kind: 'group-turn', turnId: 'same-group-turn' },
      title: 'PRIVATE_GROUP_FAILURE', condition: { kind: 'failed', reason: 'PRIVATE_GROUP_CAUSE' },
    } as const;
    const input = { kind: 'local-task-state/v1', subject: group, sourceId: 'group-facts',
      sourceGeneration: 11, pauseEpoch: 0, expectedCursor: null, nextCursor: 'first', facts: [fact],
    } as const;
    await core.submit({ kind: 'follow-up-ingest', input: { ...input, facts: [...input.facts] } });
    const removed = await oneCard(core, group);
    await core.submit(action(removed, 'forget', 1));
    await core.restart({ prepare: () => withStore(core, store => assertRedacted(store, removed, 1)) });
    await core.submit({ kind: 'follow-up-ingest', input: { ...input, expectedCursor: 'first', nextCursor: 'second',
      facts: [{ ...fact, nativeRevision: 2, title: 'REPLAY_SENSITIVE_NEW_VERSION', payloadDigest: digest('changed') },
        { ...fact, nativeId: 'other-turn', origin: { kind: 'group-turn', turnId: 'other-turn' },
          title: 'Preserve other group turn', payloadDigest: digest('other') }],
    } });
    expect(await cards(core, group)).toMatchObject([{ title: 'Preserve other group turn' }]);
    expect(await core.read({ kind: 'follow-up-source', subject: group, sourceId: 'group-facts', sourceGeneration: 11 }))
      .toMatchObject({ cursor: 'second' });
  } finally { await core.close(); }
});

test('forgets exact group continuation text and member choice, including all plans for the same card', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(group));
    const fact = (id: string, revision: number, occurredAt: string) => ({ nativeId: id, nativeRevision: revision, occurredAt,
      payloadDigest: digest([id, revision]), origin: { kind: 'group-turn' as const, turnId: id },
      title: `Failed ${id}`, condition: { kind: 'failed' as const, reason: 'Work requires attention' } });
    const intake = { kind: 'local-task-state/v1', subject: group, sourceId: 'group-facts', sourceGeneration: 11, pauseEpoch: 0 } as const;
    const firstAt = new Date().toISOString();
    await core.submit({ kind: 'follow-up-ingest', input: { ...intake, expectedCursor: null, nextCursor: 'first',
      facts: [fact('forget-turn', 1, firstAt), fact('other-turn', 1, firstAt)] } });
    const getCard = async (id: string) => {
      const result = (await cards(core, group)).find(row => row.origin.kind === 'group-turn' && row.origin.turnId === id);
      if (!result) throw new Error('Expected exact native group turn card');
      return result;
    };
    const makePlan = (card: FollowUpCard, predecessorTurnId: string, text: string): FollowUpGroupInput => ({
      subject: group, cardId: card.id, expectedRevision: card.revision, expectedPolicyRevision: 1, approved: true, text,
      choice: { predecessorTurnId, predecessorTurnRevision: 1, membershipRevision: 1, modelRevision: 0,
        memberId: `member-${predecessorTurnId}`, bot: bot.bot, botRevision: 10, modelSelection: { provider: 'fixture', model: 'test' } },
    });
    const accept = (operationId: string, input: FollowUpGroupInput) => core.change(operationId, { kind: 'follow-up-group-accept', operationId, input });
    const original = await getCard('forget-turn'), sibling = await getCard('other-turn');
    const op = randomUUID(), other = randomUUID();
    const planned = makePlan(original, 'forget-turn', 'PRIVATE_FIRST_PLAN'), preserved = makePlan(sibling, 'other-turn', 'PRESERVE_GROUP_PLAN');
    expect(await accept(op, planned)).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    expect(await accept(other, preserved)).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    await core.submit({ kind: 'follow-up-group-started', operationId: op, inputDigest: digest(planned), turnId: 'already-native-turn' });
    await core.submit({ kind: 'follow-up-ingest', input: { ...intake, expectedCursor: 'first', nextCursor: 'second',
      facts: [fact('forget-turn', 2, new Date().toISOString())] } });
    const current = await getCard('forget-turn');
    const pendingOp = randomUUID(), pending = makePlan(current, 'forget-turn', 'PRIVATE_PENDING_PLAN');
    expect(await accept(pendingOp, pending)).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    await core.submit(action(current, 'forget', 1));
    await core.restart({ prepare: () => withStore(core, store => {
      const plans = store.db.prepare('SELECT operation,payload FROM pb_follow_up_group').all();
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ operation: other, payload: expect.stringContaining('PRESERVE_GROUP_PLAN') });
      const marks = store.db.prepare("SELECT id,audit,digest FROM pb_governance_tombstone WHERE kind='follow-up-group'").all();
      expect(marks).toHaveLength(2);
      for (const operation of [op, pendingOp]) expect(marks).toContainEqual({ id: digest(operation), audit: '{}', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    }) });
    for (const input of [planned, pending]) {
      expect(await core.read({ kind: 'follow-up-group-plan', input: { subject: group, cardId: input.cardId, expectedRevision: input.expectedRevision } }))
        .toMatchObject({ kind: 'follow-up-group-plan', plan: null });
    }
    expect(await accept(pendingOp, pending)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
    expect(await accept(randomUUID(), pending)).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await core.change(randomUUID(), { kind: 'follow-up-group-started', operationId: pendingOp,
      inputDigest: digest(pending), turnId: 'late-native-turn' })).toMatchObject({ kind: 'rejected', code: 'stale' });
    expect(await cards(core, group)).toEqual([sibling]);
  } finally { await core.close(); }
});

test('existing source forget erases only the Work follow-up history and preserves an unrelated watch', async () => {
  const core = await proactiveWorker();
  try {
    await core.submit(enable(bot));
    await core.submit(createWatch(bot, 'PRESERVE_SIBLING_WATCH'));
    await core.submit({ kind: 'submit-document', approved: true,
      target: { bot: bot.bot, botUpdatedAt: 10, provider: 'fixture', model: 'test' },
      document: { kind: 'document-analysis', version: 1, name: 'PRIVATE_FORGOTTEN_DOCUMENT', sourceVersion: 1,
        content: 'PRIVATE_FORGOTTEN_DOCUMENT_CONTENT', question: 'What changed?', acceptance: 'Preserve exact evidence.' },
      taskLimits: { maxAttempts: 2, maxTokens: 1024, deadlineAt: new Date(Date.now() + 60000).toISOString() } });
    const work = async () => {
      const result = await core.read({ kind: 'work-list', owner: bot.bot });
      if (result.kind !== 'work-list' || !result.work[0]) throw new Error('Expected original Work');
      return result.work[0];
    };
    const row = await work();
    const key = { ticketId: row.ticketId, assignmentId: row.assignmentId };
    await core.submit({ kind: 'dispatch-claim', ...key, expectedRevision: row.revision, sessionId: randomUUID() });
    await core.submit({ kind: 'dispatch-send', ...key, expectedRevision: (await work()).revision, inputId: 'private-doc-input' });
    await core.submit({ kind: 'report-result', ...key, expectedRevision: (await work()).revision, result: {
      state: 'delivered', evidence: { inputId: 'private-doc-input', assistantId: 'result', turn: 1, outputDigest: digest('notes'),
        checks: ['source-match', 'turn-completed', 'transcript-flushed'] },
    } });
    const delivered = await work();
    if (!delivered.evidenceDigest) throw new Error('Expected Work evidence');
    await core.submit({ kind: 'review', ticketId: row.ticketId, review: 'accept', approved: true,
      expectedRevision: delivered.revision, evidenceDigest: delivered.evidenceDigest });
    const copy = (await cards(core, bot)).find(item => item.origin.kind === 'work');
    if (!copy) throw new Error('Expected a Work follow-up copy');
    const before = withStore(core, store => store.read.threadTriggers(threadKey(copy), 100).length);
    expect(before).toBeGreaterThan(1);
    const operationId = randomUUID();
    await core.submit({ kind: 'forget-begin', input: { operationId, sourceId: row.sourceId, generation: 1 } });
    await core.submit({ kind: 'forget-finish', input: { operationId, drained: [] } });
    expect((await work()).title).toBe('[redacted]');
    expect(await cards(core, bot)).toMatchObject([{ title: 'PRESERVE_SIBLING_WATCH' }]);
    await core.restart({ prepare: () => withStore(core, store => assertRedacted(store, copy, before)) });
    await core.submit({ kind: 'follow-up-policy', input: { subject: bot, action: 'pause', expectedRevision: 1 } });
    await core.submit(enable(bot, 2));
    expect(await cards(core, bot)).toMatchObject([{ title: 'PRESERVE_SIBLING_WATCH' }]);
  } finally { await core.close(); }
});
