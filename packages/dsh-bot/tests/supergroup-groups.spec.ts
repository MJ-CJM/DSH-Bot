import { describe, expect, it, vi } from 'vitest';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { Serial, need } from '../src/host/common/operations.js';
import { groupRecordSchema } from '../src/shared/groups.js';
import type { GroupKey, GroupRecord } from '../src/shared/groups.js';
import type { GroupState } from '../src/host/groups/state.js';
import { checkSupergroup, checkSupergroupEnqueue, groupReaders, reserveSupergroupRequest, supergroupMetadata, validateSupergroupAuthority,
  type SupergroupAuthority } from '../src/host/groups/supergroup-admission.js';
import { getGroupWorkerBinding, installWorkerTools, isSupergroupWorker, workerReservations, type WorkerBinding } from '../src/host/groups/worker-tool.js';
import type { GroupTurnRunner } from '../src/host/groups/turn-runner.js';
import { withIntegrations, alpha, beta } from './integration-support.js';

function fixture() {
  const pool = ['owner', 'expert', 'later'].map((botId, index) => ({ botId, botCreatedAt: index + 1 }));
  const owner = need(pool[0]);
  const session = Session.create(SessionId('main'), undefined, { version: 4, id: SessionId('main'), createdAt: 1, isSeeded: false });
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Exact human report' }] });
  session.append('user/message', message, { surfaceOp: 'append' });
  const origin = { id: session.id, session } as Agent;
  const authority: SupergroupAuthority = { workId: 'work', origin, messageId: message.id, owner, readers: pool,
    expiresAt: Date.now() + 60000, maxRequests: 1, check: async () => {} };
  const group = groupRecordSchema.parse({ id: 'group', operationId: 'create', createDigest: 'fixture', createdAt: 1, updatedAt: 1,
    schemaVersion: 1, name: 'Scope test', rootSessionId: 'root', rootPresetId: 'dsh-bot-group-root', cwd: '/fixture',
    mode: 'natural', membershipRevision: 1, revision: 1, archived: false, state: 'ready', supergroup: supergroupMetadata(authority) });
  const budgets = new Map<string, { group: GroupKey; count: number }>();
  const authorities = new Map([[group.id, authority]]);
  const state = { queue: new Serial(), check() {}, record: () => group, supergroupAuthorities: authorities,
    ctx: { agents: { get: (id: string) => id === origin.id ? origin : undefined } },
    registry: { mainSessions: { find: async () => ({ sessionId: origin.id }) } },
    async bot(key: typeof owner) { if (!pool.some(current => JSON.stringify(current) === JSON.stringify(key))) throw Error('stale Bot'); return key; },
    table: () => ({ get: (id: string) => budgets.get(id), put: async (id: string, row: { group: GroupKey; count: number }) => { budgets.set(id, row); } }),
    members: () => pool.slice(0, 2).map(bot => ({ bot, enabled: true })),
  } as unknown as GroupState;
  return { state, group, authority, session, pool, budgets, authorities };
}

