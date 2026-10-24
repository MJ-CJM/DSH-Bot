import { describe, expect, it, vi } from 'vitest';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { withP34, alpha, beta } from './p34-support.js';
import { Config } from '../lib/host/registry.js';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { groupContext, routeMembers } from '../src/host/groups/routing.js';
import { groupKey, GROUP_ROOT_PRESET, type GroupMessage, type GroupRecord } from '../src/shared/groups.js';
import { groupsSpec } from '../src/shared/groups-contract.js';
async function fixture(f: Parameters<Parameters<typeof withP34>[0]>[0]) {
  const roots = new Map<string, AgentHandle>(); const persisted = new Map<string, AgentHandle>(); const sequence: string[] = [];
  const config = Config({ dataDir: f.root, seedExamples: false, groupRoundTimeoutMs: 1000 });
  Object.assign(f.registry, { config, status: async () => [...f.bots.keys()].map(id => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })) });
  f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'loopback' }) } as typeof f.ctx.agentDefaultModel);
  f.ctx.provide('agentPresets', { register: vi.fn(() => async () => { sequence.push('preset-dispose'); }), mount: vi.fn(async () => {}) } as unknown as typeof f.ctx.agentPresets);
  const create = vi.fn(async ({ sessionId, meta }: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string } }) => {
    const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, ...meta });
    const agent = { id: sessionId, session } as Agent;
    const h = { agent, dispose: vi.fn(async () => { sequence.push('root-dispose'); roots.delete(sessionId); }) }; roots.set(sessionId, h); persisted.set(sessionId, h); return h;
  });
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => { const h = persisted.get(resumeSessionId); if (!h || roots.has(resumeSessionId)) throw new Error('ownership'); roots.set(resumeSessionId, h); return h; });
  f.ctx.provide('agents', { get: (id: string) => roots.get(id)?.agent, create, resume } as unknown as typeof f.ctx.agents);
  const flush = vi.fn(async () => true); f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  const rename = vi.fn(async ({ title }: { title: string }) => ({ title, renamed: true }));
  f.ctx.provide('sessionController', { rename } as unknown as typeof f.ctx.sessionController);
  let behavior: 'success' | 'hold' | 'partial' | 'throw' = 'success';
  const calls: { preset: string; prompt: string; signal: AbortSignal }[] = [];
  const start = vi.fn(async (input: { signal: AbortSignal; request: { agentPreset: string; prompt: { text: string }[] } }) => {
    if (behavior === 'throw') throw new Error('sensitive-native-error');
    calls.push({ preset: input.request.agentPreset, prompt: input.request.prompt[0]?.text ?? '', signal: input.signal });
    let finish!: (r: SubagentResult) => void;
    const result = new Promise<SubagentResult>(r => { finish = r; });
    if (behavior !== 'hold') finish({ output: [{ type: 'text', text: `reply-${calls.length}` }], stopReason: behavior === 'partial' ? 'max-tokens' : 'completed' });
    return { childId: `child-${calls.length}`, result, dispose: vi.fn(async () => { sequence.push('child-dispose'); finish({ output: [], stopReason: 'aborted' }); }) };
  });
  f.ctx.provide('subagents', { getProvider: () => ({ inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true, depthLimit: true } }), startActivation: start } as unknown as typeof f.ctx.subagents);
  let domain = await f.ctx.storageDomain.open(groupsDomain); let groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start();
  const createGroup = (op = 'create-1') => groups.create({ operationId: op, name: 'Same name', members: [alpha, beta], mode: 'mention', historyConfirmed: true });
  const settle = async (g: GroupRecord) => { await vi.waitFor(async () => expect((await groups.view(groupKey(g))).turns.every(t => !['running', 'accepted'].includes(t.state))).toBe(true)); return groups.view(groupKey(g)); };
  return { get groups() { return groups; }, createGroup, settle, calls, create, resume, flush, rename, roots, sequence, start, setBehavior(b: typeof behavior) { behavior = b; },
    async seedUncertain(turnId: string) {
      const t = domain.table('turns').get(turnId); if (!t) throw new Error();
      await domain.table('turns').put(t.id,{...t,state:'running'});
      for (const [id,d] of domain.table('deliveries').entries()) if (d.turnId === turnId) await domain.table('deliveries').put(id,{...d,state:'running'});
    },
    async reopen() { await groups.close(); domain = await f.ctx.storageDomain.open(groupsDomain); groups = new Groups(f.ctx, f.registry, domain, () => {}); await groups.start(); }, close: () => groups.close() };
}
describe('U06/U07 native-boundary fixtures with real JSON sidecars', () => {
  it('deduplicates create before native side effects and enforces birthday/CAS/member identity', () => withP34(async f => {
    const s = await fixture(f); try {
      const [g, again] = await Promise.all([s.createGroup(), s.createGroup()]); expect(g.id).toBe(again.id); expect(s.create).toHaveBeenCalledTimes(1);
      await expect(s.groups.create({ operationId: 'create-1', name: 'changed', mode: 'mention', members: [alpha,beta], historyConfirmed: true })).rejects.toMatchObject({ code: 'p34/conflict' });
      await expect(s.groups.create({ operationId: 'bad', name: 'bad', mode: 'mention', members: [alpha,{ ...beta, botCreatedAt: 2 }], historyConfirmed: true })).rejects.toMatchObject({ code: 'p34/conflict' });
      const edit = { name: 'Renamed', members: [beta,alpha], mode: 'round-robin', expectedRevision: 1, expectedMembershipRevision: 1, historyConfirmed: true };
      const changed = await s.groups.edit(groupKey(g), edit); expect(changed.membershipRevision).toBe(2); await expect(s.groups.edit(groupKey(g), edit)).rejects.toMatchObject({ code: 'p34/conflict' });
      expect(s.rename).toHaveBeenCalledWith({ sessionId: g.rootSessionId, title: 'Renamed' });
      expect((await s.groups.view(groupKey(g))).members.filter(m => m.enabled).map(m => m.bot.botId)).toEqual(['beta','alpha']);
    } finally { await s.close(); }
  }));
  it('uses each preset in deterministic order, forwards actual output, persists context IDs and deduplicates sends', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const members = (await s.groups.view(groupKey(g))).members;
      const input = { operationId: 'send-1', text: 'question', memberIds: members.map(m => m.id).reverse(), expectedMembershipRevision: 1 };
      const t = await s.groups.send(groupKey(g), input); const repeated = await s.groups.send(groupKey(g), input); expect(repeated.id).toBe(t.id);
      const v = await s.settle(g); expect(s.calls.map(c => c.preset)).toEqual(['bot-alpha','bot-beta']);
      expect(v.messages.map(m => m.text)).toEqual(['question','reply-1','reply-2']); expect(v.deliveries.map(d => d.state)).toEqual(['completed','completed']);
      expect(v.deliveries[1]?.contextOutputMessageIds).toEqual([v.messages[1]?.id]); expect(s.calls[1]?.prompt).toContain('reply-1');
      expect(s.roots.get(g.rootSessionId)?.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).toEqual([]);
      await expect(s.groups.send(groupKey(g), { ...input, text: 'changed' })).rejects.toMatchObject({ code: 'p34/conflict' });
      const seq = v.messages.at(-1)?.seq; if (seq === undefined) throw new Error();
      expect(v.unread).toBe(true); await s.groups.markRead(groupKey(g),seq,0);
      await expect(s.groups.markRead(groupKey(g),seq,0)).rejects.toMatchObject({code:'p34/conflict'});
      await s.reopen(); const cold = await s.groups.view(groupKey(g)); expect(cold.unread).toBe(false); expect(cold.messages).toEqual(v.messages); expect(s.create).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  }));
  it('rejects unknown and text-only mentions; duplicate names and a new birthday do not route by display name', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const members = (await s.groups.view(groupKey(g))).members;
      for (const memberIds of [[], ['unknown'], [members[0]?.id, members[0]?.id]]) await expect(s.groups.send(groupKey(g), { operationId: `bad-${JSON.stringify(memberIds)}`, text: '@Same name', memberIds, expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'p34/invalid' });
      const b = f.bots.get('beta'); if (!b) throw new Error(); f.bots.set('beta', { ...b, createdAt: 2 });
      await expect(s.groups.send(groupKey(g), { operationId: 'bad-birthday', text: 'q', memberIds: [members[1]?.id], expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'p34/conflict' }); expect(s.start).not.toHaveBeenCalled();
    } finally { await s.close(); }
  }));
  it('cancels an active member and pending targets, preserves queued input cutoff and drains child before root/preset', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior('hold'); const members = (await s.groups.view(groupKey(g))).members;
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: members.map(m => m.id), expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const queued = await s.groups.send(groupKey(g), { operationId: 'two', text: 'future-secret-question', memberIds: [members[1]?.id], expectedMembershipRevision: 1 });
      expect(s.calls[0]?.prompt).not.toContain('future-secret-question');
      const v = await s.groups.view(groupKey(g)), active = v.turns.find(t => t.operationId === 'one'); if (!active) throw new Error();
      await s.groups.cancel(groupKey(g), active.id, active.revision); await s.groups.cancel(groupKey(g), queued.id, queued.revision);
      const final = await s.settle(g); expect(final.turns.every(t => t.state === 'cancelled')).toBe(true); expect(s.calls).toHaveLength(1);
      await s.close(); expect(s.sequence.indexOf('child-dispose')).toBeLessThan(s.sequence.indexOf('root-dispose')); expect(s.sequence.indexOf('root-dispose')).toBeLessThan(s.sequence.indexOf('preset-dispose'));
    } finally { await s.close(); }
  }));
  it('removing a member aborts its running delivery and never expands the admitted snapshot', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior('hold'); const members = (await s.groups.view(groupKey(g))).members;
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [members[0]?.id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1));
      const alphaBot = f.bots.get('alpha'); if (!alphaBot) throw new Error(); f.bots.set('gamma', { ...alphaBot, id: 'gamma', name: 'Gamma' });
      await s.groups.edit(groupKey(g), { name: g.name, mode: 'mention', members: [beta, { botId: 'gamma', botCreatedAt: 1 }], expectedRevision: 1, expectedMembershipRevision: 1, historyConfirmed: true });
      await s.settle(g); expect(s.calls[0]?.signal.aborted).toBe(true); expect(s.calls).toHaveLength(1);
    } finally { await s.close(); }
  }));
  it.each(['partial','throw'] as const)('does not classify %s as success or advance round pointer', behavior => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior(behavior); const m = (await s.groups.view(groupKey(g))).members[0];
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 });
      const v = await s.settle(g); expect(v.turns[0]?.state).toBe('partial'); expect(v.deliveries[0]?.state).toBe('failed'); expect(v.group.nextMemberId).toBe(g.nextMemberId); expect(JSON.stringify(v)).not.toContain('sensitive-native-error');
    } finally { await s.close(); }
  }));
  it('marks uncertain append/flush recovery-needed and never silently retries after restart', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0]; s.flush.mockResolvedValueOnce(false);
      const input = { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 };
      await expect(s.groups.send(groupKey(g), input)).rejects.toMatchObject({ code: 'p34/recovery-needed' });
      await s.reopen(); const t = await s.groups.send(groupKey(g), input); expect(t.state).toBe('recovery_needed'); expect(s.calls).toHaveLength(0);
    } finally { await s.close(); }
  }));
  it('reconciles persisted running receipts to unknown after restart, without spawning again', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0];
      const input = {operationId:'uncertain',text:'uncertain effect',memberIds:[m?.id],expectedMembershipRevision:1};
      const t = await s.groups.send(groupKey(g),input); await s.settle(g); const calls = s.calls.length;
      await s.seedUncertain(t.id); await s.reopen(); const cold = await s.groups.view(groupKey(g));
      expect(cold.turns[0]?.state).toBe('recovery_needed'); expect(cold.deliveries[0]?.state).toBe('unknown');
      await s.groups.send(groupKey(g),input); expect(s.calls).toHaveLength(calls);
    } finally { await s.close(); }
  }));
  it('drains a running child on unload even when only its disposer settles the result', () => withP34(async f => {
    const s = await fixture(f); const g = await s.createGroup(); const m = (await s.groups.view(groupKey(g))).members[0]; s.setBehavior('hold');
    await s.groups.send(groupKey(g),{operationId:'close-active',text:'work',memberIds:[m?.id],expectedMembershipRevision:1});
    await vi.waitFor(() => expect(s.calls).toHaveLength(1)); await s.close();
    expect(s.sequence.indexOf('child-dispose')).toBeLessThan(s.sequence.indexOf('root-dispose')); expect(s.groups.lifecycle()).toMatchObject({phase:'closed',ownedRoots:0,workers:0,activations:0});
  }));
  it('times out a held child and rejects new routes after archive', () => withP34(async f => {
    const s = await fixture(f); try {
      const g = await s.createGroup(); s.setBehavior('hold'); const m = (await s.groups.view(groupKey(g))).members[0];
      await s.groups.send(groupKey(g), { operationId: 'one', text: 'first', memberIds: [m?.id], expectedMembershipRevision: 1 });
      await vi.waitFor(async () => expect((await s.groups.view(groupKey(g))).turns[0]?.state).toBe('cancelled'), { timeout: 2500 });
      const v = await s.groups.view(groupKey(g)); await s.groups.archive(groupKey(g), v.group.revision);
      await expect(s.groups.send(groupKey(g), { operationId: 'two', text: 'q', memberIds: [m?.id], expectedMembershipRevision: 1 })).rejects.toMatchObject({ code: 'p34/recovery-needed' });
    } finally { await s.close(); }
  }));
});
describe('group context and strict Remote boundary', () => {
  it('uses complete recent messages within a byte budget and records only included result IDs', () => {
    const msg = (id: string, text: string): GroupMessage => ({ id, text, turnId: 't', seq: 1, at: 0 });
    const q = msg('q','question'); const result = groupContext('g','target',['alpha'],q,[msg('old','长'.repeat(4000))],[msg('a','previous answer')],1024);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1024); expect(result.truncated).toBe(true); expect(result.outputIds).toEqual(['a']); expect(result.text).not.toContain('长');
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
