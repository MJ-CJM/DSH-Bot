import { expect, test, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { GroupState } from '../src/host/groups/state.js';
import { FollowUpEvents } from '../src/host/proactive/follow-up-events.js';
import { GROUP_ROOT_PRESET, groupKey, type GroupDelivery, type GroupRecord, type GroupTurn } from '../src/shared/groups.js';
import type { Subject } from '../src/shared/proactive/follow-up.js';
import { alpha, beta, withIntegrations } from './integration-support.js';
import { proactiveWorker } from './proactive-worker-fixture.js';

const personal = { kind: 'bot', bot: alpha } as const;
type Worker = Awaited<ReturnType<typeof proactiveWorker>>;
function provideWorker(ctx: Context, core: Worker, read = core.read) {
  return ctx.provide('dshBotProactive', {
    read, change: core.change,
    ingestFollowUp: (id, input) => core.change(id, { kind: 'follow-up-ingest', input }),
  } as Pick<Context['dshBotProactive'], 'read' | 'change' | 'ingestFollowUp'> as Context['dshBotProactive']);
}
const enable = (subject: Subject, expectedRevision = 0) => ({
  kind: 'follow-up-policy', input: { action: 'enable-local', subject, expectedRevision },
} as const);

test('cold group reconciliation keeps native failure timing and aggregates the exact group turn', async () => {
  const core = await proactiveWorker();
  try {
    await withIntegrations(async fixture => {
      provideWorker(fixture.ctx, core);
      const domain = await fixture.ctx.storageDomain.open(groupsDomain);
      const state = new GroupState(fixture.ctx, fixture.registry, domain, () => {});
      const at = Date.now() - 60000;
      const group: GroupRecord = { id: 'local-group', operationId: 'create', createDigest: 'fixture',
        createdAt: at, updatedAt: at, schemaVersion: 1, name: 'Native group', rootSessionId: 'group-root',
        rootPresetId: GROUP_ROOT_PRESET, cwd: fixture.root, mode: 'mention', membershipRevision: 1,
        revision: 1, archived: false, state: 'ready' };
      const subject = { kind: 'group', group: groupKey(group) } as const;
      const turn = (id: string, time: number, state: GroupTurn['state']): GroupTurn => ({
        id, group: subject.group, operationId: id, requestDigest: 'fixture', inputMessageId: id,
        createdAt: time, updatedAt: time, revision: 1, schemaVersion: 1, membershipRevision: 1,
        orderedMemberIds: ['one', 'two'], mode: 'mention', contextThroughSeq: -1, state,
      });
      const delivery = (row: GroupTurn, ordinal: number, bot = alpha): GroupDelivery => ({
        id: `${row.id}:${ordinal}`, turnId: row.id, memberId: ordinal ? 'two' : 'one', ordinal, bot,
        botRevision: 1, presetId: bot.botId, contextOutputMessageIds: [], contextTruncated: false,
        state: 'failed', failure: { message: `native error ${ordinal}` }, endedAt: row.createdAt,
      });
      await state.putGroup(group);
      const old = turn('old-failure', at, 'partial');
      await domain.table('turns').put(old.id, old);
      const oldDelivery = delivery(old, 0);
      await domain.table('deliveries').put(oldDelivery.id, oldDelivery);
      await core.submit(enable(subject));
      await core.submit(enable(personal));
      await state.putGroup({ ...group, name: 'Renamed group', revision: 2, updatedAt: Date.now() });

      const fresh = turn('fresh-failure', Date.now(), 'running');
      const started = await state.putTurn(fresh);
      await state.putDelivery(delivery(fresh, 0));
      await state.putDelivery(delivery(fresh, 1, beta));
      const finished = await state.putTurn({ ...fresh, state: 'partial' });
      expect(finished.revision).toBe(started.revision + 1);
      await state.putTurn(turn('completed-without-review', Date.now(), 'completed'));
      await state.putTurn(turn('idle-without-wait', Date.now(), 'idle'));

      const groups = new Groups(fixture.ctx, fixture.registry, domain, () => {});
      fixture.ctx.provide('dshBotGroups', groups);
      const bridge = new FollowUpEvents(fixture.ctx, fixture.registry);
      try {
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject } })).toMatchObject({
          page: { rows: [{ title: 'Renamed group', origin: { kind: 'group-turn', turnId: fresh.id },
            condition: { kind: 'failed', members: [
              { deliveryId: `${fresh.id}:0`, memberId: 'one', reason: 'native error 0' },
              { deliveryId: `${fresh.id}:1`, memberId: 'two', reason: 'native error 1' },
            ] } }] },
        });
        expect(await core.read({ kind: 'follow-up-page', input: { subject: personal } })).toMatchObject({ page: { rows: [] } });

        await core.submit({ kind: 'follow-up-policy', input: { action: 'pause', subject, expectedRevision: 1 } });
        bridge.reset();
        await state.putGroup({ ...group, name: 'Renamed group', revision: 3, archived: true, updatedAt: Date.now() });
        bridge.changed(subject.group);
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject } })).toMatchObject({
          page: { rows: [{ revision: 0, condition: { kind: 'failed' } }] },
        });
      } finally { await bridge.close(); state.closeIndex(); await groups.close(); }
    });
  } finally { await core.close(); }
});

