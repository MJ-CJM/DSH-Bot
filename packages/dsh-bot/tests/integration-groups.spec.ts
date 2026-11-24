import { need } from '../src/host/common/operations.js';
import { executeRootSetup } from '../src/host/groups/root-guard.js';
import { describe, expect, it, vi } from 'vitest';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { withIntegrations, alpha, beta } from './integration-support.js';
import { Config } from '../lib/host/registry.js';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { groupContext, routeMembers, selectOnDemand } from '../src/host/groups/routing.js';
import { groupDeliverySchema, groupKey, groupViewSchema, GROUP_ROOT_PRESET, type GroupMessage, type GroupRecord } from '../src/shared/groups.js';
import { groupExportReviewStatus } from '../src/shared/group-export-review.js';
import { groupsSpec } from '../src/shared/groups-contract.js';
import { flowFixture } from './deepening/managed-flow-fixture.js';
async function fixture(f: Parameters<Parameters<typeof withIntegrations>[0]>[0], verifyRoot = false) {
  const roots = new Map<string, AgentHandle>(); const persisted = new Map<string, AgentHandle>(); const sequence: string[] = [];
  const config = Config({ dataDir: f.root, seedExamples: false, groupRoundTimeoutMs: 1000, groupTaskTimeoutMs: 1000 });
  Object.assign(f.registry, { config, list: async () => [...f.bots.values()], status: async () => [...f.bots.keys()].map(id => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })) });
  const workspaces = new Map<string, { id: string; path: string; sessionIds: SessionId[]; attachSession(id: SessionId): Promise<void> }>();
  const archivedSessionIds: SessionId[] = [];
  const archiveSession = vi.fn(async (id: SessionId) => {
    if (!archivedSessionIds.includes(id)) archivedSessionIds.push(id);
  });
  const workspaceRegistry = { archiveSession, archivedSessionIds, create: vi.fn(async (path: string) => {
    let workspace = workspaces.get(path);
    if (!workspace) { workspace = { id: `workspace-${workspaces.size}`, path, sessionIds: [], async attachSession(id: SessionId) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); } }; workspaces.set(path, workspace); }
    return workspace;
  }) };
  f.ctx.provide('workspaceRegistry', workspaceRegistry as never);
  Object.assign(f.registry, { ensureBotsWorkspace: async () => { const workspace = await workspaceRegistry.create(f.root); return { path: workspace.path, workspaceId: workspace.id }; } });
  f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'loopback' }) } as typeof f.ctx.agentDefaultModel);
  f.ctx.provide('agentPresets', { register: vi.fn(() => async () => { sequence.push('preset-dispose'); }), mount: vi.fn(async () => {}) } as unknown as typeof f.ctx.agentPresets);
  const create = vi.fn(async ({ sessionId, meta }: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string } }) => {
    const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, ...meta });
    let activity = Promise.resolve();
    const agent = { id: sessionId, session, ctx: f.ctx, inbox: { nextTurn: [], nextStep: [] }, whenIdle: vi.fn(() => activity),
      followup: vi.fn((message: import('@deepseek-ai/dsh-llm').UserMessage) => {
        // Native lifecycle service double; real turn/blank/model behavior is verified by groups-workspace-profile.
        activity = (async () => {
          const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1;
          if (verifyRoot && message.source.kind === 'dsh-bot-group-setup')
            session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] });
          session.append('turn/start', { turn });
          try {
            if (meta?.agentPreset !== GROUP_ROOT_PRESET) {
              session.append('user/message', message, { surfaceOp: 'append' });
              session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
                source: { provider: 'synthetic', model: 'loopback' }, content: [{ type: 'text', text: 'PROACTIVE_RESULT' }],
              }) }, { surfaceOp: 'append' });
            } else expect(await executeRootSetup(agent, [message], turn)).toBe(true);
            session.append('turn/end', { turn, reason: { kind: 'completed' } });
          } catch { session.append('turn/end', { turn, reason: { kind: 'blocked' } }); }
        })();
        void activity.catch(() => {});
      }),
    } as unknown as Agent;
    const h = { agent, dispose: vi.fn(async () => { sequence.push('root-dispose'); roots.delete(sessionId); }) }; roots.set(sessionId, h); persisted.set(sessionId, h); return h;
  });
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => { const h = persisted.get(resumeSessionId); if (!h || roots.has(resumeSessionId)) throw new Error('ownership'); roots.set(resumeSessionId, h); return h; });
  // Child agents are only Session holders here: the runner reads their native turn/end failure.
  const children = new Map<string, Agent>();
  f.ctx.provide('agents', { get: (id: string) => roots.get(id)?.agent ?? children.get(id), create, resume } as unknown as typeof f.ctx.agents);
  const flush = vi.fn(async () => true); f.ctx.provide('sessions', { flush, get: (id: string) => roots.get(id)?.agent.session } as unknown as typeof f.ctx.sessions);
  const rename = vi.fn(async ({ title }: { title: string }) => ({ title, renamed: true }));
  f.ctx.provide('sessionController', { rename, projections: async () => ({ kind: 'sequenced', values: { agentPreset: GROUP_ROOT_PRESET } }) } as unknown as typeof f.ctx.sessionController);
  if (verifyRoot) f.ctx.provide('sessionPersistence', {
    stat: async (id: string) => { const header = persisted.get(id)?.agent.session.header; return header && { header }; },
    open: async (id: string) => ({ read: async (offset: number, count: number) => ({
      events: persisted.get(id)?.agent.session.snapshotEvents().slice(offset, offset + count) ?? [],
    }), close: async () => {} }),
  } as unknown as typeof f.ctx.sessionPersistence);
  let behavior: 'success' | 'hold' | 'partial' | 'throw' | 'quota' | 'quota-empty' = 'success';
  const calls: { preset: string; prompt: string; signal: AbortSignal }[] = [];
  const start = vi.fn(async (input: { childId?: SessionId; signal: AbortSignal; request: { parent: Agent; agentPreset: string; prompt: { text: string }[] } }) => {
    if (behavior === 'throw') throw new Error('sensitive-native-error');
    calls.push({ preset: input.request.agentPreset, prompt: input.request.prompt[0]?.text ?? '', signal: input.signal });
    let finish!: (r: SubagentResult) => void;
    const result = new Promise<SubagentResult>(r => { finish = r; });
    if (behavior === 'quota' || behavior === 'quota-empty') {
      // The runner reserves the native child id before startActivation.
      const childId = input.childId ?? `child-${calls.length}` as SessionId;
      const session = Session.create(childId, undefined, { version: 4, id: childId, createdAt: Date.now(), isSeeded: false });
      session.append('turn/start', { turn: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'Insufficient Balance (request_id: r-1)', code: 'QUOTA', status: 402 } } });
      children.set(childId, { id: childId, session } as unknown as Agent);
      finish({ output: behavior === 'quota' ? [{ type: 'text', text: 'checked 4 files, continuing:' }] : [], stopReason: 'error' });
      return { childId, result, dispose: vi.fn(async () => { sequence.push('child-dispose'); }) };
    } else if (behavior !== 'hold') finish({ output: [{ type: 'text', text: `reply-${calls.length}` }], stopReason: behavior === 'partial' ? 'max-tokens' : 'completed' });
    return { childId: `child-${calls.length}`, result, dispose: vi.fn(async () => { sequence.push('child-dispose'); finish({ output: [], stopReason: 'aborted' }); }) };
  });
  f.ctx.provide('subagents', { drainDescendants: async () => {}, getProvider: () => ({ inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true, depthLimit: true } }), startActivation: start } as unknown as typeof f.ctx.subagents);
  let domain = await f.ctx.storageDomain.open(groupsDomain); let groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start();
  const createGroup = (op = 'create-1') => groups.create({ operationId: op, name: 'Same name', members: [alpha, beta], mode: 'mention', historyConfirmed: true });
  const settle = async (g: GroupRecord) => { await vi.waitFor(async () => expect((await groups.view(groupKey(g))).turns.every(t => !['running', 'accepted'].includes(t.state))).toBe(true)); return groups.view(groupKey(g)); };
  return { get groups() { return groups; }, get domain() { return domain; }, createGroup, settle, calls, create, resume, flush, rename, roots, workspaces, archiveSession, archivedSessionIds, sequence, start, setBehavior(b: typeof behavior) { behavior = b; },
    async seedUncertain(turnId: string) {
      const t = domain.table('turns').get(turnId); if (!t) throw new Error();
      await domain.table('turns').put(t.id,{...t,state:'running'});
      for (const [id,d] of domain.table('deliveries').entries()) if (d.turnId === turnId) await domain.table('deliveries').put(id,{...d,state:'running'});
    },
    async reopen() { await groups.close(); domain = await f.ctx.storageDomain.open(groupsDomain); groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start(); }, close: () => groups.close() };
}
it('deletes only the confirmed group generation and keeps native history and independent Bot identity', () => withIntegrations(async f => {
  const s = await fixture(f, true);
  try {
    const g = await s.createGroup();
    const other = await s.createGroup('other');
    const key = groupKey(g);
    const view = await s.groups.view(key);
    const turn = await s.groups.send(key, { operationId: 'reply', text: 'reply', expectedMembershipRevision: 1, memberIds: [view.members[0]!.id] });
    await s.groups.waitForTurn(turn.id);
    const current = (await s.groups.view(key)).group;
    const originalBots = structuredClone([...f.bots.values()]);
    const deliveries = (await s.groups.view(key)).deliveries;
    expect(deliveries.length).toBeGreaterThan(0);
    const archived = await s.groups.archive(key, current.revision);
    await expect(s.groups.deleteGroup(key, current.revision)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(s.groups.deleteGroup({ ...key, groupCreatedAt: 1 }, archived.revision)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(s.groups.deleteGroup(key, archived.revision)).resolves.toBe(true);
    expect(s.archivedSessionIds).toEqual([g.rootSessionId]);
    expect([...f.bots.values()]).toEqual(originalBots);
    expect(s.domain.table('turns').get(turn.id)).toBeUndefined();
    for (const delivery of deliveries) expect(s.domain.table('deliveries').get(delivery.id)).toBeUndefined();
    expect([...s.domain.table('members').entries()].map(([, row]) => row.group)).toEqual([groupKey(other), groupKey(other)]);
    await s.reopen();
    expect((await s.groups.list()).map(row => row.group.id)).toEqual([other.id]);
    await expect(s.groups.deleteGroup(key, archived.revision)).resolves.toBe(true);
    await expect(s.createGroup()).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(s.groups.open(key)).rejects.toMatchObject({ code: 'dsh-bot/not-found' });
    await expect(s.groups.view(key)).rejects.toMatchObject({ code: 'dsh-bot/not-found' });
    expect((await s.groups.view(groupKey(other))).members).toHaveLength(2);
  } finally { await s.close(); }
}));

it('refuses active work, protected work and a root belonging to another group before any removal', () => withIntegrations(async f => {
  const s = await fixture(f, true);
  try {
    const g = await s.createGroup();
    const other = await s.createGroup('other');
    const key = groupKey(g);
    const table = s.domain.table('groups');
    await table.put(g.id, { ...g, supergroup: { workId: 'work', originSessionId: 'origin', originMessageId: 'original', owner: alpha, readers: [alpha], expiresAt: Date.now() + 60_000 } });
    await expect(s.groups.deleteGroup(key, g.revision)).rejects.toMatchObject({ code: 'dsh-bot/unsupported' });
    await table.put(g.id, { ...g, rootSessionId: other.rootSessionId });
    await expect(s.groups.deleteGroup(key, g.revision)).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
    await table.put(g.id, g);
    s.setBehavior('hold');
    const member = (await s.groups.view(key)).members[0]!;
    await s.groups.send(key, { operationId: 'active', text: 'hello', expectedMembershipRevision: 1, memberIds: [member.id] });
    await vi.waitFor(() => expect(s.start).toHaveBeenCalled());
    const current = (await s.groups.view(key)).group;
    await expect(s.groups.deleteGroup(key, current.revision)).rejects.toMatchObject({ code: 'dsh-bot/busy' });
    expect(s.archiveSession).not.toHaveBeenCalled();
    expect(s.domain.table('deletions').size).toBe(0);
  } finally { await s.close(); }
}));

it('resumes a partial deletion without recreating the group and leaves an uncommitted native archive untouched', () => withIntegrations(async f => {
  const s = await fixture(f, true);
  try {
    const g = await s.createGroup();
    const other = await s.createGroup('other');
    const receipt = (group: GroupRecord) => ({ group: groupKey(group), rootSessionId: group.rootSessionId, revision: group.revision, complete: false });
    await s.archiveSession(g.rootSessionId as SessionId);
    await s.domain.table('deletions').put(g.id, receipt(g));
    await s.domain.table('deletions').put(other.id, receipt(other));
    await s.reopen();
    expect(s.domain.table('deletions').get(g.id)?.complete).toBe(true);
    expect(s.domain.table('deletions').get(other.id)).toBeUndefined();
    expect((await s.groups.list()).map(row => row.group.id)).toEqual([other.id]);
    expect((await s.groups.view(groupKey(other))).members).toHaveLength(2);
  } finally { await s.close(); }
}));

it('rejects an orphaned foreign root by its original native setup and recovers after native archive admission refuses', () => withIntegrations(async f => {
  const s = await fixture(f, true);
  try {
    const g = await s.createGroup();
    const key = groupKey(g);
    s.archiveSession.mockRejectedValueOnce(Object.assign(new Error(), { name: 'WorkspaceActiveSessionError' }));
    await expect(s.groups.deleteGroup(key, g.revision)).rejects.toMatchObject({ code: 'dsh-bot/busy' });
    expect(s.domain.table('deletions').get(g.id)).toBeUndefined();
    expect((await s.groups.view(key)).members).toHaveLength(2);
    const archived = await s.groups.archive(key, g.revision);
    const other = await s.createGroup('orphan');
    await s.groups.archive(groupKey(other), other.revision);
    const table = s.domain.table('groups');
    await table.delete(other.id);
    await table.put(g.id, { ...archived, rootSessionId: other.rootSessionId });
    await expect(s.groups.deleteGroup(key, archived.revision)).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
    expect(s.archiveSession).toHaveBeenCalledTimes(1);
    expect(s.archivedSessionIds).toEqual([]);
    expect(table.get(g.id)?.archived).toBe(true);
  } finally { await s.close(); }
}));

it('persists exact group export settings across restart and explicitly disables without changing membership or history', async () => {
  await withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const g = await s.createGroup(), key = groupKey(g);
      const before = await s.groups.view(key);
      const settings = await s.groups.exportSettings.get(key);
      expect(settings.readers.map(row => row.bot)).toEqual([alpha, beta]);
      expect(settings.canEnable).toBe(true);
      const enabled = await s.groups.exportSettings.set(key, alpha, true, settings.groupRevision, settings.membershipRevision);
      expect(enabled.membershipRevision).toBe(g.membershipRevision);
      await s.reopen();
      const restored = await s.groups.exportSettings.get(key);
      expect(restored.enabledBots).toEqual([alpha]);
      await s.groups.exportSettings.set(key, alpha, false, restored.groupRevision, restored.membershipRevision);
      await s.reopen();
      expect((await s.groups.exportSettings.get(key)).enabledBots).toEqual([]);
      const after = await s.groups.view(key);
      expect(after.members).toEqual(before.members);
      expect(after.turns).toEqual(before.turns);
      expect(after.messages).toEqual(before.messages);
      expect(s.calls).toHaveLength(0);
    } finally { await s.close(); }
  });
});
it('closes only same-group obsolete review work once and persists receipts outside group history', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const outsider = { ...need(f.bots.get('alpha')), id: 'outsider', name: 'outsider' };
    f.bots.set(outsider.id, outsider);
    const original = await s.createGroup();
    const other = await s.createGroup('other');
    const key = groupKey(original);
    const groupView = (group: GroupRecord) => s.groups.view(groupKey(group));
    const send = async (group: GroupRecord, operationId: string) => {
      const view = await groupView(group);
      const turn = await s.groups.send(groupKey(group), { operationId, text: operationId,
        expectedMembershipRevision: group.membershipRevision, memberIds: view.members.filter(member => member.enabled).map(member => member.id) });
      return (await s.settle(group)).deliveries.filter(delivery => delivery.turnId === turn.id);
    };
    const edit = async (group: GroupRecord) => {
      const { group: live } = await groupView(group);
      return s.groups.edit(groupKey(live), { expectedRevision: live.revision,
        expectedMembershipRevision: live.membershipRevision, name: live.name, mode: live.mode, historyConfirmed: true,
        members: [alpha, { botId: outsider.id, botCreatedAt: outsider.createdAt }] });
    };
    const sent = need((await send(original, 'already-sent'))[0]);
    s.setBehavior('throw');
    const stale = await send(original, 'old-review');
    const held = need(stale[0]), legacy = need(stale[1]);
    const otherHeld = need((await send(other, 'other-review'))[0]);
    const table = s.domain.table('deliveries');
    const hold = (delivery: typeof sent) => table.put(delivery.id, { ...delivery, state: 'failed',
      reasonCode: 'export-approval-required', exportFlowId: crypto.randomUUID() });
    await hold(held);
    await table.put(legacy.id, { ...legacy, state: 'unknown', reasonCode: 'native-failure', exportFlowId: undefined });
    await hold(otherHeld);
    await hold(sent); // A persisted output receipt still excludes it from review work.
    const group = await edit(original);
    const changedOther = await edit(other);
    const current = need((await send(group, 'current-review'))[0]);
    await hold(current);
    const before = await groupView(group);
    const originalRows = [...table.entries()];
    const oldTurn = (delivery: typeof sent) => before.turns.find(turn => turn.id === delivery.turnId);
    expect(groupExportReviewStatus(group, oldTurn(held), need(table.get(held.id)))).toBe('stale');
    expect(groupExportReviewStatus(group, oldTurn(current), need(table.get(current.id)))).toBe('pending');
    expect(groupExportReviewStatus(group, oldTurn(sent), need(table.get(sent.id)))).toBeUndefined();

    const review = s.groups.exportReview;
    await expect(review.closeStale(key, original.membershipRevision)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(review.closeStale({ ...key, groupCreatedAt: key.groupCreatedAt + 1 }, group.membershipRevision))
      .rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(review.closeStale(key, group.membershipRevision, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const rev = group.membershipRevision;
    await expect(Promise.all([review.closeStale(key, rev), review.closeStale(key, rev)])).resolves.toEqual([{ closed: 2 }, { closed: 0 }]);
    await expect(review.review(key, legacy.id)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(review.decide(key, held.id, '0'.repeat(64), true)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(review.discard(key, held.id, need(held.revision))).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    expect([...table.entries()]).toEqual(originalRows);

    const assertView = async () => {
      const view = groupViewSchema.parse(await groupView(group));
      expect(view.group).toEqual(before.group);
      expect(view.turns).toEqual(before.turns);
      expect(view.messages).toEqual(before.messages);
      expect(view.deliveries.filter(delivery => delivery.staleExportClosedAt !== undefined).map(delivery => delivery.id))
        .toEqual([held.id, legacy.id]);
      expect((await groupView(changedOther)).deliveries.every(delivery => delivery.staleExportClosedAt === undefined)).toBe(true);
    };
    await assertView();
    await s.reopen();
    await assertView();
    expect([...s.domain.table('deliveries').entries()]).toEqual(originalRows);
    expect(originalRows.every(([, row]) => groupDeliverySchema.safeParse(row).success)).toBe(true);
    await expect(s.groups.exportReview.closeStale(key, rev)).resolves.toEqual({ closed: 0 });
  } finally { await s.close(); }
}));
it('clears exact proactive group input and result copies while preserving the native root and ordinary flows', async () => {
  const x = await flowFixture();
  try {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        Object.assign(f.registry, x.registry());
        const group = await s.createGroup();
        const key = groupKey(group);
        const root = s.roots.get(group.rootSessionId)?.agent.session;
        const member = (await s.groups.view(key)).members[0];
        if (!root || !member) throw new Error('Missing group fixture');
        const assignmentId = 'proactive-assignment', ticketId = 'proactive-ticket';
        const turnId = 'turn:proactive', deliveryId = `${turnId}:0`, childId = 'native-child';
        const text = 'SCOPED_PROACTIVE_GROUP_BODY';
        const message = createUserMessage({
          source: { kind: 'dsh-bot-group-proactive', group: key, turnId, ticketId, assignmentId },
          content: [{ type: 'text', text }],
        });
        const at = Date.now();
        await s.domain.table('turns').put(turnId, {
          id: turnId, group: key, operationId: 'scope-operation', requestDigest: 'fixture',
          inputMessageId: message.id, createdAt: at, updatedAt: at, revision: 1, schemaVersion: 1,
          membershipRevision: group.membershipRevision, orderedMemberIds: [member.id],
          mode: 'round-robin', contextThroughSeq: -1, state: 'completed',
          proactive: { ticketId, assignmentId, provider: 'fixture', model: 'fixture', botRevisions: [1] },
        });
        await s.domain.table('deliveries').put(deliveryId, {
          id: deliveryId, turnId, memberId: member.id, ordinal: 0, bot: alpha, botRevision: 1, presetId: 'bot-alpha',
          contextOutputMessageIds: [], contextTruncated: false, state: 'completed', childSessionId: childId,
        });
        const label = { readers: [alpha], originTrust: 'candidate' as const, sourceVersions: [], restrictions: [], grants: [] };
        await x.flow.inherit(group.rootSessionId, label);
        await x.flow.inherit(childId, label);
        const target = { kind: 'bot' as const, bot: alpha };
        const input = await x.flow.admit(x.flow.draft('group-input', alpha, group.rootSessionId, turnId, target, JSON.stringify(message)));
        await x.flow.dispatch(input, () => root.append('user/message', message, { surfaceOp: 'append' }));
        const child = await x.flow.admit(x.flow.draft('group-input', alpha, group.rootSessionId, deliveryId, target, text));
        const result = await x.flow.admit(x.flow.draft('group-result', alpha, childId, `${deliveryId}:result`, target, text));
        const ordinary = await x.flow.admit(x.flow.draft('group-input', alpha, group.rootSessionId, 'turn:ordinary', target, 'ordinary group body'));

        const delivery = s.domain.table('deliveries').get(deliveryId);
        if (!delivery) throw new Error('Missing delivery fixture');
        await s.domain.table('deliveries').put(deliveryId, { ...delivery, state: 'unknown' });
        expect(await s.groups.purgeProactiveCopies([assignmentId])).toBe(false);
        expect(x.flow.get(input).envelope?.content).toContain(text);
        await s.domain.table('deliveries').put(deliveryId, delivery);

        const native = root.snapshotEvents();
        expect(await s.groups.purgeProactiveCopies([assignmentId])).toBe(true);
        for (const id of [input, child, result]) {
          const row = x.flow.get(id);
          expect(row.envelope).toBeUndefined();
          expect(row.envelopeDigest).toMatch(/^[a-f0-9]{64}$/);
        }
        expect(await s.groups.purgeProactiveCopies([assignmentId])).toBe(true);
        expect(x.flow.get(ordinary).envelope?.content).toBe('ordinary group body');
        expect(root.snapshotEvents()).toEqual(native);
        expect(JSON.stringify(native)).toContain(text);

        const orphanTurn = 'turn:orphan', orphanAssignment = 'orphan-assignment';
        const orphan = await x.flow.admit(x.flow.draft('group-input', alpha, group.rootSessionId, orphanTurn, target, JSON.stringify(createUserMessage({
          source: { kind: 'dsh-bot-group-proactive', group: key, turnId: orphanTurn, ticketId, assignmentId: orphanAssignment },
          content: [{ type: 'text', text }],
        }))));
        expect(await s.groups.purgeProactiveCopies([orphanAssignment])).toBe(false);
        expect(x.flow.get(orphan).envelope?.content).toContain(text);
      } finally { await s.close(); }
    });
  } finally { await x.close(); }
});
describe('U06/U07 native-boundary fixtures with real JSON sidecars', () => {
  it('enforces the full roster ceiling on direct create and keeps a smaller owner limit', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      for (const id of ['gamma', 'delta', 'epsilon', 'zeta', 'eta']) f.bots.set(id, { ...need(f.bots.get('alpha')), id, name: id });
      const members = [...f.bots.values()].map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt }));
      // Defense in depth: even a caller retaining a raw historical Config cannot raise the hard ceiling.
      f.registry.config.groupMaxMembers = 16;
      const six = await s.groups.create({ operationId: 'six', name: 'Six Bots', members: members.slice(0, 6), mode: 'mention', historyConfirmed: true });
      const fullView = await s.groups.view(groupKey(six));
      expect(fullView.members).toHaveLength(6);
      expect(fullView.memberLimit).toBe(6);
      const before = s.create.mock.calls.length;
      await expect(s.groups.create({ operationId: 'seven', name: 'Seven Bots', members, mode: 'mention', historyConfirmed: true }))
        .rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      expect(s.create).toHaveBeenCalledTimes(before);
      f.registry.config.groupMaxMembers = 3;
      expect((await s.groups.view(groupKey(six))).memberLimit).toBe(3);
      await expect(s.groups.create({ operationId: 'four', name: 'Four Bots', members: members.slice(0, 4), mode: 'mention', historyConfirmed: true }))
        .rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
    } finally { await s.close(); }
  }));
  it('reopens all legacy members intact, blocks new work even for one selected Bot, and permits only staged subset reductions', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      for (const id of ['gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'outsider']) f.bots.set(id, { ...need(f.bots.get('alpha')), id, name: id });
      const original = await s.createGroup('legacy-eight'), key = groupKey(original);
      const initialTurn = await s.groups.send(key, { operationId: 'before-upgrade', expectedMembershipRevision: 1, text: 'Existing work', memberIds: [], round: true });
      await s.settle(original);
      const botKeys = [...f.bots.values()].filter(bot => bot.id !== 'outsider').map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt }));
      for (const [index, bot] of botKeys.slice(2).entries()) await s.domain.table('members').put(`legacy-${index}`, {
        id: `legacy-${index}`, group: key, bot, order: index + 2, joinedAt: 1, enabled: index !== 0,
      });
      await s.reopen();
      let view = await s.groups.view(key);
      expect(view.members.filter(member => member.removedAt === undefined)).toHaveLength(8);
      expect(view.members.filter(member => member.removedAt === undefined && !member.enabled)).toHaveLength(1);
      const snapshot = [...s.domain.table('members').entries()];
      await expect(s.groups.send(key, { operationId: 'over-roster', expectedMembershipRevision: 1, text: '@alpha one Bot only', memberIds: [need(view.members[0]).id] }))
        .rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      expect([...s.domain.table('members').entries()]).toEqual(snapshot);
      const paused = need(s.domain.table('turns').get(initialTurn.id));
      await s.domain.table('turns').put(paused.id, { ...paused, protocol: 2, state: 'paused' });
      await expect(s.groups.continueTurn(key, paused.id, paused.revision)).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      const edit = (members: typeof botKeys) => s.groups.edit(key, { expectedRevision: view.group.revision,
        expectedMembershipRevision: view.group.membershipRevision, name: view.group.name, mode: view.group.mode, historyConfirmed: true, members });
      await expect(edit(botKeys)).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      await expect(edit([...botKeys.slice(0, 5), { botId: 'outsider', botCreatedAt: 1 }])).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      await edit(botKeys.slice(0, 7));
      view = await s.groups.view(key);
      expect(view.members.filter(member => member.removedAt === undefined)).toHaveLength(7);
      await expect(edit([...botKeys.slice(0, 6), { botId: 'outsider', botCreatedAt: 1 }])).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      await edit(botKeys.slice(0, 6));
      view = await s.groups.view(key);
      expect(view.members.filter(member => member.removedAt === undefined)).toHaveLength(6);
      expect(view.members).toHaveLength(8);
      await expect(edit(botKeys.slice(0, 7))).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      const turn = await s.groups.send(key, { operationId: 'after-reduction', expectedMembershipRevision: view.group.membershipRevision, text: 'One Bot after reduction', memberIds: [need(view.members[0]).id] });
      expect(turn.orderedMemberIds).toHaveLength(1);
      await s.settle(view.group);
    } finally { await s.close(); }
  }));
  it('retains legacy oversized recipes for reading but rejects importing, previewing or applying a seventh role', () => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const group = await s.createGroup('recipe-ceiling'), key = groupKey(group);
      const recipe = await s.groups.teamRecipes.capture(key, 'Recipe');
      const base = need(recipe.roles[0]);
      const legacy = { ...recipe, roles: Array.from({ length: 7 }, (_, index) => ({ ...base, id: `role-${index}` })) };
      await s.domain.table('team_recipes').put('legacy-recipe', { id: 'legacy-recipe', savedAt: 1, recipe: legacy });
      await s.reopen();
      expect(need((await s.groups.teamRecipes.list())[0]).recipe.roles).toHaveLength(7);
      await expect(s.groups.teamRecipes.save(legacy)).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      await expect(s.groups.teamRecipes.preview(legacy)).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      await expect(s.groups.teamRecipes.apply(key, legacy, [], group.revision, group.membershipRevision)).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
      expect((await s.groups.view(key)).members).toHaveLength(2);
      expect(need((await s.groups.teamRecipes.list())[0]).recipe.roles).toHaveLength(7);
    } finally { await s.close(); }
  }));
  it('binds follow-up only to the exact human group input of a live owned worker', () => withIntegrations(async f => {
    const s = await fixture(f);
    let worker: Agent | undefined;
    let startupFailure: unknown;
    try {
      const group = await s.createGroup();
      const key = groupKey(group);
      const member = (await s.groups.view(key)).members[0];
      const root = s.roots.get(group.rootSessionId)?.agent.session;
      if (!member || !root) throw new Error('Missing group fixture');
      s.start.mockImplementationOnce(async input => {
        const childId = input.childId;
        if (!childId) throw new Error('Missing reserved child');
        const session = Session.create(childId, undefined, { version: 4, id: childId, createdAt: Date.now(),
          isSeeded: false, origin: 'subagent', parentSession: input.request.parent.session.id, agentPreset: input.request.agentPreset });
        const { agent, scope, value } = f.createAgent(childId);
        value.session = session;
        try { await f.ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' }); }
        catch (error) { startupFailure = error; await scope.dispose(); throw error; }
        worker = agent;
        let finish!: (value: SubagentResult) => void;
        const result = new Promise<SubagentResult>(resolve => { finish = resolve; });
        return { childId, result, dispose: vi.fn(async () => {
          finish({ output: [], stopReason: 'aborted' });
          await scope.dispose();
        }) };
      });
      const accepted = await s.groups.send(key, { operationId: 'follow-up-source', text: 'User-authorized question',
        memberIds: [member.id], expectedMembershipRevision: group.membershipRevision });
      await vi.waitFor(async () => {
        if (startupFailure) throw startupFailure;
        expect(worker).toBeDefined();
        if (worker) expect(await s.groups.followUpWorker(worker)).toMatchObject({ subject: { kind: 'group', group: key },
          sessionId: root.id, messageId: accepted.inputMessageId });
      });
      if (!worker) throw new Error('Missing worker');
      const turn = s.domain.table('turns').get(accepted.id);
      if (!turn) throw new Error('Missing durable turn');
      await s.domain.table('turns').put(turn.id, { ...turn, inputSeq: Number(turn.inputSeq) + 1 });
      expect(await s.groups.followUpWorker(worker)).toBeUndefined();
      const forwarded = root.append('user/message', createUserMessage({
        source: { kind: 'dsh-bot-group-followup', group: key, turnId: turn.id, deliveryId: 'relay', replyTo: turn.inputMessageId },
        content: [{ type: 'text', text: 'Group relay' }],
      }), { surfaceOp: 'append' });
      await s.domain.table('turns').put(turn.id, { ...turn, inputSeq: Number(forwarded.seq), inputMessageId: forwarded.data.id });
      expect(await s.groups.followUpWorker(worker)).toBeUndefined();
      await s.domain.table('turns').put(turn.id, turn);
      await s.domain.table('members').put(member.id, { ...member, enabled: false });
      expect(await s.groups.followUpWorker(worker)).toBeUndefined();
      await s.domain.table('members').put(member.id, member);
      const bot = f.bots.get(member.bot.botId);
      if (!bot) throw new Error('Missing current Bot');
      f.bots.set(bot.id, { ...bot, updatedAt: bot.updatedAt + 1 });
      expect(await s.groups.followUpWorker(worker)).toBeUndefined();
      f.bots.set(bot.id, bot);
      await s.groups.archive(key, group.revision);
      expect(await s.groups.followUpWorker(worker)).toBeUndefined();
    } finally { await s.close(); }
  }));
  it('deduplicates create before native side effects and enforces birthday/CAS/member identity', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const [g, again] = await Promise.all([s.createGroup(), s.createGroup()]); expect(g.id).toBe(again.id); expect(s.create).toHaveBeenCalledTimes(1);
      await expect(s.groups.create({ operationId: 'create-1', name: 'changed', mode: 'mention', members: [alpha,beta], historyConfirmed: true })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      await expect(s.groups.create({ operationId: 'bad', name: 'bad', mode: 'mention', members: [alpha,{ ...beta, botCreatedAt: 2 }], historyConfirmed: true })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      const edit = { name: 'Renamed', members: [beta,alpha], mode: 'round-robin', expectedRevision: 1, expectedMembershipRevision: 1, historyConfirmed: true };
      const changed = await s.groups.edit(groupKey(g), edit); expect(changed.membershipRevision).toBe(1); await expect(s.groups.edit(groupKey(g), edit)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      expect(s.rename).toHaveBeenCalledWith({ sessionId: g.rootSessionId, title: 'Renamed' });
      expect((await s.groups.view(groupKey(g))).members.filter(m => m.enabled).map(m => m.bot.botId)).toEqual(['beta','alpha']);
    } finally { await s.close(); }
  }));
  it('uses each preset in deterministic order, forwards actual output, persists context IDs and deduplicates sends', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const members = (await s.groups.view(groupKey(g))).members;
      const input = { operationId: 'send-1', text: 'question', memberIds: members.map(m => m.id).reverse(), expectedMembershipRevision: 1 };
      const t = await s.groups.send(groupKey(g), input); const repeated = await s.groups.send(groupKey(g), input); expect(repeated.id).toBe(t.id);
      const v = await s.settle(g); expect(s.calls.map(c => c.preset)).toEqual(['bot-alpha','bot-beta']);
      expect(v.messages.map(m => m.text)).toEqual(['question','reply-1','reply-2']); expect(v.deliveries.map(d => d.state)).toEqual(['completed','completed']);
      expect(v.deliveries[1]?.contextOutputMessageIds).toEqual([]); expect(s.calls[1]?.prompt).not.toContain('reply-1');
      expect(s.roots.get(g.rootSessionId)?.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).toEqual([]);
      await expect(s.groups.send(groupKey(g), { ...input, text: 'changed' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      const seq = v.messages.at(-1)?.seq; if (seq === undefined) throw new Error();
      expect(v.unread).toBe(true); await s.groups.markRead(groupKey(g),seq,0);
      await expect(s.groups.markRead(groupKey(g),seq,0)).rejects.toMatchObject({code:'dsh-bot/conflict'});
      await s.reopen(); const cold = await s.groups.view(groupKey(g)); expect(cold.unread).toBe(false); expect(cold.messages).toEqual(v.messages); expect(s.create).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }));
  it('rejects unknown and text-only mentions; duplicate names and a new birthday do not route by display name', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const members = (await s.groups.view(groupKey(g))).members;
      for (const memberIds of [[], ['unknown'], [members[0]?.id, members[0]?.id]]) await expect(s.groups.send(groupKey(g), { operationId: `bad-${JSON.stringify(memberIds)}`, text: '@Same name', memberIds, expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      const b = f.bots.get('beta'); if (!b) throw new Error(); f.bots.set('beta', { ...b, createdAt: 2 });
      await expect(s.groups.send(groupKey(g), { operationId: 'bad-birthday', text: 'q', memberIds: [members[1]?.id], expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'dsh-bot/conflict' }); expect(s.start).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }));
  it('cancels an active member and pending targets, preserves queued input cutoff and drains child before root/preset', () => withIntegrations(async f => {
    const s = await fixture(f); f.registry.config.groupConcurrentMembers = 1; try {
      const g = await s.createGroup(); s.setBehavior('hold'); const members = (await s.groups.view(groupKey(g))).members;
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: members.map(m => m.id), expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const queued = await s.groups.send(groupKey(g), { operationId: 'two', text: 'future-secret-question', memberIds: [members[1]?.id], expectedMembershipRevision: 1 });
      expect(s.calls[0]?.prompt).not.toContain('future-secret-question');
      const v = await s.groups.view(groupKey(g)), active = v.turns.find(t => t.operationId === 'one'); if (!active) throw new Error();
      await s.groups.cancel(groupKey(g), active.id, active.revision); await s.groups.cancel(groupKey(g), queued.id, (await s.groups.view(groupKey(g))).turns.find(t => t.id === queued.id)?.revision ?? 0);
      const final = await s.settle(g); expect(final.turns.every(t => t.state === 'cancelled')).toBe(true); expect(s.calls).toHaveLength(1);
      await s.close(); expect(s.sequence.indexOf('child-dispose')).toBeLessThan(s.sequence.indexOf('root-dispose')); expect(s.sequence.indexOf('root-dispose')).toBeLessThan(s.sequence.indexOf('preset-dispose'));
    } finally { await s.close(); }
  }));
  it('removing a member aborts its running delivery and never expands the admitted snapshot', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior('hold'); const members = (await s.groups.view(groupKey(g))).members;
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [members[0]?.id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const alphaBot = f.bots.get('alpha'); if (!alphaBot) throw new Error(); f.bots.set('gamma', { ...alphaBot, id: 'gamma', name: 'Gamma' });
      await s.groups.edit(groupKey(g), { name: g.name, mode: 'mention', members: [beta, { botId: 'gamma', botCreatedAt: 1 }], expectedRevision: 1, expectedMembershipRevision: 1, historyConfirmed: true });
      await s.settle(g); expect(s.calls[0]?.signal.aborted).toBe(true); expect(s.calls).toHaveLength(1);
    } finally { await s.close(); }
  }));
  it.each(['partial','throw'] as const)('does not classify %s as success or advance round pointer', behavior => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior(behavior); const m = (await s.groups.view(groupKey(g))).members[0];
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 });
      const v = await s.settle(g); expect(v.turns[0]?.state).toBe(behavior === 'throw' ? 'recovery_needed' : 'partial'); expect(v.deliveries[0]?.state).toBe(behavior === 'throw' ? 'unknown' : 'failed'); expect(v.group.nextMemberId).toBe(g.nextMemberId); expect(JSON.stringify(v)).not.toContain('sensitive-native-error');
    } finally { await s.close(); }
  }));
  it.each(['quota', 'quota-empty'] as const)('keeps the native model failure of a %s member run', behavior => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior(behavior); const m = (await s.groups.view(groupKey(g))).members[0];
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 });
      const v = await s.settle(g), failure = { code: 'QUOTA', status: 402, requestId: 'r-1', message: 'Insufficient Balance (request_id: r-1)' };
      expect(v.deliveries[0]).toMatchObject({ state: 'failed', stopReason: 'error', failure });
      const replies = v.messages.filter(message => message.authorKind === 'bot');
      if (behavior === 'quota') expect(replies).toEqual([expect.objectContaining({ text: 'checked 4 files, continuing:', stopReason: 'error', failure })]);
      else { expect(replies).toEqual([]); expect(v.deliveries[0]?.outputMessageId).toBeUndefined(); }
    } finally { await s.close(); }
  }));
  it.each(['partial', 'throw', 'hold'] as const)('round-robin %s keeps the pointer until a successful persisted reply', behavior => withIntegrations(async f => {
    const s = await fixture(f);
    try {
      const initial = await s.createGroup();
      const g = await s.groups.edit(groupKey(initial), { name: initial.name, mode: 'round-robin', members: [alpha, beta], expectedRevision: initial.revision, expectedMembershipRevision: 1, historyConfirmed: true });
      s.setBehavior(behavior);
      const input = { operationId: 'round-fail', text: 'question', expectedMembershipRevision: g.membershipRevision };
      await s.groups.send(groupKey(g), input);
      if (behavior === 'hold') {
        await vi.waitFor(() => expect(s.calls).toHaveLength(1));
        const turn = (await s.groups.view(groupKey(g))).turns[0];
        if (!turn) throw new Error('Missing turn');
        await s.groups.cancel(groupKey(g), turn.id, turn.revision);
      }
      const failed = await s.settle(g);
      expect(failed.group.nextMemberId).toBe(g.nextMemberId);
      s.setBehavior('success');
      await s.groups.send(groupKey(g), { ...input, operationId: 'round-success' });
      const success = await s.settle(g);
      const turn = success.turns.find(t => t.operationId === 'round-success');
      expect(turn?.orderedMemberIds).toEqual([g.nextMemberId]);
      expect(success.group.nextMemberId).toBe(success.members[1]?.id);
      // Native workers use startActivation; only the independent group root was created.
      expect(s.create).toHaveBeenCalledTimes(1);
      expect(s.start.mock.calls.every(([request]) => request.request.agentPreset === 'bot-alpha')).toBe(true);
    } finally { await s.close(); }
  }));
  it('marks uncertain append/flush recovery-needed and never silently retries after restart', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0]; s.flush.mockResolvedValueOnce(false);
      const input = { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 };
      await expect(s.groups.send(groupKey(g), input)).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      await s.reopen(); const t = await s.groups.send(groupKey(g), input); expect(t.state).toBe('recovery_needed'); expect(s.calls).toHaveLength(0);
    } finally { await s.close(); }
  }));
  it('reconciles persisted running receipts to unknown after restart, without spawning again', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0];
      const input = {operationId:'uncertain',text:'uncertain effect',memberIds:[m?.id],expectedMembershipRevision:1};
      const t = await s.groups.send(groupKey(g),input); await s.settle(g); const calls = s.calls.length;
      await s.seedUncertain(t.id); await s.reopen(); const cold = await s.groups.view(groupKey(g));
      expect(cold.turns[0]?.state).toBe('recovery_needed'); expect(cold.deliveries[0]?.state).toBe('unknown');
      await s.groups.send(groupKey(g),input); expect(s.calls).toHaveLength(calls);
    } finally { await s.close(); }
  }));
  it('drains a running child on unload even when only its disposer settles the result', () => withIntegrations(async f => {
    const s = await fixture(f); const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0]; s.setBehavior('hold');
    await s.groups.send(groupKey(g),{operationId:'close-active',text:'work',memberIds:[m?.id],expectedMembershipRevision:1});
    await vi.waitFor(() => expect(s.calls).toHaveLength(1)); await s.close();
    expect(s.sequence.indexOf('child-dispose')).toBeLessThan(s.sequence.indexOf('root-dispose')); expect(s.groups.lifecycle()).toMatchObject({phase:'closed',ownedRoots:0,workers:0,activations:0});
  }));
  it('times out a held child and rejects new routes after archive', () => withIntegrations(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior('hold'); const m = (await s.groups.view(groupKey(g))).members[0];
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 });
      await vi.waitFor(async () => expect((await s.groups.view(groupKey(g))).turns[0]?.state).toBe('cancelled'), { timeout: 2500 });
      const v = await s.groups.view(groupKey(g)); await s.groups.archive(groupKey(g), v.group.revision);
      await expect(s.groups.send(groupKey(g), { operationId: 'two', text: 'q', memberIds: [m?.id], expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
    } finally { await s.close(); }
  }));
});
describe('group context and strict Remote boundary', () => {
  it('uses complete recent messages within a byte budget and records only included result IDs', () => {
    const msg = (id: string, text: string): GroupMessage => ({ id, text, turnId: 't', seq: 1, at: 0 });
    const q = msg('q','question'); const result = groupContext('g','target',['alpha'],q,[msg('old','长'.repeat(4000))],[msg('a','previous answer')],1024);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024); expect(result.truncated).toBe(true); expect(result.outputIds).toEqual(['a']); expect(result.text).not.toContain('长');
    expect(result.text).toContain('Reply directly to the person who asked');
    expect(result.text).toContain('This group has no implicit lead');
    expect(() => groupContext('g','t',[],msg('q','q'.repeat(10000)),[],[],1024)).toThrow();
  });
  it('bounds turns and routes round robin to a stable next member', () => {
    const g = { mode: 'round-robin', nextMemberId: 'b' } as GroupRecord;
    const members = [{ id: 'a', order: 0, enabled: true },{ id: 'b', order: 1, enabled: true }] as Parameters<typeof routeMembers>[1];
    expect(routeMembers(g,members,[],false,8).map(m => m.id)).toEqual(['b']); expect(() => routeMembers(g,members,[],true,1)).toThrow();
  });
  it('forbids arbitrary parent, preset, Agent and unknown fields through the same codecs', () => {
    for (const extra of [{ agentPreset: 'standard' }, { sessionId: 'private' }, { parent: 'forged' }]) expect(() => groupsSpec.methods['dshBot.groups/send'].parameters[1].codec.decode({ operationId: 'op', text: 't', memberIds: [], expectedMembershipRevision: 1, ...extra })).toThrow();
    expect(GROUP_ROOT_PRESET).toBe('dsh-bot-group-root');
  });
});


