import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { abandonGroupFollowUp, acceptGroupFollowUp, prepareGroupFollowUp } from '../src/host/proactive/group-follow-up.js';
import type { Groups } from '../src/host/groups/service.js';
import type { ProactiveService } from '../src/host/proactive/service.js';
import type { CommandBody } from '../src/shared/proactive/protocol.js';
import type { FollowUpGroupAcceptRequest } from '../src/shared/proactive/group-follow-up.js';
import { digest } from '../src/host/proactive/wire.js';
import { proactiveWorker } from './proactive-worker-fixture.js';

const subject = { kind: 'group', group: { groupId: 'four-members', groupCreatedAt: 1 } } as const;
const choice = { predecessorTurnId: 'original-turn', predecessorTurnRevision: 3,
  membershipRevision: 1, modelRevision: 0, memberId: 'member-c', bot: { botId: 'gamma', botCreatedAt: 1 },
  botRevision: 1, modelSelection: { provider: 'fixture', model: 'default' } };
const planInput = (request: FollowUpGroupAcceptRequest) => ({ subject: request.subject, cardId: request.cardId, expectedRevision: request.expectedRevision });
const nativeTurn = (request: FollowUpGroupAcceptRequest) => ({ id: 'one-native-turn', inputSeq: 4, state: 'accepted',
  operationId: request.commandId, group: subject.group,
  ownerFollowUp: { ...request.choice, cardId: request.cardId, cardRevision: request.expectedRevision } });

async function setup() {
  const core = await proactiveWorker();
  await core.submit({ kind: 'follow-up-policy', input: { subject, action: 'enable-local', expectedRevision: 0 } });
  await core.submit({ kind: 'follow-up-ingest', input: { kind: 'local-task-state/v1', subject,
    sourceId: 'group-turns', sourceGeneration: 1, pauseEpoch: 0, expectedCursor: null, nextCursor: '1', facts: [{
      nativeId: 'original-turn', nativeRevision: 3, occurredAt: new Date().toISOString(), payloadDigest: digest('failure'),
      origin: { kind: 'group-turn', turnId: 'original-turn' }, title: 'Group task failed', condition: { kind: 'failed' },
    }] } });
  const summary = await core.read({ kind: 'follow-up-summary', subject });
  if (summary.kind !== 'follow-up-summary' || !summary.summary.rows[0]) throw new Error('Card missing');
  const card = summary.summary.rows[0];
  const request: FollowUpGroupAcceptRequest = { commandId: randomUUID(), subject, cardId: card.id,
    expectedRevision: card.revision, expectedPolicyRevision: 1, choice, text: 'Inspect the failed task with the current evidence', approved: true };
  const service = { read: core.read, change: core.change, ownsFollowUpSubject: async () => true,
    followUpSummary: async () => { const result = await core.read({ kind: 'follow-up-summary', subject });
      if (result.kind !== 'follow-up-summary') throw new Error('summary'); return result.summary; },
  } as unknown as ProactiveService;
  return { core, card, request, service };
}

test('real coordinator records one exact native continuation and deduplicates operation and card acceptance', async () => {
  const f = await setup();
  try {
    const { commandId, ...input } = f.request;
    const body: CommandBody = { kind: 'follow-up-group-accept', operationId: commandId, input };
    expect(await f.core.change(commandId, body)).toMatchObject({ receipt: { stored: 1 } });
    expect(await f.core.change(commandId, body)).toMatchObject({ receipt: { status: 'duplicate' } });
    expect(await f.core.change(commandId, { ...body, input: { ...input, text: 'changed' } })).toMatchObject({ kind: 'rejected', code: 'conflict' });
    const other = randomUUID();
    expect(await f.core.change(other, { ...body, operationId: other })).toMatchObject({ kind: 'rejected', code: 'conflict' });
    expect(await f.core.read({ kind: 'follow-up-group-plan', input: planInput(f.request) })).toMatchObject({ plan: { commandId, input } });
    await f.core.restart();
    expect(await f.core.change(commandId, body)).toMatchObject({ receipt: { status: 'duplicate' } });
    await f.core.submit({ kind: 'follow-up-group-started', operationId: commandId, inputDigest: digest(input), turnId: 'real-next-turn' });
    expect(await f.core.read({ kind: 'follow-up-summary', subject })).toMatchObject({ summary: { rows: [{
      id: f.card.id, state: 'closed', condition: { kind: 'closed', reason: 'resolved' },
    }] } });
    expect(await f.core.read({ kind: 'work-list' })).toMatchObject({ work: [] });
  } finally { await f.core.close(); }
});