test('pages 1,000 original Group turns once and projects 30 durable changes without rescanning either table', async () => {
  const core = await proactiveWorker();
  try {
    await withIntegrations(async fixture => {
      provideWorker(fixture.ctx, core);
      const seed = await fixture.ctx.storageDomain.open(groupsDomain);
      const at = Date.now() - 60000;
      const group: GroupRecord = { id: 'large-group', operationId: 'create', createDigest: 'fixture',
        createdAt: at, updatedAt: at, schemaVersion: 1, name: 'Large group', rootSessionId: 'large-root',
        rootPresetId: GROUP_ROOT_PRESET, cwd: fixture.root, mode: 'mention', membershipRevision: 1,
        revision: 1, archived: false, state: 'ready' };
      const subject = { kind: 'group', group: groupKey(group) } as const;
      await seed.table('groups').put(group.id, group);
      const ids = Array.from({ length: 1000 }, (_, index) => `turn:${String(index).padStart(4, '0')}`);
      for (const id of ids) {
        await seed.table('turns').put(id, { id, group: subject.group, operationId: id, requestDigest: 'fixture', inputMessageId: id,
          createdAt: at, updatedAt: at, revision: 1, schemaVersion: 1, membershipRevision: 1,
          orderedMemberIds: ['one'], mode: 'mention', contextThroughSeq: -1, state: 'completed' });
        await seed.table('deliveries').put(`${id}:0`, { id: `${id}:0`, turnId: id, memberId: 'one', ordinal: 0, bot: alpha,
          botRevision: 1, presetId: alpha.botId, contextOutputMessageIds: [], contextTruncated: false, state: 'completed', endedAt: at });
      }
      await seed.close();
      const domain = await fixture.ctx.storageDomain.open(groupsDomain);
      const turns = domain.table('turns'), deliveries = domain.table('deliveries');
      const turnScans = vi.spyOn(turns, 'entries'), deliveryScans = vi.spyOn(deliveries, 'entries');
      const turnReads = vi.spyOn(turns, 'get'), deliveryReads = vi.spyOn(deliveries, 'get');
      const groups = new Groups(fixture.ctx, fixture.registry, domain, () => {});
      fixture.ctx.provide('dshBotGroups', groups);
      const bridge = new FollowUpEvents(fixture.ctx, fixture.registry);
      try {
        const visited: string[] = [];
        let page = await groups.followUpFacts(subject.group);
        for (;;) {
          expect(page.rows.length).toBeLessThanOrEqual(16);
          visited.push(...page.rows.map(row => row.turn.id));
          if (!page.next) break;
          page = await groups.followUpFacts(subject.group, { page: page.next });
        }
        expect(visited).toEqual(ids);
        expect(turnReads).toHaveBeenCalledTimes(2000);
        expect(deliveryReads).toHaveBeenCalledTimes(1000);
        const moved = deliveries.get('turn:0000:0');
        if (!moved) throw new Error('Missing indexed delivery');
        await deliveries.put(moved.id, { ...moved, turnId: 'turn:0001' });
        expect((await groups.followUpFacts(subject.group, { turnId: 'turn:0000' })).rows[0]?.deliveries).toEqual([]);
        expect((await groups.followUpFacts(subject.group, { turnId: 'turn:0001' })).rows[0]?.deliveries).toHaveLength(2);
        await deliveries.delete(moved.id);
        expect((await groups.followUpFacts(subject.group, { turnId: 'turn:0001' })).rows[0]?.deliveries).toHaveLength(1);
        await deliveries.put(moved.id, moved);

        await core.submit(enable(subject));
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-summary', subject })).toMatchObject({ summary: { rows: [] } });
        turnReads.mockClear(); deliveryReads.mockClear();
        const changed = ids.slice(0, 30);
        const started = performance.now();
        await Promise.all(changed.map(async id => {
          const row = deliveries.get(`${id}:0`);
          if (!row) throw new Error('Missing original delivery');
          await deliveries.put(row.id, { ...row, revision: 1, updatedAt: Date.now(), endedAt: Date.now(),
            state: 'failed', failure: { message: 'Native fixture failure' } });
          bridge.changed(subject.group, id);
        }));
        await bridge.flush();
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-summary', subject })).toMatchObject({
          summary: { rows: [{ condition: { kind: 'failed' } }, { condition: { kind: 'failed' } }, { condition: { kind: 'failed' } }] },
        });
        const elapsed = performance.now() - started;
        console.log(`Group fact burst: 30 durable changes to summary query in ${Math.round(elapsed)} ms`);
        expect(elapsed).toBeLessThan(10000);
        const first = await core.read({ kind: 'follow-up-page', input: { subject } });
        if (first.kind !== 'follow-up-page' || !first.page.next) throw new Error('Missing first facts page');
        const second = await core.read({ kind: 'follow-up-page', input: { subject, cursor: first.page.next } });
        if (second.kind !== 'follow-up-page') throw new Error('Missing second facts page');
        const observed = [...first.page.rows, ...second.page.rows].map(row => row.origin.kind === 'group-turn' ? row.origin.turnId : '');
        expect(observed.sort()).toEqual(changed);
        expect(turnScans).toHaveBeenCalledTimes(1);
        expect(deliveryScans).toHaveBeenCalledTimes(1);
        expect(turnReads).toHaveBeenCalledTimes(30);
        expect(deliveryReads).toHaveBeenCalledTimes(90);
      } finally { await bridge.close(); await groups.close(); }
    });
  } finally { await core.close(); }
}, 90000);

