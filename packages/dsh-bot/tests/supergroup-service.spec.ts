import { expect, test, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { DshBotRegistry } from '../src/host/registry.js';
import type { Groups } from '../src/host/groups/service.js';
import type { SupergroupAuthority, SupergroupExpertHandler, SupergroupExpertRequest } from '../src/host/groups/supergroup-admission.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { Supergroup, type supergroupDomain, supergroupInputSchema } from '../src/host/supergroup/service.js';
import type { SupergroupWork } from '../src/shared/supergroup.js';
import { Config as SupergroupConfig, type SupergroupConfig as SupergroupConfigValue } from '../src/host/supergroup/config.js';
import type { CollaborationScope, CollaborationResult } from '../src/host/supergroup/collaboration.js';
import { need } from '../src/host/common/operations.js';

/** Exercise the work owner's hooks without a fake native model or exposing them as product APIs. */
const collaborationHooks = (service: Supergroup) => service as unknown as {
  authorizeCollaboration(agent: Agent, targetId: string, callId: string, signal: AbortSignal, argumentDigest: string): Promise<CollaborationScope>;
  reserveCollaborationRequest(scope: CollaborationScope): Promise<void>;
  finishCollaboration(scope: CollaborationScope, result: CollaborationResult): Promise<void>;
};
const completedCollaboration = (scope: CollaborationScope, childId = 'clean-beta'): CollaborationResult => ({
  workId: scope.workId, operationId: scope.operationId, childId, status: 'completed', result: 'Clean task result',
});

async function fixture(options: { expert?: boolean; expertBot?: string; held?: boolean; rejectResult?: boolean; recovered?: SupergroupWork[]; directory?: string[]; observeDuringExpert?: boolean; disabledBot?: string } = {}) {
  const bots = (options.directory ?? ['alpha', 'beta', 'gamma']).map(id => ({ id, createdAt: 1, updatedAt: 1, name: id, tools: { deny: [] } }));
  const config = { supergroup: { enabled: true, maxMembers: 4, maxExperts: 16, maxRequests: 24, timeoutMs: 300000, allowedBotIds: [] as string[] } };
  let messages: unknown[] = [{ type: 'user/message', seq: 1, data: { id: 'human-one', source: { kind: 'user' }, content: [{ type: 'text', text: 'Exact human task' }] } }];
  const agent = { id: 'main-alpha', session: { id: 'main-alpha', header: {}, snapshotEvents: () => messages } } as unknown as Agent;
  bindings.set(agent, { botId: 'alpha', botCreatedAt: 1 });
  const table = new Map<string, SupergroupWork>((options.recovered ?? []).map(row => [row.id, structuredClone(row)]));
  const domain = { table: () => ({ get: (id: string) => table.get(id), entries: () => [...table.entries()], put: async (id: string, value: SupergroupWork) => { table.set(id, structuredClone(value)); } }), close: async () => {} } as unknown as Domain<typeof supergroupDomain>;
  const sent: { text: string; memberIds: string[] }[] = [], flows: string[] = [], experts: unknown[] = [];
  const group = { id: 'g', createdAt: 3, revision: 1, membershipRevision: 1, name: 'Group', mode: 'natural', rootSessionId: 'group-root' };
  let members: { id: string; enabled: boolean; bot: { botId: string; botCreatedAt: number } }[] = [];
  const turns: { id: string; state: string; revision: number }[] = [], deliveries: { turnId: string; state: string }[] = [];
  const groupMessages: { authorKind: string; turnId: string; text: string }[] = [];
  let handler: SupergroupExpertHandler | undefined, createCalls = 0, editCalls = 0, refreshCalls = 0, drains = 0, released = false;
  const authorities: SupergroupAuthority[] = [];
  let unblock: (() => void) | undefined;
  const held = new Promise<void>(accept => { unblock = accept; });
  let blockedView: Promise<void> | undefined, unblockView: (() => void) | undefined, viewReached: (() => void) | undefined;
  const view = () => ({ group: { ...group }, members: structuredClone(members), turns: structuredClone(turns), deliveries: structuredClone(deliveries), messages: structuredClone(groupMessages) });
  const groups = {
    setExpertHandler: (value: SupergroupExpertHandler) => { handler = value; return () => { handler = undefined; }; },
    createSupergroup: async (value: { members: typeof members[number]['bot'][] }, authority: SupergroupAuthority) => {
      authorities.push(authority);
      await authority.check(); createCalls++;
      members = value.members.map((bot, index) => ({ bot, id: `member-${index}`, enabled: bot.botId !== options.disabledBot })); return { ...group };
    },
    refreshSupergroupAuthority: async (_key: unknown, authority: { check(): Promise<void> }) => { await authority.check(); refreshCalls++; },
    view: async () => { if (blockedView) { viewReached?.(); await blockedView; } return view(); },
    sendSupergroup: async (_key: unknown, input: { text: string; memberIds: string[] }, authority: { check(): Promise<void> }) => {
      await authority.check(); sent.push(input); const turn = { id: `turn-${sent.length}`, state: 'running', revision: 1 };
      turns.push(turn); for (const _member of input.memberIds) deliveries.push({ turnId: turn.id, state: 'running' }); return { ...turn };
    },
    waitForTurn: async (id: string) => {
      if (options.held && !released) await held;
      if (options.expert && sent.length === 1) {
        const request = { workId: [...table.values()][0]!.id, group: { groupId: group.id, groupCreatedAt: group.createdAt },
          botId: options.expertBot ?? 'gamma', question: 'Need specialist review', callId: 'expert-1', agent: { id: 'worker-alpha' }, binding: { turnId: id } } as SupergroupExpertRequest;
        if (options.observeDuringExpert) {
          blockedView = new Promise(resolve => { unblockView = resolve; });
          const reached = new Promise<void>(resolve => { viewReached = resolve; });
          const observation = service.catalog();
          await reached;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([handler!(request), new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Observer held the work queue while waiting for the Groups queue')), 500);
            })]);
          } finally { clearTimeout(timer); unblockView?.(); blockedView = undefined; }
          await observation;
        }
        experts.push(...await Promise.all([handler!(request), handler!({ ...request, callId: 'expert-2', question: 'Another specialist question' })]));
        await expect(handler!({ ...request, question: 'Changed replay body' })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      }
      const turn = turns.find(row => row.id === id)!; turn.state = 'idle'; turn.revision++;
      for (const delivery of deliveries.filter(row => row.turnId === id)) if (delivery.state === 'running') delivery.state = 'completed';
      groupMessages.push({ authorKind: 'bot', turnId: id, text: sent.length === 1 ? 'Initial contribution' : 'Expert contribution' });
    },
    editSupergroup: async (_key: unknown, value: { members: typeof members[number]['bot'][] }, authority: { check(): Promise<void> }) => {
      await authority.check(); editCalls++; members = value.members.map((bot, index) => ({ bot, id: `member-${index}`, enabled: true })); group.revision++; group.membershipRevision++;
    },
    cancel: async (_key: unknown, id: string) => { const turn = turns.find(row => row.id === id)!; turn.state = 'cancelled'; },
    drain: async () => { drains++; released = true; unblock?.(); },
  } as unknown as Groups;
  const registry = { config, invalidate() {}, get: async (id: string) => { const bot = bots.find(row => row.id === id); if (!bot) throw new Error('missing'); return bot; },
    list: async () => bots, status: async () => bots.map(bot => ({ id: bot.id, preset: { state: 'ok' } })), mainSessions: { find: async () => ({ sessionId: agent.id }) },
    memoryKernel: {}, memoryOutlets: {
      draft: (_outlet: string, _owner: unknown, sessionId: string, _id: string, _target: unknown, content: string) => { flows.push(`draft:${sessionId}`); return { content, label: { readers: 'unchanged-intersection' } }; },
      admit: async () => { flows.push('admit'); if (options.rejectResult) throw new Error('Data export not approved'); return 'flow-id'; },
      inherit: async (id: string) => { flows.push(`inherit:${id}`); },
      dispatch: async (_id: string, send: () => unknown, _signal: unknown, check: () => Promise<void>) => { await check(); flows.push('dispatch'); return send(); },
    } } as unknown as DshBotRegistry;
  const ctx = { agents: { get: (id: string) => id === agent.id ? agent : undefined } } as unknown as Context;
  const service = new Supergroup(ctx, registry, groups, domain); await service.start();
  return { service, table, sent, flows, experts, agent, config, authorities, ctx, registry,
    requestExpert: (botId: string, callId: string) => need(handler)({ workId: need([...table.values()][0]).id,
      group: { groupId: group.id, groupCreatedAt: group.createdAt }, agent: { id: 'worker-alpha' },
      binding: { turnId: need(turns[0]).id }, botId, callId, question: 'Review the current task' } as SupergroupExpertRequest),
    get counts() { return { createCalls, editCalls, refreshCalls, drains }; },
    human: (id: string, text: string, source = 'user', attachment = false) => { messages = [{ type: 'user/message', seq: 2,
      data: { id, source: { kind: source }, content: attachment ? [{ type: 'image' }] : [{ type: 'text', text }] } }]; },
    events: (value: unknown[]) => { messages = value; },
    release: () => { released = true; unblock?.(); } };
}
const signal = () => new AbortController().signal;