describe('strict supplemental send codec', () => {
  it('roundtrips optional target and receipt without relaxing unknown fields', () => {
    const method = groupsSpec.methods['dshBot.groups/send'];
    const input = { operationId: 'precise', expectedMembershipRevision: 1, text: 'more', followup: { turnId: 'turn-1', deliveryId: 'delivery-1' } };
    const decoded = method.parameters[1].codec.decode(input);
    expect(method.parameters[1].strictCodec.decode(method.parameters[1].strictCodec.encode(decoded))).toEqual(decoded);
    expect(() => method.parameters[1].codec.decode({ ...input, followup: { ...input.followup, childSessionId: 'forged' } })).toThrow();
    const result = { id: 'turn-1', group: { groupId: 'g', groupCreatedAt: 1 }, operationId: 'original', requestDigest: 'x', inputMessageId: 'm',
      createdAt: 1, updatedAt: 2, revision: 1, schemaVersion: 1, membershipRevision: 1, orderedMemberIds: [], mode: 'natural', contextThroughSeq: -1, state: 'running',
      followups: [{ operationId: 'precise', requestDigest: 'h', deliveryId: 'delivery-1', messageId: 'group-m', childMessageId: 'native-m', state: 'accepted' }] };
    expect(method.result.decode(method.result.encode(result))).toEqual(result);
  });
});