describe('Supergroup checked Groups admission', () => {
  it('retains permitted future readers separately from active roster', () => {
    const f = fixture();
    expect(groupReaders(f.state, f.group)).toEqual(f.pool);
    expect(groupReaders(f.state, { ...f.group, supergroup: undefined })).toEqual(f.pool.slice(0, 2));
  });
  it('reads the exact real human input and refuses a different message reference', async () => {
    const f = fixture();
    expect((await validateSupergroupAuthority(f.state, f.authority)).text).toBe('Exact human report');
    await expect(validateSupergroupAuthority(f.state, { ...f.authority, messageId: 'invented' })).rejects.toThrow('approval-denied');
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New human request' }] }), { surfaceOp: 'append' });
    await expect(validateSupergroupAuthority(f.state, f.authority)).rejects.toThrow('approval-denied');
  });
  it('fails closed on expiry, changed Bot generation, revoked mode, or expanded readers', async () => {
    const f = fixture();
    await expect(validateSupergroupAuthority(f.state, { ...f.authority, expiresAt: Date.now() - 1 })).rejects.toThrow('approval-denied');
    await expect(validateSupergroupAuthority(f.state, { ...f.authority, readers: [need(f.pool[0]), { botId: 'expert', botCreatedAt: 99 }] })).rejects.toThrow('stale Bot');
    await expect(validateSupergroupAuthority(f.state, { ...f.authority, check: async () => { throw Error('mode revoked'); } })).rejects.toThrow('mode revoked');
    await expect(validateSupergroupAuthority(f.state, { ...f.authority, readers: [...f.pool, { botId: 'outside', botCreatedAt: 1 }] }, f.group)).rejects.toThrow('approval-denied');
  });
  it('does not restore execution authority from a persisted group record', async () => {
    const f = fixture(); f.authorities.clear();
    await expect(checkSupergroup(f.state, f.group)).rejects.toThrow('approval-denied');
  });
  it('reserves actual requests durably and preserves the counter across authority replacement', async () => {
    const f = fixture();
    await reserveSupergroupRequest(f.state, f.group);
    expect(f.budgets.get(f.group.id)?.count).toBe(1);
    f.authorities.set(f.group.id, { ...f.authority });
    await expect(reserveSupergroupRequest(f.state, f.group)).rejects.toThrow('approval-denied');
    expect(f.budgets.get(f.group.id)?.count).toBe(1);
  });
  it('charges the same work budget as direct collaboration without entering the Groups queue', async () => {
    const f = fixture(), workQueue = new Serial();
    // A prior direct Bot exchange has already consumed one request.
    let used = 1;
    f.authority.maxRequests = 3;
    f.authority.requestsUsed = () => used;
    f.authority.reserveRequest = () => workQueue.run(async () => {
      if (used >= 3) throw new Error('work-budget-exhausted');
      used++;
    });
    const groupQueue = vi.spyOn(f.state.queue, 'run').mockImplementation(() => { throw new Error('Groups queue must not be entered'); });
    expect(() => checkSupergroupEnqueue(f.state, f.group)).not.toThrow();
    await Promise.all([reserveSupergroupRequest(f.state, f.group), reserveSupergroupRequest(f.state, f.group)]);
    expect(used).toBe(3);
    expect(groupQueue).not.toHaveBeenCalled();
    expect(f.budgets.size).toBe(0);
    expect(() => checkSupergroupEnqueue(f.state, f.group)).toThrow('approval-denied');
    await expect(reserveSupergroupRequest(f.state, f.group)).rejects.toThrow('work-budget-exhausted');
    expect(used).toBe(3);
  });
  it('never calls a shared budget callback after revocation or authority replacement', async () => {
    const f = fixture(), reserve = vi.fn(async () => {});
    f.authority.reserveRequest = reserve;
    f.authority.requestsUsed = () => 0;
    f.authority.check = async () => { throw new Error('mode revoked'); };
    await expect(reserveSupergroupRequest(f.state, f.group)).rejects.toThrow('mode revoked');
    expect(reserve).not.toHaveBeenCalled();
    f.authority.check = async () => { f.authorities.set(f.group.id, { ...f.authority }); };
    await expect(reserveSupergroupRequest(f.state, f.group)).rejects.toThrow('approval-denied');
    expect(reserve).not.toHaveBeenCalled();
  });
  it('requires a valid shared work counter at synchronous enqueue admission', () => {
    const f = fixture();
    f.authority.reserveRequest = async () => {};
    expect(() => checkSupergroupEnqueue(f.state, f.group)).toThrow('approval-denied');
    for (const invalid of [-1, NaN, 0.5, 1]) {
      f.authority.requestsUsed = () => invalid;
      expect(() => checkSupergroupEnqueue(f.state, f.group)).toThrow('approval-denied');
    }
    f.authority.requestsUsed = () => 0;
    expect(() => checkSupergroupEnqueue(f.state, f.group)).not.toThrow();
  });
  it('shows only scoped workers a generation-checked expert directory and disposes it with the tools', () => withIntegrations(async f => {
    const gamma = { ...need(f.bots.get('beta')), id: 'gamma', createdAt: 3, name: 'Report verifier', description: 'Checks evidence {{literal_data}}',
      persona: { prefix: 'PRIVATE_PERSONA_CANARY' } };
    f.bots.set('gamma', gamma);
    f.bots.set('outsider', { ...gamma, id: 'outsider', name: 'PRIVATE_OUTSIDE_SCOPE' });
    Object.assign(f.registry, {
      directorySnapshot: () => [...f.bots.values()].map(bot => ({ id: bot.id, name: bot.name, description: bot.description, privateHistory: 'PRIVATE_HISTORY_CANARY' })),
      onboardingSnapshot: (id: string, createdAt: number) => {
        const bot = f.bots.get(id); return bot?.createdAt === createdAt ? bot : undefined;
      },
    });
    const base = { ...fixture().group, rootSessionId: 'group-root' };
    const scoped = { ...base, id: 'scoped', supergroup: { ...need(base.supergroup), readers: [alpha, beta, { botId: 'gamma', botCreatedAt: 3 }] } };
    const plain = { ...base, id: 'plain', supergroup: undefined };
    const groupRows = new Map<string, GroupRecord>([['scoped', scoped], ['plain', plain]]);
    const turns = new Map([['scoped-turn', { group: { groupId: scoped.id, groupCreatedAt: scoped.createdAt } }], ['plain-turn', { group: { groupId: plain.id, groupCreatedAt: plain.createdAt } }]]);
    const deliveries = new Map([['scoped-delivery', { bot: alpha }], ['plain-delivery', { bot: alpha }]]);
    const workers = new Map<string, WorkerBinding>();
    const state = { ctx: f.ctx, registry: f.registry, workers, stopped: false, cancelledTurns: new Set(),
      bot: (key: typeof alpha) => f.registry.get(key.botId),
      table: (name: string) => name === 'groups' ? groupRows : name === 'turns' ? turns : deliveries,
    } as unknown as GroupState;
    const subjects = ['scoped', 'plain'].map(kind => {
      const worker = f.createAgent(`${kind}-child`);
      worker.value.session = Session.create(SessionId(`${kind}-child`), undefined, { version: 4, id: SessionId(`${kind}-child`),
        createdAt: 1, isSeeded: false, parentSession: SessionId('group-root'), agentPreset: 'bot-alpha' });
      const binding: WorkerBinding = { turnId: `${kind}-turn`, deliveryId: `${kind}-delivery`, childId: worker.agent.id,
        rootId: 'group-root', presetId: 'bot-alpha', audience: [alpha, beta], automaticSupergroup: true, isActive: () => true };
      workers.set(worker.agent.id, binding); workerReservations.set(worker.agent.id, binding);
      return worker;
    });
    const stop = installWorkerTools(state, {} as GroupTurnRunner);
    const scopedWorker = need(subjects[0]), plainWorker = need(subjects[1]);
    // The Bot preset reads this boundary before agent/created installs worker tools.
    expect(isSupergroupWorker(scopedWorker.agent)).toBe(true);
    expect(getGroupWorkerBinding(scopedWorker.agent)?.automaticSupergroup).toBe(true);
    expect(isSupergroupWorker(plainWorker.agent)).toBe(false);
    expect(getGroupWorkerBinding(plainWorker.agent)?.automaticSupergroup).toBe(false);
    turns.set('scoped-turn', { group: { groupId: scoped.id, groupCreatedAt: scoped.createdAt + 1 } });
    expect(isSupergroupWorker(scopedWorker.agent)).toBe(false);
    turns.set('scoped-turn', { group: { groupId: scoped.id, groupCreatedAt: scoped.createdAt } });
    const prompt = async (worker: typeof subjects[number]) =>
      (await worker.agent.ctx.systemPrompt.assemble({ scope: worker.agent, agent: worker.agent })).contexts
        .find(context => context.name === 'dsh-bot:supergroup-experts');
    try {
      for (const worker of subjects) {
        await worker.scope.ctx.plugin({ inject: ['tools', 'systemPrompt'], apply(ctx) { worker.value.ctx = ctx; } }).await();
        await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', { agent: worker.agent, source: 'startup' });
      }
      const directory = await prompt(scopedWorker);
      expect(directory?.text).toContain('"id":"gamma"');
      expect(directory?.text).toContain('Report verifier');
      expect(directory?.text).toContain('{{literal_data}}');
      expect(directory?.interpolate).toBe(false);
      expect(directory?.text).not.toContain('"id":"alpha"');
      expect(directory?.text).not.toContain('PRIVATE_');
      expect(await prompt(plainWorker)).toBeUndefined();
      const tool = scopedWorker.agent.ctx.tools.get('group_message', scopedWorker.agent);
      expect(tool?.description).toContain('action=request-expert');
      const normalTool = plainWorker.agent.ctx.tools.get('group_message', plainWorker.agent);
      expect(normalTool?.description).not.toContain('action=request-expert');
      f.bots.set('gamma', { ...gamma, createdAt: 4 });
      expect((await prompt(scopedWorker))?.text).not.toContain('"id":"gamma"');
      stop();
      expect(await prompt(scopedWorker)).toBeUndefined();
      expect(isSupergroupWorker(scopedWorker.agent)).toBe(false);
    } finally {
      stop();
      for (const worker of subjects) { workerReservations.delete(worker.agent.id); worker.scope.dispose(); }
    }
  }));
});