test('the six-member group roster includes only selected Bots and keeps the larger discovery pool', async () => {
  const directory = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
  const f = await fixture({ directory });
  try {
    f.config.supergroup.maxMembers = 16;
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: directory }, signal()))
      .rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
    expect(f.counts.createCalls).toBe(0);
    // The initiating owner is a reader; it occupies a roster place only if selected.
    const result = await f.service.invoke(f.agent, { action: 'start', memberIds: directory.slice(1) }, signal());
    expect(result).toMatchObject({ state: 'completed' });
    expect(f.sent[0]?.memberIds).toHaveLength(6);
    expect(need([...f.table.values()][0]).readers).toHaveLength(7);
    expect(f.counts.createCalls).toBe(1);
  } finally { await f.service.close(); }
});

test('expert invitations reserve the last roster place and reject a seventh Bot before recording it', async () => {
  const directory = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
  const f = await fixture({ directory, held: true });
  try {
    f.config.supergroup.maxMembers = 16;
    const work = f.service.invoke(f.agent, { action: 'start', memberIds: directory.slice(0, 5) }, signal());
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(await f.requestExpert('zeta', 'last-place')).toMatchObject({ status: 'accepted' });
    await expect(f.requestExpert('eta', 'seventh-place')).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
    expect(need([...f.table.values()][0]).experts.map(expert => expert.botId)).toEqual(['zeta']);
    f.release();
    expect(await work).toMatchObject({ state: 'completed' });
    expect(f.counts.editCalls).toBe(1);
    const view = await f.service.byGroup({ groupId: 'g', groupCreatedAt: 3 });
    expect(view?.group?.members).toHaveLength(6);
  } finally { f.release(); await f.service.close(); }
});