describe('OpenMaus reusable team preferences and local routing', () => {
  it('roundtrips allowlisted preferences durably, maps capabilities and applies through membership without execution', async () => {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        const group = await s.createGroup(), key = groupKey(group);
        const recipe = await s.groups.teamRecipes.capture(key, 'Reusable team');
        expect(Object.keys(recipe).sort()).toEqual(['format', 'mode', 'name', 'onDemand', 'roles', 'version']);
        expect(JSON.stringify(recipe)).not.toMatch(/persona|memory|credential|cwd|rootSessionId/);
        await expect(s.groups.teamRecipes.save({ ...recipe, history: [] })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
        await expect(s.groups.teamRecipes.save({ ...recipe, version: 2 })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
        const saved = await s.groups.teamRecipes.save(JSON.parse(JSON.stringify(recipe)));
        await s.reopen();
        expect((await s.groups.teamRecipes.list()).map(row => row.id)).toContain(saved.id);
        const preview = await s.groups.teamRecipes.preview({ ...recipe, mode: 'natural', onDemand: true });
        expect(preview.roles.every(row => row.match === 'preferred' && row.capabilityMatch)).toBe(true);
        const suggested = await s.groups.teamRecipes.preview({ ...recipe, roles: recipe.roles.map(row => ({ ...row, preferredBotId: 'missing' })) });
        expect(suggested.roles.every(row => row.match === 'capability' && row.capabilityMatch)).toBe(true);
        const unmapped = await s.groups.teamRecipes.preview({ ...recipe, roles: [...recipe.roles,
          { ...recipe.roles[0], id: 'role-2', role: 'extra', preferredBotId: 'missing', template: 'standard' }] });
        expect(unmapped.roles[2]?.match).toBe('unmapped');
        await expect(s.groups.teamRecipes.preview(recipe, [{ roleId: 'role-0', bot: { ...alpha, botCreatedAt: 99 } }])).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
        const mapping = preview.roles.map(row => ({ roleId: row.roleId, bot: row.bot }));
        const applied = await s.groups.teamRecipes.apply(key, preview.recipe, mapping, group.revision, group.membershipRevision);
        expect(applied.onDemand).toBe(true); expect(applied.memberRoles).toHaveLength(2);
        expect(s.calls).toHaveLength(0);
        await expect(s.groups.teamRecipes.apply(key, recipe, mapping, group.revision, group.membershipRevision)).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
        await expect(s.groups.teamRecipes.apply(key, recipe, [mapping[0], { ...mapping[1], bot: need(mapping[0]).bot }], applied.revision, applied.membershipRevision)).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
        await s.groups.teamRecipes.remove(saved.id);
        expect(await s.groups.teamRecipes.list()).toEqual([]);
      } finally { await s.close(); }
    });
  });
  it('uses legacy routes when disabled or local selection fails, and matches Chinese roles deterministically', async () => {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        const group = await s.groups.create({ operationId: 'local-fallback', name: 'Fallback', members: [alpha, beta],
          mode: 'natural', onDemand: true, memberRoles: [{ bot: alpha, role: '数据库查询' }, { bot: beta, role: '浏览器界面' }], historyConfirmed: true });
        const members = (await s.groups.view(groupKey(group))).members;
        expect(selectOnDemand(group, members, '检查数据库', [], undefined, false, 16).routing.reason).toBe('role-match');
        const failing = new Map<string, string>(); failing.get = () => { throw new Error('unavailable metadata'); };
        expect(selectOnDemand(group, members, 'question', [], undefined, false, 16, failing).routing).toMatchObject({ reason: 'failed', plannedCalls: 2, deciderCalls: 0 });
        expect(selectOnDemand({ ...group, onDemand: false }, members, '数据库', [], undefined, false, 16).selected).toHaveLength(2);
        expect(selectOnDemand(group, members, '数据库', [], members[1]?.id, false, 16).routing.reason).toBe('reply');
        expect(selectOnDemand(group, members, '数据库', [], undefined, true, 16).selected).toHaveLength(2);
        expect(() => selectOnDemand(group, members, 'unknown', [], undefined, false, 1)).toThrow();
      } finally { await s.close(); }
    });
  });
  it('persists deterministic selection, honors explicit targets and falls back without changing budgets', async () => {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        const group = await s.groups.create({ operationId: 'local-speakers', name: 'Local speakers', members: [alpha, beta],
          mode: 'natural', onDemand: true, memberRoles: [{ bot: alpha, role: 'database SQL' }, { bot: beta, role: 'browser CSS' }], historyConfirmed: true });
        const key = groupKey(group), members = (await s.groups.view(key)).members;
        const send = async (operationId: string, text: string, memberIds: string[] = []) => {
          const turn = await s.groups.send(key, { operationId, text, memberIds, expectedMembershipRevision: group.membershipRevision });
          await s.settle(group); return need((await s.groups.view(key)).turns.find(row => row.id === turn.id));
        };
        const selected = await send('role-match', 'Review browser CSS');
        expect(selected.orderedMemberIds).toEqual([need(members.find(row => row.bot.botId === beta.botId)).id]);
        expect(selected.routing).toMatchObject({ strategy: 'local-role', reason: 'role-match', deciderCalls: 0, plannedCalls: 1 });
        const explicit = await send('explicit-match', 'Review browser CSS', [need(members.find(row => row.bot.botId === alpha.botId)).id]);
        expect(explicit.routing?.reason).toBe('mention');
        expect(explicit.orderedMemberIds).toEqual([need(members.find(row => row.bot.botId === alpha.botId)).id]);
        const fallback = await send('no-match', 'Unrelated question');
        expect(fallback.routing).toMatchObject({ strategy: 'fallback', reason: 'no-match', plannedCalls: 2 });
        await s.reopen();
        expect((await s.groups.view(key)).turns.find(row => row.id === selected.id)?.routing).toEqual(selected.routing);
      } finally { await s.close(); }
    });
  });
});