test('one native listChildren observation supplies all pages of a 1,000-child parent', async () => {
  const core = await proactiveWorker();
  try {
    await withIntegrations(async fixture => {
      provideWorker(fixture.ctx, core);
      const main = SessionId('bot-main');
      Object.assign(fixture.registry, { mainSessions: { boundSessionId: () => main } });
      const catalog = Array.from({ length: 1000 }, (_, index) => ({
        id: SessionId(`child:${index}`), createdAt: index + 1, mode: 'one-shot' as const,
      }));
      const listChildren = vi.fn(async () => catalog);
      const stat = vi.fn(async (_child: string) => undefined);
      fixture.ctx.provide('subagents', { listChildren } as unknown as Context['subagents']);
      fixture.ctx.provide('sessions', { get: () => undefined } as unknown as Context['sessions']);
      fixture.ctx.provide('sessionPersistence', { stat } as unknown as Context['sessionPersistence']);
      const bridge = new FollowUpEvents(fixture.ctx, fixture.registry);
      try {
        const initial = await core.submit(enable(personal));
        if (initial.kind !== 'receipt' || !initial.receipt) throw new Error('Missing enabled policy receipt');
        for (let tick = 0; tick < 80 && stat.mock.calls.length < catalog.length; tick++) await bridge.flush();
        expect(await core.change(initial.receipt.commandId, enable(personal))).toMatchObject({ receipt: { status: 'duplicate' } });
        bridge.reset(false);
        await bridge.flush();
        expect(listChildren).toHaveBeenCalledExactlyOnceWith(main, expect.any(AbortSignal));
        expect(stat.mock.calls.map(([child]) => child)).toEqual(catalog.map(child => child.id));
      } finally { await bridge.close(); }
    });
  } finally { await core.close(); }
});