test('a smaller configured Supergroup member limit rejects admission without starting a group', async () => {
  const f = await fixture();
  try {
    f.config.supergroup.maxMembers = 2;
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta', 'gamma'] }, signal()))
      .rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
    expect(f.counts.createCalls).toBe(0);
  } finally { await f.service.close(); }
});

test('a disabled but unremoved Bot still occupies its Supergroup roster place', async () => {
  const directory = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
  const f = await fixture({ directory, held: true, disabledBot: 'beta' });
  try {
    f.config.supergroup.maxMembers = 16;
    const work = f.service.invoke(f.agent, { action: 'start', memberIds: directory.slice(0, 6) }, signal());
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]?.memberIds).toHaveLength(5);
    await expect(f.requestExpert('eta', 'disabled-is-not-removed')).rejects.toMatchObject({ code: 'dsh-bot/member-limit' });
    expect(need([...f.table.values()][0]).experts).toHaveLength(0);
    f.release();
    expect(await work).toMatchObject({ state: 'completed' });
    expect(f.counts.editCalls).toBe(0);
    const view = await f.service.byGroup({ groupId: 'g', groupCreatedAt: 3 });
    expect(view?.group?.members).toHaveLength(6);
    expect(view?.group?.members.filter(member => !member.enabled)).toHaveLength(1);
  } finally { f.release(); await f.service.close(); }
});

test.each(['skill-catalog', 'user-approval'])('native %s after a real human does not replace Supergroup input authority', async kind => {
  const f = await fixture();
  f.events([{ type: 'turn/start', seq: 47 },
    { type: 'user/message', seq: 51, data: { id: 'human-51', source: { kind: 'user' }, content: [{ type: 'text', text: 'Only exact human task' }] } },
    { type: 'user/message', seq: 53, data: { id: 'metadata', source: { kind }, content: [{ type: 'text', text: 'Native metadata must not become the task' }] } },
  ]);
  try {
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).resolves.toMatchObject({ state: 'completed' });
    expect(f.sent.map(row => row.text)).toEqual(['Only exact human task']);
    expect([...f.table.values()][0]?.inputMessageId).toBe('human-51');
  } finally { await f.service.close(); }
});

test.each(['metadata-only', 'unknown-context', 'dsh-bot-message', 'dsh-bot-delegate', 'schedule'])('native metadata does not authorize %s Supergroup work', async kind => {
  const f = await fixture();
  f.events([
    ...(kind === 'metadata-only' ? [] : [{ type: 'user/message', seq: 51, data: { id: 'untrusted', source: { kind }, content: [{ type: 'text', text: 'Not human authority' }] } }]),
    ...['skill-catalog', 'user-approval'].map((source, index) => ({ type: 'user/message', seq: 53 + index, data: {
      id: source, source: { kind: source }, content: [{ type: 'text', text: 'Context only' }],
    } })),
  ]);
  try {
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    expect(f.counts.createCalls).toBe(0); expect(f.sent).toEqual([]);
  } finally { await f.service.close(); }
});

test('one exact human input builds two Bots then admits one deduplicated expert into the same work before checked return', async () => {
  const f = await fixture({ expert: true });
  try {
    const output = await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect(output).toMatchObject({ state: 'completed', results: [{ text: 'Initial contribution' }, { text: 'Expert contribution' }] });
    expect(f.sent.map(row => row.text)).toEqual(['Exact human task', 'Exact human task']);
    expect(f.sent.map(row => row.memberIds.length)).toEqual([2, 1]);
    const work = [...f.table.values()][0]!;
    expect(work.experts).toHaveLength(2); expect(work.experts.every(row => row.botId === 'gamma' && row.state === 'invited')).toBe(true);
    expect(work.experts[0]).not.toHaveProperty('question');
    expect(f.experts).toHaveLength(2); expect(f.counts.createCalls).toBe(1);
    expect(f.flows).toEqual(['draft:group-root', 'admit', 'inherit:main-alpha', 'dispatch']);
    const duplicate = await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect(duplicate).toMatchObject({ state: 'completed', resumed: false });
    expect(f.counts.createCalls).toBe(1); expect(f.sent).toHaveLength(2); expect(f.flows.filter(value => value === 'dispatch')).toHaveLength(1);
    expect(f.counts.editCalls).toBe(1);
  } finally { await f.service.close(); }
});

test('machine notices, unsupported attachments and unpermitted members never create a group', async () => {
  const f = await fixture();
  try {
    f.human('machine', 'not human', 'agent-message');
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.human('image', '', 'user', true);
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.human('human', 'task'); f.config.supergroup.allowedBotIds = ['beta'];
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'gamma'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    expect(f.counts.createCalls).toBe(0); expect(f.table.size).toBe(0);
    expect(() => supergroupInputSchema.parse({ action: 'start', memberIds: ['alpha', 'beta'], task: 'private model synthesis' })).toThrow();
  } finally { await f.service.close(); }
});

test('a new human revision continues the same work/group and retains the exact input chain', async () => {
  const f = await fixture();
  try {
    await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    const original = [...f.table.values()][0]!;
    f.human('human-two', 'Revise the second conclusion');
    await f.service.invoke(f.agent, { action: 'continue', workId: original.id }, signal());
    const current = [...f.table.values()][0]!;
    expect(current.id).toBe(original.id); expect(current.group).toEqual(original.group);
    expect(current.inputMessageId).toBe('human-one'); expect(current.inputMessageIds).toEqual(['human-one', 'human-two']);
    expect(f.sent.at(-1)?.text).toBe('Revise the second conclusion');
    expect(f.counts).toMatchObject({ createCalls: 1, refreshCalls: 1 });
    await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect(f.table.size).toBe(1); expect(f.sent).toHaveLength(2);
  } finally { await f.service.close(); }
});