it.each(['governance', 'legacy', 'delete'])('purges exact production proactive copies through %s', async mode => {
  const x = await flowFixture(); x.current.set('beta', beta.botCreatedAt);
  try {
    await withIntegrations(async f => {
      const s = await fixture(f, mode === 'delete');
      try {
        Object.assign(f.registry, x.registry());
        f.registry.config.groupRoundTimeoutMs = 10000;
        const g = await s.createGroup('production-cleanup'), key = groupKey(g);
        const members = (await s.groups.view(key)).members;
        const t = await s.groups.startProactiveReview(key, { operationId: 'production-review',
          expectedMembershipRevision: g.membershipRevision, memberIds: members.map(m => m.id), text: 'PROACTIVE_INPUT' },
          { ticketId: 'ticket', assignmentId: 'assignment', provider: 'synthetic', model: 'loopback',
            botRevisions: [need(f.bots.get('alpha')).updatedAt, need(f.bots.get('beta')).updatedAt] }, async () => {});
        await vi.waitFor(async () => expect((await s.groups.view(key)).turns.find(row => row.id === t.id)?.state).toBe('completed'), { timeout: 10000 });
        const view = await s.groups.view(key), turn = need(view.turns.find(row => row.id === t.id));
        expect(turn.state).toBe('completed');
        const deliveries = view.deliveries.filter(row => row.turnId === t.id);
        expect(deliveries).toHaveLength(2);
        expect(deliveries.every(row => row.state === 'completed' && row.inputFlowId && row.inputFlowSessionId?.startsWith('group-context-'))).toBe(true);
        expect(turn.inputFlowSessionId).toMatch(/^group-context-/);
        if (mode === 'legacy') {
          const { inputFlowId: _turnFlow, inputFlowSessionId: _turnSession, ...oldTurn } = turn;
          await s.domain.table('turns').put(turn.id, oldTurn);
          for (const delivery of deliveries) {
            const { inputFlowId: _flow, inputFlowSessionId: _session, ...oldDelivery } = delivery;
            await s.domain.table('deliveries').put(delivery.id, oldDelivery);
          }
        }
        const copies = [...x.f.kernel.domain.table('flows').entries()].filter(([, row]) => row.envelope);
        expect(copies).toHaveLength(5);
        const root = need(s.roots.get(g.rootSessionId)).agent.session, native = root.snapshotEvents();
        expect(x.f.kernel.domain.table('flow_sessions').get(g.rootSessionId)).toBeUndefined();
        if (mode === 'delete') {
          await s.groups.waitForTurn(turn.id);
          await s.domain.table('turns').put(turn.id, { ...turn, inputFlowId: 'f9d46ac2-4619-425b-878e-a1b43f684dfd' });
          await expect(s.groups.deleteGroup(key, view.group.revision)).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
          expect(s.archiveSession).not.toHaveBeenCalled();
          expect(s.domain.table('deletions').get(key.groupId)).toBeUndefined();
          expect(copies.every(([id]) => x.flow.get(id).envelope)).toBe(true);
          await s.domain.table('turns').put(turn.id, turn);
          expect(await s.groups.deleteGroup(key, view.group.revision)).toBe(true);
        } else expect(await s.groups.purgeProactiveCopies(['assignment'])).toBe(true);
        expect(copies.every(([id]) => !x.flow.get(id).envelope)).toBe(true);
        expect(root.snapshotEvents()).toEqual(native);
        expect(await s.groups.purgeProactiveCopies(['assignment'])).toBe(true);
      } finally { await s.close(); }
    });
  } finally { await x.close(); }
});