test('Host bridge preserves frozen input on uncertain admission and permits a prior manual acceptance after pause', async () => {
  const f = await setup();
  try {
    let interrupt = true; let starts = 0;
    const persisted = new Map<string, ReturnType<typeof nativeTurn>>();
    const groups = { ownerFollowUpChoice: async () => choice, ownerFollowUpUnstarted: async () => true,
      startOwnerFollowUp: async (_key: unknown, request: { operationId: string; text: string }, _choice: unknown,
        admit: () => Promise<void>, check: () => Promise<void>) => {
        const old = persisted.get(request.operationId); if (old) return old;
        await admit();
        if (interrupt) throw new Error('Crash before native persistence');
        await check(); starts++; const turn = nativeTurn(f.request); persisted.set(request.operationId, turn); return turn;
      },
    } as unknown as Groups;
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toEqual({ kind: 'unknown', commandId: f.request.commandId });
    const offer = await prepareGroupFollowUp(f.service, groups, { subject, cardId: f.card.id, expectedRevision: 0, memberId: 'member-b' });
    expect(offer.existing).toEqual(f.request);
    await f.core.submit({ kind: 'follow-up-policy', input: { subject, action: 'pause', expectedRevision: 1 } });
    interrupt = false;
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toMatchObject({ kind: 'started', turnId: 'one-native-turn' });
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toMatchObject({ kind: 'started', turnId: 'one-native-turn' });
    expect(starts).toBe(1);
    expect(await acceptGroupFollowUp(f.service, groups, { ...f.request, text: 'different intent' })).toMatchObject({ kind: 'rejected', code: 'conflict' });
  } finally { await f.core.close(); }
});

test('pause before group admission refuses dispatch without creating an accepted plan', async () => {
  const f = await setup();
  try {
    await f.core.submit({ kind: 'follow-up-policy', input: { subject, action: 'pause', expectedRevision: 1 } });
    let starts = 0;
    const groups = { startOwnerFollowUp: async (_key: unknown, _input: unknown, _choice: unknown, admit: () => Promise<void>) => {
      await admit(); starts++; return { id: 'must-not-exist' };
    } } as unknown as Groups;
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toMatchObject({ kind: 'rejected' });
    expect(starts).toBe(0);
    expect(await f.core.read({ kind: 'follow-up-group-plan', input: planInput(f.request) })).toMatchObject({ plan: null });
  } finally { await f.core.close(); }
});

test('a new scoped global activation fences an old accepted group plan before native restore', async () => {
  const f = await setup();
  try {
    const { commandId, ...input } = f.request;
    await f.core.change(commandId, { kind: 'follow-up-group-accept', operationId: commandId, input });
    await f.core.restart({ bootstrap: { kind: 'enable-local', operationId: randomUUID(), configEpoch: randomUUID(),
      expectedRevision: 0, subject: { kind: 'bot', bot: { botId: 'another-bot', botCreatedAt: 2 } } } });
    let calls = 0;
    const groups = { startOwnerFollowUp: async () => { calls++; return nativeTurn(f.request); } } as unknown as Groups;
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(calls).toBe(0);
  } finally { await f.core.close(); }
});

test('a native durable row without proven input stays unknown and keeps the failure visible', async () => {
  const f = await setup();
  try {
    const groups = { startOwnerFollowUp: async (_key: unknown, _input: unknown, _choice: unknown, admit: () => Promise<void>) => {
      await admit(); return { ...nativeTurn(f.request), inputSeq: undefined, state: 'recovery_needed' };
    } } as unknown as Groups;
    expect(await acceptGroupFollowUp(f.service, groups, f.request)).toEqual({ kind: 'unknown', commandId: f.request.commandId });
    expect(await f.core.read({ kind: 'follow-up-summary', subject })).toMatchObject({ summary: { rows: [{ id: f.card.id, state: 'open' }] } });
    const unavailable = { read: async () => { throw new Error('lost connection'); } } as unknown as ProactiveService;
    expect(await acceptGroupFollowUp(unavailable, groups, f.request)).toEqual({ kind: 'unknown', commandId: f.request.commandId });
  } finally { await f.core.close(); }
});

test('owner abandonment retires an unstarted plan and allows a fresh exact card revision', async () => {
  const f = await setup();
  try {
    const { commandId: operationId, ...input } = f.request;
    const original: CommandBody = { kind: 'follow-up-group-accept', operationId, input };
    await f.core.change(operationId, original);
    let nativeRecordExists = true;
    const groups = {
      abandonOwnerFollowUp: async (_key: unknown, _operationId: string, abandon: () => Promise<unknown>) => {
        if (nativeRecordExists) throw { code: 'dsh-bot/conflict' };
        return abandon();
      },
    } as unknown as Groups;
    const request = { ...planInput(f.request), operationId, commandId: randomUUID(), approved: true } as const;
    expect(await abandonGroupFollowUp(f.service, groups, request)).toMatchObject({ kind: 'rejected', code: 'conflict' });
    expect(await f.core.read({ kind: 'follow-up-group-plan', input: planInput(f.request) })).toMatchObject({ plan: { commandId: operationId } });
    nativeRecordExists = false;
    expect(await abandonGroupFollowUp(f.service, groups, request)).toMatchObject({ kind: 'receipt', receipt: { status: 'committed' } });
    expect(await abandonGroupFollowUp(f.service, groups, request)).toMatchObject({ kind: 'receipt', receipt: { status: 'duplicate' } });
    expect(await f.core.change(operationId, original)).toMatchObject({ kind: 'rejected', code: 'forbidden' });
    expect(await f.core.read({ kind: 'follow-up-group-plan', input: planInput(f.request) })).toMatchObject({
      plan: null, card: { revision: f.card.revision + 1, state: 'open', condition: { kind: 'failed' } },
    });
    const fresh = randomUUID();
    expect(await f.core.change(fresh, { ...original, operationId: fresh, input: { ...input, expectedRevision: f.card.revision + 1 } }))
      .toMatchObject({ kind: 'receipt', receipt: { stored: 1 } });
  } finally { await f.core.close(); }
});