test('requests for an existing member reuse that member without duplicate membership edit', async () => {
  const f = await fixture({ expert: true, expertBot: 'alpha' });
  try {
    await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect(f.sent.map(row => row.memberIds.length)).toEqual([2, 1]);
    expect(f.counts.editCalls).toBe(0);
    expect([...f.table.values()][0]?.experts.every(row => row.state === 'invited')).toBe(true);
  } finally { await f.service.close(); }
});

test('failed data export returns no transcript and persists unknown rather than replaying a finished model', async () => {
  const f = await fixture({ rejectResult: true });
  try {
    expect(await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).toMatchObject({ state: 'unknown' });
    expect(f.flows).toEqual(['draft:group-root', 'admit']);
    const status = await f.service.invoke(f.agent, { action: 'status' }, signal());
    expect(JSON.stringify(status)).not.toContain('Initial contribution');
    expect(await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).toMatchObject({ state: 'unknown', resumed: false });
    expect(f.sent).toHaveLength(1);
  } finally { await f.service.close(); }
});

test('mode revocation fences an in-flight work, drains actual backend and prevents later invitations', async () => {
  const f = await fixture({ held: true, expert: true });
  try {
    const run = f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    for (let tries = 0; !f.sent.length && tries < 100; tries++) await new Promise(accept => setTimeout(accept, 1));
    expect(f.sent).toHaveLength(1);
    f.config.supergroup.enabled = false; await f.service.configChanged();
    expect(await run).toMatchObject({ state: 'cancelled' });
    expect([...f.table.values()][0]?.experts).toEqual([]);
    expect(f.counts.drains).toBeGreaterThan(0); expect(f.flows).toEqual([]);
  } finally { f.release(); await f.service.close(); }
});

test('restart marks unfinished durable associations unknown without creating or re-running Groups', async () => {
  const original = await fixture();
  await original.service.invoke(original.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
  const work = { ...[...original.table.values()][0]!, state: 'running' as const };
  await original.service.close();
  const f = await fixture({ recovered: [work] });
  try {
    expect([...f.table.values()][0]).toMatchObject({ state: 'unknown', reason: 'restart-execution-unconfirmed' });
    expect(await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).toMatchObject({ state: 'unknown', resumed: false });
    expect(f.counts.createCalls).toBe(0); expect(f.sent).toEqual([]); expect(f.flows).toEqual([]);
  } finally { await f.service.close(); }
});

test('a large default directory freezes a bounded owner-first pool; outside selections and explicit excess remain denied', async () => {
  const directory = ['gamma', ...Array.from({ length: 20 }, (_, i) => `expert-${String(i).padStart(2, '0')}`), 'beta', 'alpha'];
  const f = await fixture({ directory });
  try {
    f.config.supergroup.maxExperts = 2;
    await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect([...f.table.values()][0]?.readers.map(key => key.botId)).toEqual(['alpha', 'beta', 'expert-00']);
    expect(f.counts.createCalls).toBe(1);
    f.human('outside', 'Next task');
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'gamma'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.config.supergroup.allowedBotIds = ['beta', 'gamma', 'expert-00'];
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
    expect(f.counts.createCalls).toBe(1);
  } finally { await f.service.close(); }
});

test.each(['skill-catalog', 'user-approval'])('direct collaboration uses the exact real human text through native %s metadata', async kind => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    f.events([
      { type: 'user/message', seq: 1, data: { id: 'private-old', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_OLD_HISTORY_CANARY' }] } },
      { type: 'user/message', seq: 2, data: { id: 'human-current', source: { kind: 'user' }, content: [{ type: 'text', text: 'Only this current task' }] } },
      { type: 'user/message', seq: 3, data: { id: 'ambient', source: { kind }, content: [{ type: 'text', text: 'NATIVE_METADATA_CANARY' }] } },
    ]);
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'call-one', signal(), 'exact-args');
    expect(scope).toMatchObject({ origin: f.agent, messageId: 'human-current', text: 'Only this current task', owner: { botId: 'alpha', botCreatedAt: 1 } });
    expect(scope.readers.map(row => row.botId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(scope.text).not.toContain('PRIVATE_');
    expect(scope.text).not.toContain('METADATA_');
    expect(f.table.get(scope.workId)).toMatchObject({ inputMessageIds: ['human-current'], state: 'running', collaboration: { requests: 0, operations: [{ state: 'prepared' }] } });
    expect(f.counts.createCalls).toBe(0);
    expect(f.sent).toEqual([]);
  } finally { await f.service.close(); }
});

test.each(['metadata-only', 'unknown-context', 'dsh-bot-message', 'dsh-bot-delegate', 'schedule'])('direct collaboration rejects %s without granting a work', async kind => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    f.events([
      ...(kind === 'metadata-only' ? [] : [{ type: 'user/message', seq: 1, data: { id: 'machine', source: { kind }, content: [{ type: 'text', text: 'Not human authority' }] } }]),
      { type: 'user/message', seq: 2, data: { id: 'ambient', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'Catalog only' }] } },
    ]);
    await expect(hooks.authorizeCollaboration(f.agent, 'beta', 'call-one', signal(), 'args')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    expect(f.table.size).toBe(0);
    expect(f.counts.createCalls).toBe(0);
  } finally { await f.service.close(); }
});