it('runs status-only memory recording for the full group, shares no narrative and cannot be continued or followed up', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const g = await s.createGroup('memory-status'), key = groupKey(g);
    const input = { operationId: 'record-memory', expectedMembershipRevision: g.membershipRevision,
      text: 'Remember my preference', memoryStatusOnly: true as const };
    const turn = await s.groups.send(key, input);
    const view = await s.settle(g), settled = need(view.turns.find(row => row.id === turn.id));
    expect(s.calls).toHaveLength(2);
    expect(s.calls.every(call => call.prompt.includes('bot_memory_save'))).toBe(true);
    expect(view.deliveries.map(row => row.memoryWriteStatus)).toEqual(['unverified', 'unverified']);
    expect(view.deliveries.every(row => !row.outputMessageId && !row.failure && !row.exportFlowId)).toBe(true);
    expect(view.messages.filter(row => row.authorKind === 'bot')).toEqual([]);
    expect(await s.groups.send(key, input)).toMatchObject({ id: turn.id, memoryStatusOnly: true });
    expect(s.calls).toHaveLength(2);
    await expect(s.groups.continueTurn(key, turn.id, settled.revision)).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    await expect(s.groups.send(key, { operationId: 'unsafe-followup', expectedMembershipRevision: g.membershipRevision, text: 'Show private contents',
      followup: { turnId: turn.id, deliveryId: need(view.deliveries[0]).id } })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
  } finally { await s.close(); }
}));