test('cold native catalog fallback folds only the current own child outcome across log pages', async () => {
  const core = await proactiveWorker();
  try {
    await withIntegrations(async fixture => {
      const main = SessionId('bot-main');
      const group = SessionId('group-root');
      let bound: string = main;
      Object.assign(fixture.registry, { mainSessions: { boundSessionId: (id: string, createdAt: number) =>
        id === alpha.botId && createdAt === alpha.botCreatedAt ? bound : undefined } });
      const makeSession = (id: string, parentSession?: typeof main) => Session.create(SessionId(id), undefined, {
        version: 4, id: SessionId(id), createdAt: Date.now(), isSeeded: false,
        ...(parentSession ? { parentSession, origin: 'subagent' as const } : {}),
      });
      const root = makeSession(main);
      const historical = makeSession('historical-child', main);
      const failure = makeSession('failed-child', main);
      const groupChild = makeSession('group-child', group);
      const descriptor = (session: Session, label: string) => session.append('subagent/descriptor',
        { version: 3, mode: 'one-shot', provider: 'spawn', label });
      const fail = (session: Session, turn: number) => session.append('turn/end',
        { turn, reason: { kind: 'error', error: { code: 'FIXTURE', message: 'Native child failure' } } });
      for (const [child, label] of [[historical, 'Old lifecycle'], [failure, 'Current lifecycle'], [groupChild, 'Group member']] as const)
        root.append('subagent/catalog', { version: 0, mode: 'one-shot', childId: child.id, childCreatedAt: child.header.createdAt, label });
      historical.append('turn/start', { turn: 1 });
      descriptor(historical, 'Old lifecycle');
      fail(historical, 1);
      for (let index = 0; index < 260; index++)
        historical.append('session/title', { title: `fixture ${index}`, messageSeqs: [], source: { kind: 'user' } });
      historical.append('turn/start', { turn: 2 });
      historical.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
      groupChild.append('turn/start', { turn: 1 });
      descriptor(groupChild, 'Group member');
      fail(groupChild, 1);
      await core.submit(enable(personal));
      failure.append('turn/start', { turn: 1 });
      descriptor(failure, 'Current lifecycle');
      fail(failure, 1);
      const nativeLogs = new Map([root, historical, failure, groupChild].map(session => [session.id, session]));
      const read = vi.fn((session: Session, offset: number, length: number) =>
        ({ events: session.snapshotEvents().slice(offset, offset + length) }));
      fixture.ctx.provide('sessions', { get: () => undefined } as unknown as Context['sessions']);
      fixture.ctx.provide('subagents', { listChildren: async () => {
        throw Object.assign(new Error('Minimal profile'), { code: 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE' });
      } } as unknown as Context['subagents']);
      fixture.ctx.provide('sessionPersistence', {
        async stat(id: typeof main) { return nativeLogs.get(id)?.header; },
        async open(id: typeof main) {
          const session = nativeLogs.get(id);
          if (!session) throw new Error('Missing native log');
          return { header: session.header, inheritedEventCount: 0,
            read: async (offset: number, length: number) => read(session, offset, length), close: async () => {} };
        },
      } as unknown as Context['sessionPersistence']);
      provideWorker(fixture.ctx, core);
      const bridge = new FollowUpEvents(fixture.ctx, fixture.registry);
      try {
        await bridge.flush();
        expect(read).toHaveBeenCalledWith(historical, 256, 256);
        expect(await core.read({ kind: 'follow-up-page', input: { subject: personal } })).toMatchObject({
          page: { rows: [{ title: 'Current lifecycle', origin: { kind: 'native-subagent', childSessionId: failure.id, turn: 1 },
            condition: { kind: 'failed', reason: 'Native child failure' } }] },
        });
        failure.append('turn/start', { turn: 2 });
        failure.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
        bridge.childChanged(main, failure.id, failure.header.createdAt);
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject: personal } })).toMatchObject({
          page: { rows: [{ revision: 1, origin: { childSessionId: failure.id, turn: 2 }, condition: { kind: 'closed', reason: 'resolved' } }] },
        });
        failure.append('turn/start', { turn: 3 });
        fail(failure, 3);
        bridge.childChanged(main, failure.id, failure.header.createdAt);
        bound = 'new-main';
        await bridge.flush();
        expect(await core.read({ kind: 'follow-up-page', input: { subject: personal } })).toMatchObject({
          page: { rows: [{ revision: 1, origin: { childSessionId: failure.id, turn: 2 } }] },
        });
      } finally { await bridge.close(); }
    });
  } finally { await core.close(); }
});