test('direct operation admission binds arguments and target while terminal settlement remains stable', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'one-call', signal(), 'first-digest');
    const duplicate = await hooks.authorizeCollaboration(f.agent, 'beta', 'one-call', signal(), 'first-digest');
    expect(duplicate.operationId).toBe(scope.operationId);
    expect(f.table.get(scope.workId)?.collaboration?.operations).toHaveLength(1);
    await expect(hooks.authorizeCollaboration(f.agent, 'beta', 'one-call', signal(), 'changed-digest')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await expect(hooks.authorizeCollaboration(f.agent, 'gamma', 'one-call', signal(), 'first-digest')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
    await hooks.finishCollaboration(scope, completedCollaboration(scope));
    const original = structuredClone(f.table.get(scope.workId)?.collaboration);
    await hooks.finishCollaboration(scope, completedCollaboration(scope));
    expect(f.table.get(scope.workId)).toMatchObject({ state: 'completed', collaboration: original });
    // A late duplicate cannot replace the accepted child, result digest or terminal status.
    await hooks.finishCollaboration(scope, { ...completedCollaboration(scope, 'wrong-child'), status: 'unknown', result: 'Changed late result' });
    expect(f.table.get(scope.workId)).toMatchObject({ state: 'completed', collaboration: original });
    await expect(hooks.authorizeCollaboration(f.agent, 'beta', 'one-call', signal(), 'first-digest')).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  } finally { await f.service.close(); }
});

test('direct native requests share one budget across operations and preserve it when the work becomes a group', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    f.config.supergroup.maxRequests = 3;
    const first = await hooks.authorizeCollaboration(f.agent, 'beta', 'first-call', signal(), 'first');
    await hooks.reserveCollaborationRequest(first);
    await hooks.finishCollaboration(first, completedCollaboration(first));
    const second = await hooks.authorizeCollaboration(f.agent, 'gamma', 'second-call', signal(), 'second');
    expect(second.workId).toBe(first.workId);
    await hooks.reserveCollaborationRequest(second);
    await hooks.finishCollaboration(second, completedCollaboration(second, 'clean-gamma'));
    expect(f.table.get(first.workId)?.collaboration?.requests).toBe(2);
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).resolves.toMatchObject({ workId: first.workId, state: 'completed' });
    const upgraded = need(f.table.get(first.workId));
    expect(upgraded).toMatchObject({ group: { groupId: 'g', groupCreatedAt: 3 }, collaboration: { requests: 2 } });
    expect(upgraded.collaboration?.operations).toHaveLength(2);
    expect(f.counts.createCalls).toBe(1);
    expect(first.signal.aborted).toBe(true);
    const groupAuthority = need(f.authorities[0]);
    expect(groupAuthority.requestsUsed?.()).toBe(2);
    await groupAuthority.reserveRequest?.();
    expect(groupAuthority.requestsUsed?.()).toBe(3);
    await expect(groupAuthority.reserveRequest?.()).rejects.toMatchObject({ code: 'dsh-bot/budget-exhausted' });
    expect(f.table.get(first.workId)?.collaboration?.requests).toBe(3);
  } finally { await f.service.close(); }
});

test('stopping direct work revokes prepared operations and late completion cannot revive it', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'first-call', signal(), 'args');
    const work = need(f.table.get(scope.workId));
    await f.service.cancel(work.id, work.revision);
    expect(scope.signal.aborted).toBe(true);
    expect(f.table.get(work.id)).toMatchObject({ state: 'cancelled', collaboration: { operations: [{ state: 'cancelled' }] } });
    await expect(scope.check()).rejects.toBeDefined();
    await expect(hooks.reserveCollaborationRequest(scope)).rejects.toBeDefined();
    await expect(hooks.authorizeCollaboration(f.agent, 'gamma', 'next-call', signal(), 'next')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    await hooks.finishCollaboration(scope, completedCollaboration(scope));
    expect(f.table.get(work.id)).toMatchObject({ state: 'cancelled', collaboration: { operations: [{ state: 'cancelled' }], requests: 0 } });
    expect(f.counts.drains).toBe(0);
  } finally { await f.service.close(); }
});

test('disabling Supergroup revokes a completed direct scope without relabelling its history cancelled', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'first-call', signal(), 'args');
    await hooks.reserveCollaborationRequest(scope);
    await hooks.finishCollaboration(scope, completedCollaboration(scope));
    const completed = structuredClone(f.table.get(scope.workId));
    f.config.supergroup.enabled = false;
    await f.service.configChanged();
    expect(scope.signal.aborted).toBe(true);
    expect(f.table.get(scope.workId)).toEqual(completed);
    await expect(hooks.authorizeCollaboration(f.agent, 'gamma', 'next-call', signal(), 'next')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
  } finally { await f.service.close(); }
});