it('records only the referenced shared message on an owner memory instruction', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const g = await s.groups.create({ operationId: 'memory-reference', name: 'Memory group', members: [alpha, beta], mode: 'natural', historyConfirmed: true }), key = groupKey(g);
    const send = (operationId: string, text: string, replyTo?: string) => s.groups.sendOwner(key,
      { operationId, text, replyTo, expectedMembershipRevision: g.membershipRevision });
    const first = await send('before', 'UNRELATED_EARLIER_INPUT');
    await s.groups.waitForTurn(first.id);
    const previous = await send('material', 'SHARED_LESSON_TO_RECORD');
    await s.groups.waitForTurn(previous.id);
    const before = s.calls.length;
    await expect(send('empty', '只记下来')).rejects.toMatchObject({ code: 'dsh-bot/memory-text-required' });
    const turn = await send('record', '只记下来', previous.inputMessageId);
    await s.groups.waitForTurn(turn.id);
    expect(turn.memoryStatusOnly).toBe(true);
    await expect(s.groups.sendOwner(key, { operationId: 'unsafe-supplement', expectedMembershipRevision: g.membershipRevision,
      text: '只记下来：仅保存状态', followup: { turnId: previous.id, deliveryId: previous.id + ':0' } })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
    expect(s.calls.slice(before)).toHaveLength(2);
    for (const call of s.calls.slice(before)) {
      expect(call.prompt).toContain('SHARED_LESSON_TO_RECORD');
      expect(call.prompt).not.toContain('UNRELATED_EARLIER_INPUT');
    }
    const result = await s.groups.view(key);
    expect(result.deliveries.filter(d => d.turnId === turn.id).every(d => d.memoryWriteStatus && !d.outputMessageId)).toBe(true);
    expect((await send('record', '只记下来', previous.inputMessageId)).id).toBe(turn.id);
  } finally { await s.close(); }
}));