test('recovery keeps unfinished direct operations unknown and never upgrades or replays them', async () => {
  const original = await fixture(), hooks = collaborationHooks(original.service);
  const scope = await hooks.authorizeCollaboration(original.agent, 'beta', 'first-call', signal(), 'args');
  await hooks.reserveCollaborationRequest(scope);
  const interrupted = structuredClone(need(original.table.get(scope.workId)));
  await original.service.close();
  const f = await fixture({ recovered: [interrupted] }), restored = collaborationHooks(f.service);
  try {
    expect(f.table.get(scope.workId)).toMatchObject({ state: 'unknown', collaboration: { requests: 1, operations: [{ state: 'unknown' }] } });
    await expect(restored.authorizeCollaboration(f.agent, 'beta', 'first-call', signal(), 'args')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    await expect(f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).resolves.toMatchObject({ state: 'unknown', resumed: false });
    expect(f.counts.createCalls).toBe(0);
    expect(f.sent).toEqual([]);
    expect(f.flows).toEqual([]);
    expect(f.table.get(scope.workId)?.collaboration?.operations).toHaveLength(1);
  } finally { await f.service.close(); }
});

function settingsFixture() {
  let raw: Record<string, unknown> = { seedExamples: false, dataDir: '/synthetic/kept', unrelated: { value: 'kept' },
    supergroup: { enabled: false, maxMembers: 3, maxExperts: 6, maxRequests: 12, timeoutMs: 42000, allowedBotIds: ['beta'] } };
  const config = { supergroup: SupergroupConfig(raw.supergroup as Partial<SupergroupConfigValue>) };
  const entry = { options: { name: 'dsh-botgroup' }, fiber: { uid: 17 } };
  let calls = 0, fail: Error | undefined, apply = true, onBefore: (() => void) | undefined;
  const editor = { entries: () => [entry], edit: async (selected: unknown, change: (value: Record<string, unknown>) => Record<string, unknown>) => {
    expect(selected).toBe(entry); calls++; onBefore?.();
    if (fail) throw fail;
    raw = change(structuredClone(raw));
    if (apply) config.supergroup = SupergroupConfig(raw.supergroup as Partial<SupergroupConfigValue>);
  } };
  const loader = { locate: () => 'profile/dsh-bot', resolve: () => entry };
  const ctx = { fiber: {}, get: (name: string) => name === 'loader' ? loader : name === 'configEditor' ? editor : undefined } as unknown as Context;
  const service = new Supergroup(ctx, { config } as unknown as DshBotRegistry, {} as Groups, {} as Domain<typeof supergroupDomain>);
  return { service, config, entry, editor, get raw() { return raw; }, get calls() { return calls; },
    setFail: (error: Error) => { fail = error; }, noApply: () => { apply = false; },
    before: (action: () => void) => { onBefore = action; } };
}

test('owner settings expose only enabled; no-op avoids native editor and stale expectations conflict', async () => {
  const f = settingsFixture();
  expect(f.service.settings()).toEqual({ enabled: false });
  expect(await f.service.configure({ enabled: false, expectedEnabled: false })).toEqual({ enabled: false });
  expect(f.calls).toBe(0);
  await expect(f.service.configure({ enabled: true, expectedEnabled: true })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  expect(f.calls).toBe(0);
});

test('native mode edits preserve all advanced and unrelated raw configuration', async () => {
  const f = settingsFixture(), previous = structuredClone(f.raw);
  expect(await f.service.configure({ enabled: true, expectedEnabled: false })).toEqual({ enabled: true });
  expect(f.calls).toBe(1);
  expect(f.raw).toEqual({ ...previous, supergroup: { ...(previous.supergroup as object), enabled: true } });
  expect(f.config.supergroup.allowedBotIds).toEqual(['beta']);
});

test('native editor failure or missing live apply never reports successful settings', async () => {
  const f = settingsFixture(), failure = new Error('Synthetic native save failure'); f.setFail(failure);
  await expect(f.service.configure({ enabled: true, expectedEnabled: false })).rejects.toBe(failure);
  expect(f.service.settings()).toEqual({ enabled: false });
  const noApply = settingsFixture(); noApply.noApply();
  await expect(noApply.service.configure({ enabled: true, expectedEnabled: false })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  expect(noApply.service.settings()).toEqual({ enabled: false });
});

test('the native edit callback rechecks current mode, raw mode and exact Host ownership', async () => {
  const f = settingsFixture(); f.before(() => { f.config.supergroup.enabled = true; });
  await expect(f.service.configure({ enabled: true, expectedEnabled: false })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  expect((f.raw.supergroup as { enabled: boolean }).enabled).toBe(false);
  const changedOwner = settingsFixture(); changedOwner.before(() => { changedOwner.entry.fiber.uid++; });
  await expect(changedOwner.service.configure({ enabled: true, expectedEnabled: false })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
  expect((changedOwner.raw.supergroup as { enabled: boolean }).enabled).toBe(false);
  const rawChanged = settingsFixture(); rawChanged.before(() => { (rawChanged.raw.supergroup as { enabled: boolean }).enabled = true; });
  await expect(rawChanged.service.configure({ enabled: true, expectedEnabled: false })).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
});

test('a catalog observer waiting for Groups does not block that group expert admission', async () => {
  const f = await fixture({ expert: true, observeDuringExpert: true });
  try {
    const result = await f.service.invoke(f.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
    expect(result).toMatchObject({ state: 'completed' });
    expect(f.counts.editCalls).toBe(1); expect(f.sent.map(row => row.memberIds.length)).toEqual([2, 1]);
  } finally { await f.service.close(); }
});

test('a checked display receipt preserves the human task but never becomes authority itself', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  Object.assign(f.ctx, { get: (name: string) => name === 'dshBotMessaging' ? {
    isDisplayMessage: (_agent: Agent, message: { id: string }) => message.id === 'checked-display',
  } : undefined });
  const human = { type: 'user/message', seq: 1, data: { id: 'current-human', source: { kind: 'user' }, content: [{ type: 'text', text: 'Actual question' }] } };
  const display = { type: 'user/message', seq: 2, data: { id: 'checked-display', source: { kind: 'dsh-bot-message' }, content: [{ type: 'text', text: 'Visible receipt only' }] } };
  try {
    f.events([human, display]);
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'display-followup', signal(), 'args');
    expect(scope).toMatchObject({ messageId: 'current-human', text: 'Actual question' });
    f.events([display]);
    await expect(hooks.authorizeCollaboration(f.agent, 'beta', 'display-only', signal(), 'args')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.events([human, { ...display, data: { ...display.data, id: 'forged-display' } }]);
    await expect(hooks.authorizeCollaboration(f.agent, 'beta', 'forged', signal(), 'args')).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
  } finally { await f.service.close(); }
});

test('collaboration failure retains a specific budget diagnostic instead of reporting an approval rejection', async () => {
  const f = await fixture(), hooks = collaborationHooks(f.service);
  try {
    f.config.supergroup.maxRequests = 1;
    const scope = await hooks.authorizeCollaboration(f.agent, 'beta', 'budget-diagnostic', signal(), 'args');
    await hooks.reserveCollaborationRequest(scope);
    await expect(hooks.reserveCollaborationRequest(scope)).rejects.toMatchObject({ code: 'dsh-bot/budget-exhausted' });
    await hooks.finishCollaboration(scope, { ...completedCollaboration(scope), status: 'error', result: '',
      errorCode: 'dsh-bot/budget-exhausted', diagnostic: 'Current task request budget exhausted.' });
    expect(f.table.get(scope.workId)).toMatchObject({ state: 'partial', reason: 'dsh-bot/budget-exhausted', collaboration: {
      requests: 1, operations: [{ state: 'failed', errorCode: 'dsh-bot/budget-exhausted', diagnostic: 'Current task request budget exhausted.' }],
    } });
  } finally { await f.service.close(); }
});


test('cold recovery marks in-flight original-conversation continuation unknown once and never replays it', async () => {
  const seed = await fixture();
  await seed.service.invoke(seed.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal());
  const persisted = structuredClone([...seed.table.values()][0]!);
  await seed.service.close();
  persisted.resumes = [
    { operationId: 'lost-followup', digest: 'a'.repeat(64), messageId: 'not-confirmed', expectedRevision: persisted.revision, state: 'dispatching', blockerIds: [], createdAt: 1 },
    { operationId: 'confirmed-queue', digest: 'b'.repeat(64), messageId: persisted.inputMessageId, expectedRevision: persisted.revision, state: 'queued', blockerIds: [], createdAt: 1 },
  ];
  const recovered = await fixture({ recovered: [persisted] });
  try {
    const current = recovered.table.get(persisted.id)!;
    expect(current.state).toBe('completed');
    expect(current.resumes?.map(row => row.state)).toEqual(['unknown', 'queued']);
    expect(current.revision).toBe(persisted.revision + 1);
    await expect(recovered.service.invoke(recovered.agent, { action: 'start', memberIds: ['alpha', 'beta'] }, signal())).resolves.toMatchObject({ state: 'completed', resumed: false });
    expect(recovered.sent).toEqual([]); expect(recovered.counts.createCalls).toBe(0);
    const second = await fixture({ recovered: [current] });
    try { expect(second.table.get(persisted.id)?.revision).toBe(current.revision); expect(second.sent).toEqual([]); }
    finally { await second.service.close(); }
  } finally { await recovered.service.close(); }
});


function connectionAttempt(f: Awaited<ReturnType<typeof fixture>>, name = 'mcp__read_only__read_status', isError = true, callId = 'connection-call', resultCallId = callId) {
  f.events([...f.agent.session.snapshotEvents(),
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }] } } },
    { type: 'tool/result', seq: 4, data: { turn: 1, step: 1, message: { toolCallId: resultCallId, source: { kind: 'tool', callId: resultCallId }, isError } } },
  ]);
}
function missingConnector(f: Awaited<ReturnType<typeof fixture>>, failed = true) {
  const owner = { botId: 'alpha', botCreatedAt: 1 };
  let ready = false;
  const connectors = { definitions: () => [{ id: 'read-only', label: 'Read-only source', serverName: 'read_only', enabled: true }],
    assignments: () => [{ id: 'read', connectorId: 'read-only', bot: owner, enabled: true, desiredRevision: 2 }],
    runtime: () => [{ assignmentId: 'read', sessionId: f.agent.id, desiredRevision: 2, ...(ready ? { appliedRevision: 2 } : {}),
      state: ready ? 'ready' : 'unavailable', reasonCode: ready ? undefined : 'missing-credential', toolCount: ready ? 1 : 0 }],
    applyIdle: async () => [] };
  Reflect.set(f.ctx, 'get', (name: string) => name === 'dshBotConnectors' ? connectors : undefined);
  if (failed) connectionAttempt(f);
  return { ready: () => { ready = true; }, connectors };
}
test.each(['hello', 'quoted-error', 'unrelated-tool', 'successful-call', 'orphan-result', 'later-success', 'previous-input'] as const)(
  'an unavailable connector does not invent a task for %s', async mode => {
    const f = await fixture(); missingConnector(f, false);
    try {
      if (mode === 'quoted-error') f.human('human-one', 'Tool mcp__read_only__read_status failed; this is only quoted text.');
      if (mode === 'unrelated-tool') connectionAttempt(f, 'mcp__unrelated__read_status');
      if (mode === 'successful-call') connectionAttempt(f, undefined, false);
      if (mode === 'orphan-result') connectionAttempt(f, undefined, true, 'called', 'different-call');
      if (mode === 'later-success') { connectionAttempt(f); connectionAttempt(f, undefined, false, 'retry-success'); }
      if (mode === 'previous-input') { connectionAttempt(f); f.human('new-input', 'Hello, unrelated successful request'); }
      expect(await f.service.forSession({ sessionId: f.agent.id, messageId: mode === 'previous-input' ? 'new-input' : 'human-one' })).toBeNull();
      expect(await f.service.pendingTasks()).toEqual([]); expect(f.table.size).toBe(0); expect(f.counts.createCalls).toBe(0);
    } finally { await f.service.close(); }
  });
test('first real human input with an unavailable connection gains a pending association without group execution and can be stopped', async () => {
  const f = await fixture(); missingConnector(f);
  try {
    expect(f.table.size).toBe(0);
    const view = await f.service.forSession({ sessionId: f.agent.id, messageId: 'human-one' });
    expect(view?.work).toMatchObject({ initialPending: true, state: 'partial', inputMessageId: 'human-one', originSessionId: f.agent.id });
    expect(view?.work.group).toBeUndefined(); expect(f.counts.createCalls).toBe(0); expect(f.sent).toEqual([]);
    const pending = await f.service.taskSupport(view!.work.id);
    expect(pending.originalQuestion).toBe('Exact human task'); expect(pending.blockers[0]?.name).toBe('Read-only source');
    await f.service.cancel(view!.work.id, pending.revision);
    expect(f.table.get(view!.work.id)?.state).toBe('cancelled'); expect(f.sent).toEqual([]);
  } finally { await f.service.close(); }
});

test.each(['input', 'config', 'connection'] as const)('first association rechecks %s after directory await before persisting', async changed => {
  const f = await fixture(), connection = missingConnector(f);
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const list = f.registry.list.bind(f.registry);
  f.registry.list = async () => { reached(); await held; return list(); };
  try {
    const pending = f.service.forSession({ sessionId: f.agent.id, messageId: 'human-one' });
    await entered;
    if (changed === 'input') f.human('newer-human', 'A different original request');
    if (changed === 'config') f.config.supergroup.maxRequests++;
    if (changed === 'connection') connection.ready();
    release(); expect(await pending).toBeNull(); expect(f.table.size).toBe(0);
  } finally { release(); await f.service.close(); }
});