it('routes @ by active group membership, including Bot IDs and everyone, while keeping quoted examples as text', () => withIntegrations(async f => {
  const s = await fixture(f);
  try {
    const first = need(f.bots.get(alpha.botId));
    f.bots.set(first.id, { ...first, name: 'Jarvis' });
    f.bots.set('visitor', { ...first, id: 'visitor', createdAt: 5, name: 'Jarvis' });
    const group = await s.createGroup(), key = groupKey(group);
    const { members } = await s.groups.view(key);
    const alphaId = need(members.find(m => m.bot.botId === alpha.botId)).id;
    const betaId = need(members.find(m => m.bot.botId === beta.botId)).id;
    await expect(s.groups.sendOwner(key, { operationId: 'mismatch', expectedMembershipRevision: 1,
      text: '@alpha 最近的进展', memberIds: [betaId] })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    expect(s.calls).toHaveLength(0);
    const send = async (text: string, memberIds?: string[]) => {
      const turn = await s.groups.sendOwner(key, { operationId: 'typed-' + s.calls.length, expectedMembershipRevision: 1, text, memberIds });
      await s.groups.waitForTurn(turn.id);
      expect(turn.guestQuestion).toBeUndefined();
      return turn.orderedMemberIds;
    };
    expect(await send('@Jarvis 今天的进展')).toEqual([alphaId]);
    expect(await send('@alpha 今天的进展')).toEqual([alphaId]);
    expect(await send('@everyone 大家好')).toEqual(members.map(m => m.id));
    expect(await send('＠ｅｖｅｒｙｏｎｅ 大家好')).toEqual(members.map(m => m.id));
    expect(await send('@alpha 请解释以下文字\n> @visitor text\n`@visitor` 和 user@visitor.net')).toEqual([alphaId]);
    f.bots.set(beta.botId, { ...need(f.bots.get(beta.botId)), name: 'Jarvis' });
    await expect(send('@Jarvis 近况', [alphaId, betaId])).rejects.toMatchObject({ code: 'dsh-bot/guest-ambiguous' });
    expect(await send('@Jarvis 近况', [betaId])).toEqual([betaId]);
    expect(await send('@Jarvis @Jarvis 请都回答', [betaId, alphaId])).toEqual([alphaId, betaId]);
  } finally { await s.close(); }
}));

it('only delivers the explicitly addressed owner question to a guest and publishes its exact native reply once', async () => {
  const x = await flowFixture();
  x.current.set('beta', beta.botCreatedAt);
  x.current.set('visitor', 5);
  try {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        Object.assign(f.registry, x.registry());
        f.registry.config.groupTaskTimeoutMs = 10000;
        const visitor = { ...need(f.bots.get('alpha')), id: 'visitor', name: 'Jarvis', createdAt: 5 };
        f.bots.set(visitor.id, visitor);
        const group = await s.createGroup(), key = groupKey(group);
        const view = await s.groups.view(key);
        const first = await s.groups.send(key, { operationId: 'earlier', expectedMembershipRevision: 1,
          text: 'UNRELATED_GROUP_HISTORY', memberIds: [need(view.members[0]).id] });
        await s.settle(group);
        const request = { operationId: 'ask-guest', expectedMembershipRevision: 1,
          text: '你问下 Jarvis 最近有和这个相关的吗？', replyTo: first.inputMessageId,
          expectedGuest: { botId: 'visitor', botCreatedAt: 5 }, relayTopic: 'HarmonyOS migration' };
        await expect(s.groups.sendOwner(key, { ...request, relayTopic: undefined })).rejects.toMatchObject({ code: 'dsh-bot/relay-topic-required' });
        const native = vi.fn(async ({ childId, request }: Parameters<typeof s.start>[0]) => {
          expect(request.prompt).toHaveLength(1);
          expect(request.prompt[0]?.text).toContain('最近有和这个相关的吗？');
          expect(request.prompt[0]?.text).not.toContain('UNRELATED_GROUP_HISTORY');
          expect(request.prompt[0]?.text).not.toContain('alpha');
          expect(request.agentPreset).toBe('bot-visitor');
          return { childId: need(childId), messageId: 'guest-accepted-id', result: Promise.resolve({
            output: [{ type: 'text' as const, text: 'Jarvis native response' }], stopReason: 'completed' as const }),
            dispose: vi.fn(async () => {}) };
        });
        s.start.mockImplementationOnce(native);
        const turn = await s.groups.sendOwner(key, request);
        expect((await s.groups.sendOwner(key, request)).id).toBe(turn.id);
        const result = await s.settle(group);
        expect(result.members).toEqual(view.members);
        expect(result.turns.find(t => t.id === turn.id)?.guestQuestion).toEqual({ bot: request.expectedGuest, name: 'Jarvis' });
        const deliveries = result.deliveries.filter(d => d.turnId === turn.id);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({ state: 'completed', acceptedAt: expect.any(Number) });
        expect(deliveries[0]).not.toHaveProperty('childSessionId');
        expect(deliveries[0]).not.toHaveProperty('childMessageId');
        expect(s.domain.table('deliveries').get(need(deliveries[0]).id)?.childMessageId).toBe('guest-accepted-id');
        expect(result.messages.find(m => m.id === deliveries[0]?.outputMessageId)).toMatchObject({ guestReply: true,
          speaker: { bot: request.expectedGuest, name: 'Jarvis' }, replyTo: turn.inputMessageId, text: 'Jarvis native response' });
        expect(native).toHaveBeenCalledTimes(1);
        await expect(s.groups.sendOwner(key, { ...request, text: '问 Jarvis 另一个问题' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
        await expect(s.groups.sendOwner(key, { ...request, operationId: 'stale', expectedGuest: { ...request.expectedGuest, botCreatedAt: 6 } }))
          .rejects.toMatchObject({ code: 'dsh-bot/guest-changed' });
        await expect(s.groups.send(key, { ...request, operationId: 'no-owner' })).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
        await expect(s.groups.sendOwner(key, { ...request, expectedGuest: undefined, operationId: 'missing', text: '问 Missing 怎么办' }))
          .rejects.toMatchObject({ code: 'dsh-bot/guest-unavailable' });
        // An incomplete native execution may contain text. That text must not become a guest answer.
        s.start.mockImplementationOnce(async ({ childId }) => ({ childId: need(childId), messageId: 'guest-partial-id',
          result: Promise.resolve({ output: [{ type: 'text', text: 'UNFINISHED_GUEST_OUTPUT' }], stopReason: 'error' }),
          dispose: vi.fn(async () => {}) }));
        const failed = await s.groups.sendOwner(key, { ...request, operationId: 'guest-failure' });
        const failedView = await s.settle(group);
        expect(failedView.deliveries.find(d => d.turnId === failed.id)).toMatchObject({ state: 'failed', acceptedAt: expect.any(Number) });
        expect(failedView.messages.some(m => m.text === 'UNFINISHED_GUEST_OUTPUT')).toBe(false);
        const secret = 'GUEST_PRIVATE_RESULT_CANARY';
        for (const allow of [false, true]) {
          s.start.mockImplementationOnce(async ({ childId }) => {
            await x.flow.inherit(need(childId), { readers: [request.expectedGuest], originTrust: 'candidate',
              sourceVersions: [], grants: [], restrictions: ['no-egress'] });
            return { childId: need(childId), messageId: 'guest-private-id', result: Promise.resolve({
              output: [{ type: 'text', text: secret }], stopReason: 'completed' }), dispose: vi.fn(async () => {}) };
          });
          const privateTurn = await s.groups.sendOwner(key, { ...request, operationId: `private-${allow}` });
          const heldView = await s.settle(group);
          const held = need(heldView.deliveries.find(d => d.turnId === privateTurn.id));
          expect(held.reasonCode).toBe('export-approval-required');
          expect(JSON.stringify(heldView)).not.toContain(secret);
          expect(held).not.toHaveProperty('childSessionId');
          const preview = await s.groups.exportReview.review(key, held.id);
          expect(preview.content).toBe(secret);
          await expect(s.groups.exportReview.decide(key, held.id, preview.token, 'always'))
            .rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
          await s.groups.exportReview.decide(key, held.id, preview.token, allow);
          const decided = await s.groups.view(key);
          if (allow) {
            const approved = need(decided.messages.find(m => m.text === secret));
            expect(approved).toMatchObject({ guestReply: true, speaker: { name: 'Jarvis', bot: request.expectedGuest } });
            expect(approved).not.toHaveProperty('childSessionId');
          } else expect(JSON.stringify(decided)).not.toContain(secret);
        }
      } finally { await s.close(); }
    });
  } finally { await x.close(); }
});

it('routes an owner handoff through the quoted member, sends only the authorized question, and gates the exact outside answer', async () => {
  const x = await flowFixture(), guest = { botId: 'visitor', botCreatedAt: 5 };
  x.current.set('beta', beta.botCreatedAt);
  x.current.set('visitor', guest.botCreatedAt);
  try {
    await withIntegrations(async f => {
      const s = await fixture(f);
      try {
        Object.assign(f.registry, x.registry(), { onboardingSnapshot: (id: string, generation: number) => {
          const bot = f.bots.get(id); return bot?.createdAt === generation ? bot : undefined;
        } });
        f.registry.config.groupTaskTimeoutMs = 10000;
        f.bots.set('visitor', { ...need(f.bots.get('alpha')), id: 'visitor', name: 'Jarvis', createdAt: 5 });
        const g = await s.createGroup(), key = groupKey(g);
        const initial = await s.groups.view(key), member = need(initial.members.find(m => m.bot.botId === alpha.botId));
        const original = await s.groups.send(key, { operationId: 'discussion', expectedMembershipRevision: 1,
          text: 'UNRELATED_PRIVATE_GROUP_HISTORY', memberIds: [member.id] });
        const settle = async (id: string) => { await s.groups.waitForTurn(id); return s.groups.view(key); };
        const history = await settle(original.id);
        const replyTo = need(history.messages.find(m => m.turnId === original.id && m.speaker?.bot.botId === alpha.botId)).id;
        const request = { operationId: 'delegate', expectedMembershipRevision: 1, expectedGuest: guest, expectedRelay: alpha,
          text: '你问下 Jarvis 最近有和这个相关的吗？', replyTo };
        await expect(s.groups.sendOwner(key, request)).rejects.toMatchObject({ code: 'dsh-bot/relay-topic-required' });
        const native = (text: string, protect = false) => s.start.mockImplementationOnce(async ({ childId, request }) => {
          const prompt = need(request.prompt[0]).text;
          if (request.agentPreset === 'bot-visitor') {
            expect(prompt).toContain('toolchain');
            expect(prompt).not.toContain('UNRELATED_PRIVATE_GROUP_HISTORY');
            expect(prompt).not.toContain('reply-1');
            if (protect) await x.flow.inherit(need(childId), { readers: [guest], originTrust: 'candidate', sourceVersions: [], grants: [], restrictions: ['no-egress'] });
          } else {
            expect(request.agentPreset).toBe('bot-alpha');
            expect(prompt).toContain('JARVIS_RAW_REPLY');
            expect(prompt).toContain('Jarvis');
            if (prompt.includes('最近有和这个相关的吗')) expect(prompt).toContain('reply-1');
          }
          return { childId: need(childId), messageId: 'accepted-' + request.agentPreset, result: Promise.resolve({
            output: [{ type: 'text', text }], stopReason: 'completed' }), dispose: vi.fn(async () => {}) };
        });
        await expect(s.groups.sendOwner(key, { ...request, relayTopic: 'toolchain', expectedRelay: beta }))
          .rejects.toMatchObject({ code: 'dsh-bot/guest-changed' });
        const before = await s.groups.view(key), callsBefore = s.start.mock.calls.length;
        for (const [i, text] of ['@Jarvis toolchain', '请问＠Jarvis toolchain', '让 alpha 问@Jarvis toolchain',
          '@alpha 问下 @Jarvis toolchain', '还有一题，@Jarvis 请回答'].entries()) {
          // Old clients can retain an exact guest selection, a quote, or just the typed text.
          await expect(s.groups.sendOwner(key, { ...request, operationId: 'outside-mention-' + i, text,
            memberIds: i === 3 ? [member.id] : [], expectedGuest: i === 0 ? guest : undefined, expectedRelay: undefined }))
            .rejects.toMatchObject({ code: 'dsh-bot/mention-not-member' });
        }
        const untouched = await s.groups.view(key);
        expect(untouched.turns).toHaveLength(before.turns.length);
        expect(untouched.messages).toHaveLength(before.messages.length);
        expect(untouched.deliveries).toHaveLength(before.deliveries.length);
        expect(s.start).toHaveBeenCalledTimes(callsBefore);
        for (const [i, path] of ['quote', 'explicit', 'deny', 'deny-group'].entries()) {
          const input = path === 'quote' ? { ...request, relayTopic: 'toolchain' } :
            { ...request, operationId: path, replyTo: undefined, text: path === 'explicit' ? '@alpha 问下 Jarvis toolchain' : '让 alpha 去问 Jarvis toolchain' };
          native('JARVIS_RAW_REPLY', i > 0);
          if (!i) native('Alpha published answer using Jarvis');
          const t = await s.groups.sendOwner(key, input);
          expect(t.guestQuestion?.via).toMatchObject({ memberId: member.id, bot: alpha });
          let view = await settle(t.id);
          const staleReceipts: import('../src/shared/groups.js').GroupDelivery[] = [];
          if (i > 0) {
            const held = need(view.deliveries.find(d => d.turnId === t.id));
            staleReceipts.push(need(s.domain.table('deliveries').get(held.id)));
            expect(held.reasonCode).toBe('export-approval-required');
            expect(view.deliveries.filter(d => d.turnId === t.id)).toHaveLength(1);
            expect(view.messages.filter(m => m.turnId === t.id && m.speaker)).toHaveLength(0);
            const preview = await s.groups.exportReview.review(key, held.id);
            expect(preview.recipients.map(r => r.bot)).toEqual([alpha]);
            if (path !== 'deny') native('Alpha published answer using Jarvis');
            await s.groups.exportReview.decide(key, held.id, preview.token, path !== 'deny');
            view = await settle(t.id);
            if (path !== 'deny') {
              const response = need(view.deliveries.find(d => d.turnId === t.id && d.ordinal === 1));
              staleReceipts.push(need(s.domain.table('deliveries').get(response.id)));
              expect(response.reasonCode).toBe('export-approval-required');
              expect(view.messages.filter(m => m.turnId === t.id && m.speaker)).toHaveLength(0);
              const groupPreview = await s.groups.exportReview.review(key, response.id);
              expect(groupPreview.recipients.map(r => r.bot)).toEqual([alpha, beta]);
              expect(groupPreview.content).toBe('Alpha published answer using Jarvis');
              await s.groups.exportReview.decide(key, response.id, groupPreview.token, path !== 'deny-group');
              view = await settle(t.id);
            }
          }
          if (staleReceipts.length) {
            // Simulate process exit after durable approval/native delivery but before the delivery metadata write.
            const nativeCalls = s.start.mock.calls.length;
            for (const old of staleReceipts) await s.domain.table('deliveries').put(old.id, old);
            await s.reopen();
            view = await s.groups.view(key);
            expect(s.start.mock.calls.length).toBe(nativeCalls);
            expect(view.deliveries.filter(d => d.turnId === t.id).some(d => d.exportFlowId)).toBe(false);
          }
          const messages = view.messages.filter(m => m.turnId === t.id && m.speaker);
          if (path === 'deny' || path === 'deny-group') { expect(messages).toHaveLength(0); continue; }
          expect(view.deliveries.filter(d => d.turnId === t.id)).toMatchObject([
            { state: 'completed', acceptedAt: expect.any(Number), answeredAt: expect.any(Number) },
            { state: 'completed', acceptedAt: expect.any(Number), memberId: member.id },
          ]);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({ relayReply: true, speaker: { bot: alpha }, text: 'Alpha published answer using Jarvis', replyTo: t.inputMessageId });
          expect(JSON.stringify(view)).not.toContain('JARVIS_RAW_REPLY');
          expect((await s.groups.sendOwner(key, input)).id).toBe(t.id);
          const d = need(s.domain.table('deliveries').get(t.id + ':1')), copy = need(s.domain.table('deliveries').get(t.id + ':0')?.relayAnswerFlowId);
          expect(x.flow.get(copy).envelope?.binding.target).toEqual({ kind: 'bot', bot: alpha });
          expect(x.flow.get(need(d.inputFlowId)).envelope?.content).not.toContain('JARVIS_RAW_REPLY');
          if (i > 0) expect(x.flow.label(need(d.childSessionId)).readers).toEqual([]);
        }
      } finally { await s.close(); }
    });
  } finally { await x.close(); }
}, 20000);