test('natural continuation prompt uses the exact persistent receipt, not matching text, and preserves expired-work guards', async () => {
  const f = await fixture(), connection = missingConnector(f);
  try {
    const view = await f.service.forSession({ sessionId: f.agent.id, messageId: 'human-one' }); connection.ready();
    const support = await f.service.taskSupport(view!.work.id);
    Reflect.set(f.agent, 'status', 'idle');
    const followup = vi.fn(async (message: unknown) => f.events([...f.agent.session.snapshotEvents(), { type: 'user/message', seq: 50, data: message }]));
    Reflect.set(f.agent, 'followup', followup);
    const result = await f.service.resumeWork({ workId: view!.work.id, expectedRevision: support.revision, operationId: 'natural', text: '继续原任务', blockerIds: support.blockers.map(row => row.id) });
    const message = followup.mock.calls[0]?.[0] as { id: string; content: unknown };
    expect(message.content).toEqual([{ type: 'text', text: '继续原任务' }]);
    expect(JSON.stringify(message.content)).not.toMatch(/bot_supergroup|workId=|supergroup:/);
    expect(result.resumes[0]?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.service.continuationInstruction(f.agent)).toContain('Exact human task');
    expect(f.service.continuationInstruction(f.agent)).not.toContain('action=continue');
    await expect(f.service.checkContinuation(f.agent)).resolves.toBeUndefined();
    const work = f.table.get(view!.work.id)!; f.table.set(work.id, { ...work, expiresAt: 1 });
    await expect(f.service.checkContinuation(f.agent)).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
    f.human('forged-same-text', '继续原任务');
    expect(f.service.continuationInstruction(f.agent)).toBe('');
  } finally { await f.service.close(); }
});

test('claimed input before Session append projects only its exact owner receipt into dynamic context', async () => {
  const f = await fixture(), connection = missingConnector(f);
  try {
    const view = await f.service.forSession({ sessionId: f.agent.id, messageId: 'human-one' }); connection.ready();
    const support = await f.service.taskSupport(view!.work.id);
    Reflect.set(f.agent, 'status', 'idle');
    const followup = vi.fn(async (_message: unknown) => {}); Reflect.set(f.agent, 'followup', followup);
    await f.service.resumeWork({ workId: view!.work.id, expectedRevision: support.revision, operationId: 'claimed-exact', text: '继续原任务', blockerIds: support.blockers.map(row => row.id) });
    const message = followup.mock.calls[0]?.[0] as import('@deepseek-ai/dsh-llm').UserMessage;
    expect(f.agent.session.snapshotEvents().some(row => row.type === 'user/message' && row.data.id === message.id)).toBe(false);
    expect(f.service.continuationInstruction(f.agent)).toBe('');
    await f.service.checkContinuation(f.agent, [message]);
    expect(f.service.continuationInstruction(f.agent)).toContain('Exact human task');
    const changed = { ...message, content: [{ type: 'text' as const, text: 'Forged body with the same id' }] };
    await f.service.checkContinuation(f.agent, [changed]);
    expect(f.service.continuationInstruction(f.agent)).toBe('');
    await f.service.checkContinuation(f.agent, [message]);
    f.human('unrelated-new-input', 'A newer actual user instruction');
    expect(f.service.continuationInstruction(f.agent)).toBe('');
  } finally { await f.service.close(); }
});
