import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { Session, type SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply as applyHost, Config as HostConfig } from '../lib/host/index.js';
import { Config as RegistryConfig } from '../src/host/registry-config.js';
import { groupContext, groupParticipantLabel } from '../src/host/groups/routing.js';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { GroupState } from '../src/host/groups/state.js';
import { GroupRoots } from '../src/host/groups/roots.js';
import { GroupExportReview } from '../src/host/groups/export-review.js';
import { ProactiveService } from '../src/host/proactive/service.js';
import { need } from '../src/host/common/operations.js';
import { GROUP_ROOT_PRESET, groupKey, type GroupDelivery, type GroupMessage, type GroupRecord, type GroupTurn } from '../src/shared/groups.js';
import { withIntegrations, alpha, beta } from './integration-support.js';
import { withFacility } from './fixtures/registry.js';
import { openBotStores } from '../lib/host/store.js';

function poisonedError(sentinel: string) {
  return Object.assign(new Error(`raw secret leak: ${sentinel} /Users/private/token`), {
    name: `PoisonedName-${sentinel}`,
    code: `POISONED-CODE-${sentinel}`,
  });
}

async function groupFixture(
  f: Parameters<Parameters<typeof withIntegrations>[0]>[0],
  overrides: Partial<ReturnType<typeof RegistryConfig>> = {},
) {
  const roots = new Map<string, AgentHandle>();
  const persisted = new Map<string, AgentHandle>();
  const sequence: string[] = [];
  const config = RegistryConfig({
    dataDir: f.root,
    seedExamples: false,
    groupRoundTimeoutMs: 10_000,
    groupTaskTimeoutMs: 10_000,
    ...overrides,
  });
  Object.assign(f.registry, {
    config,
    status: async () => [...f.bots.keys()].map(id => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })),
  });
  const workspaces = new Map<string, { id: string; path: string; sessionIds: SessionId[]; attachSession(id: SessionId): Promise<void> }>();
  const workspaceRegistry = {
    create: vi.fn(async (path: string) => {
      let ws = workspaces.get(path);
      if (!ws) {
        ws = {
          id: `ws-${workspaces.size}`,
          path,
          sessionIds: [],
          async attachSession(id: SessionId) {
            if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
          },
        };
        workspaces.set(path, ws);
      }
      return ws;
    }),
  };
  f.ctx.provide('workspaceRegistry', workspaceRegistry as never);
  Object.assign(f.registry, {
    ensureBotsWorkspace: async () => {
      const ws = await workspaceRegistry.create(f.root);
      return { path: ws.path, workspaceId: ws.id };
    },
  });
  f.ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'synthetic', model: 'loopback' }),
  } as typeof f.ctx.agentDefaultModel);
  f.ctx.provide('agentPresets', {
    register: vi.fn(() => async () => { sequence.push('preset-dispose'); }),
    mount: vi.fn(async () => {}),
  } as unknown as typeof f.ctx.agentPresets);

  const create = vi.fn(async ({ sessionId, meta }: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string } }) => {
    const session = Session.create(sessionId, undefined, { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false, ...meta });
    let activity = Promise.resolve();
    const agent = {
      id: sessionId,
      session,
      ctx: f.ctx,
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: vi.fn(() => activity),
      followup: vi.fn((message: import('@deepseek-ai/dsh-llm').UserMessage) => {
        activity = (async () => {
          const turn = session.snapshotEvents().filter(e => e.type === 'turn/start').length + 1;
          session.append('turn/start', { turn });
          const { executeRootSetup } = await import('../src/host/groups/root-guard.js');
          try {
            await executeRootSetup(agent, [message], turn);
            session.append('turn/end', { turn, reason: { kind: 'completed' } });
          } catch {
            session.append('turn/end', { turn, reason: { kind: 'blocked' } });
          }
        })();
        void activity.catch(() => {});
      }),
    } as unknown as Agent;
    const handle = {
      agent,
      dispose: vi.fn(async () => {
        sequence.push('root-dispose');
        roots.delete(sessionId);
      }),
    };
    roots.set(sessionId, handle);
    persisted.set(sessionId, handle);
    return handle;
  });
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
    const handle = persisted.get(resumeSessionId);
    if (!handle || roots.has(resumeSessionId)) throw new Error('ownership');
    roots.set(resumeSessionId, handle);
    return handle;
  });
  f.ctx.provide('agents', { get: (id: string) => roots.get(id)?.agent, create, resume } as unknown as typeof f.ctx.agents);
  const flush = vi.fn(async () => true);
  f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  f.ctx.provide('sessionController', { rename: vi.fn(async ({ title }: { title: string }) => ({ title, renamed: true })) } as unknown as typeof f.ctx.sessionController);

  const calls: { preset: string; prompt: string; signal: AbortSignal }[] = [];
  let hold = false;
  let onStart: ((input: { childId: SessionId; signal: AbortSignal; request: { agentPreset: string; prompt: { text: string }[] } }) => Promise<SubagentResult>) | undefined;
  const drainDescendants = vi.fn(async () => {});
  const startActivation = vi.fn(async (input: { childId: SessionId; signal: AbortSignal; request: { agentPreset: string; prompt: { text: string }[] } }) => {
    calls.push({ preset: input.request.agentPreset, prompt: input.request.prompt[0]?.text ?? '', signal: input.signal });
    let finish!: (r: SubagentResult) => void;
    const result = new Promise<SubagentResult>(resolve => { finish = resolve; });
    if (onStart) void onStart(input).then(finish, () => finish({ output: [], stopReason: 'error' }));
    else if (!hold) finish({ output: [{ type: 'text', text: `reply-${calls.length}` }], stopReason: 'completed' });
    return {
      childId: input.childId,
      result,
      dispose: vi.fn(async () => {
        sequence.push('child-dispose');
        finish({ output: [], stopReason: 'aborted' });
      }),
    };
  });
  const prompt = vi.fn(async () => ({ messageId: 'native-followup' }));
  f.ctx.provide('subagents', {
    drainDescendants,
    drainChildren: vi.fn(async () => {}),
    interrupt: vi.fn(),
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentPreset: true, agentOptions: true, depthLimit: true } }),
    startActivation,
    prompt,
  } as unknown as typeof f.ctx.subagents);

  const domain = await f.ctx.storageDomain.open(groupsDomain);
  const groups = new Groups(f.ctx, f.registry, domain, () => {});
  await groups.start();
  const settle = async (g: GroupRecord) => {
    await vi.waitFor(
      async () => expect((await groups.view(groupKey(g))).turns.every(t => !['running', 'accepted'].includes(t.state))).toBe(true),
      { timeout: 5000 },
    );
    return groups.view(groupKey(g));
  };
  return {
    domain,
    groups,
    calls,
    flush,
    drainDescendants,
    roots,
    sequence,
    prompt,
    setHold(v: boolean) { hold = v; },
    setOnStart(fn: NonNullable<typeof onStart>) { onStart = fn; },
    settle,
    close: () => groups.close(),
  };
}

describe('Issue #57 Area 1: Group context budget pre-flight vs delivery alignment', () => {
  it('truncates oversized replyTo history entries cleanly on Unicode boundaries or evicts when question alone fills budget', () => {
    const msg = (id: string, text: string, replyTo?: string): GroupMessage => ({ id, text, turnId: 't', seq: 1, at: 0, ...(replyTo ? { replyTo } : {}) });
    const largeReply = msg('parent', '🚀长'.repeat(600));
    const question = msg('q', 'Short follow-up question', 'parent');
    const truncated = groupContext('g', 'Target Bot', ['Target Bot (botId=alpha, memberId=m1)'], question, [largeReply], [largeReply], 1024);
    expect(Buffer.byteLength(truncated.text)).toBeLessThanOrEqual(1024);
    expect(truncated.truncated).toBe(true);
    const jsonLine = JSON.parse(truncated.text.slice(truncated.text.lastIndexOf('\n') + 1));
    expect(jsonLine.earlierContentOmitted).toBe(true);
    expect(jsonLine.history).toHaveLength(1);
    expect(jsonLine.history[0].id).toBe('parent');
    expect(jsonLine.history[0].text.length).toBeGreaterThan(0);
    // Ensure no broken surrogate pair at the truncation boundary.
    expect(jsonLine.history[0].text.endsWith('\uD83D')).toBe(false);

    // When question itself leaves no room for even minimal replyTo metadata, replyTo is evicted rather than throwing invalid.
    const fillerLen = 1024 - Buffer.byteLength(
      groupContext('g', 'Target Bot', ['Target Bot (botId=alpha, memberId=m1)'], msg('q2', '', 'parent'), [], [], 1024).text,
    ) - 10;
    const tightQuestion = msg('q2', 'x'.repeat(Math.max(1, fillerLen)), 'parent');
    const evicted = groupContext('g', 'Target Bot', ['Target Bot (botId=alpha, memberId=m1)'], tightQuestion, [largeReply], [largeReply], 1024);
    expect(Buffer.byteLength(evicted.text)).toBeLessThanOrEqual(1024);
    expect(evicted.truncated).toBe(true);
    const evictedJson = JSON.parse(evicted.text.slice(evicted.text.lastIndexOf('\n') + 1));
    expect(evictedJson.earlierContentOmitted).toBe(true);
    expect(evictedJson.history).toEqual([]);
  });

  it('rejects near-budget messages with targetRole/memoryStatusOnly/full labels in pre-flight before persisting turn', () => withIntegrations(async f => {
    const alphaBot = need(f.bots.get('alpha'));
    const betaBot = need(f.bots.get('beta'));
    f.bots.set('alpha', { ...alphaBot, name: 'Very Long Alpha Display Name For Budget Test' });
    f.bots.set('beta', { ...betaBot, name: 'Very Long Beta Display Name For Budget Test' });
    const s = await groupFixture(f, { groupContextMaxBytes: 1536 });
    try {
      const g = await s.groups.create({
        operationId: 'budget-group',
        name: 'Budget Alignment Group',
        members: [alpha, beta],
        mode: 'natural',
        memberRoles: [
          { bot: alpha, role: 'Detailed Security Auditor and Verification Specialist' },
          { bot: beta, role: 'Implementation Engineer' },
        ],
        historyConfirmed: true,
      });
      const key = groupKey(g);
      const members = (await s.groups.view(key)).members;
      const labels = [
        groupParticipantLabel(need(f.bots.get('alpha')), need(members[0]).id),
        groupParticipantLabel(need(f.bots.get('beta')), need(members[1]).id),
      ];
      const probe = (text: string, memoryStatusOnly: boolean, role?: string) => groupContext(
        g.name,
        need(f.bots.get('alpha')).name,
        labels,
        { id: '00000000-0000-4000-8000-000000000000', seq: 0, at: 0, text, turnId: 't', authorKind: 'user' },
        [],
        [],
        1536,
        role,
        memoryStatusOnly,
      );
      // Craft a message that would have passed the old naive pre-flight (short botIds, no role, no memoryStatusOnly)
      // but exceeds 1536 bytes when real labels + targetRole + memoryStatusOnly are included.
      const baseOverhead = Buffer.byteLength(probe('', true, 'Detailed Security Auditor and Verification Specialist').text);
      const overByRoleAndMemory = 'a'.repeat(1536 - baseOverhead + 40);
      await expect(s.groups.send(key, {
        operationId: 'over-memory-role',
        text: overByRoleAndMemory,
        memoryStatusOnly: true,
        expectedMembershipRevision: 1,
      })).rejects.toMatchObject({ code: 'dsh-bot/invalid' });
      expect((await s.groups.view(key)).turns).toEqual([]);
      expect(s.calls).toEqual([]);

      // Craft a message right at the real budget boundary (fits with full labels + targetRole + memoryStatusOnly) and verify delivery succeeds.
      const fitsText = 'b'.repeat(Math.max(1, 1536 - baseOverhead - 8));
      const accepted = await s.groups.send(key, {
        operationId: 'fits-memory-role',
        text: fitsText,
        memoryStatusOnly: true,
        expectedMembershipRevision: 1,
      });
      const settled = await s.settle(g);
      expect(settled.turns.find(t => t.id === accepted.id)?.state).not.toBe('recovery_needed');
      expect(s.calls).toHaveLength(2);
      expect(s.calls.every(c => Buffer.byteLength(c.prompt) <= 1536)).toBe(true);
    } finally { await s.close(); }
  }));

  it('delivers replies to large earlier messages without failing with OperationError(invalid)', () => withIntegrations(async f => {
    const s = await groupFixture(f, { groupContextMaxBytes: 1200 });
    try {
      const g = await s.groups.create({
        operationId: 'reply-budget-group',
        name: 'Reply Group',
        members: [alpha, beta],
        mode: 'natural',
        historyConfirmed: true,
      });
      const key = groupKey(g);
      // First turn produces a large bot reply (larger than half the 1200 byte context budget).
      s.setOnStart(async () => ({ output: [{ type: 'text', text: 'L'.repeat(900) }], stopReason: 'completed' }));
      await s.groups.send(key, { operationId: 'seed-large', text: 'Create large output', expectedMembershipRevision: 1 });
      const firstView = await s.settle(g);
      const largeMsg = need(firstView.messages.find(m => m.speaker?.bot.botId === 'alpha'));
      expect(largeMsg.text.length).toBe(900);

      // Reply with a substantial question (~250 bytes) referencing the 900-byte message: combined > 1200 bytes.
      s.setOnStart(async () => ({ output: [{ type: 'text', text: 'Delivered after truncation' }], stopReason: 'completed' }));
      const turn = await s.groups.send(key, {
        operationId: 'reply-large',
        text: 'Q'.repeat(250),
        replyTo: largeMsg.id,
        expectedMembershipRevision: 1,
      });
      const view = await s.settle(g);
      const delivery = need(view.deliveries.find(d => d.turnId === turn.id));
      expect(delivery.state).toBe('completed');
      expect(delivery.contextTruncated).toBe(true);
      expect(Buffer.byteLength(need(s.calls.at(-1)).prompt)).toBeLessThanOrEqual(1200);
    } finally { await s.close(); }
  }));

  it('proactive groupReview rejects artifacts exceeding groupContextMaxBytes before claim-group-review and redacts start errors', async () => {
    const warn = vi.fn();
    const change = vi.fn(async () => ({ kind: 'receipt', receipt: { commandId: 'c', status: 'committed' } }));
    const groupRecord: GroupRecord = {
      id: 'g1', operationId: 'op', createDigest: 'd', createdAt: 1, updatedAt: 1, schemaVersion: 1,
      name: 'Reviewers', rootSessionId: 'root-1', rootPresetId: GROUP_ROOT_PRESET, cwd: '/tmp',
      mode: 'natural', membershipRevision: 1, revision: 1, archived: false, state: 'ready',
    };
    const members = [
      { id: 'm1', group: groupKey(groupRecord), bot: alpha, order: 0, joinedAt: 1, enabled: true },
      { id: 'm2', group: groupKey(groupRecord), bot: beta, order: 1, joinedAt: 1, enabled: true },
    ];
    const startProactiveReview = vi.fn();
    const groups = {
      list: async () => [{ group: groupRecord, members, unavailableMemberIds: [], running: false, unread: false, readRevision: 0 }],
      startProactiveReview,
      waitForProactiveReview: async () => {},
      stopProactiveReviews: () => {},
    };
    const bots = new Map([
      ['alpha', { id: 'alpha', name: 'Alpha Reviewer', createdAt: 1, updatedAt: 10 }],
      ['beta', { id: 'beta', name: 'Beta Reviewer', createdAt: 1, updatedAt: 20 }],
    ]);
    const work = {
      ticketId: 'ticket-1',
      assignmentId: 'assign-1',
      revision: 1,
      state: 'accepted',
      title: 'T'.repeat(2500),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      target: { bot: alpha, provider: 'synthetic', model: 'loopback' },
    };
    const ctx = {
      logger: { warn, error: vi.fn(), info: vi.fn() },
      get: (key: string) => key === 'dshBotGroups' ? groups : undefined,
      dshBots: {
        config: { groupContextMaxBytes: 2048 },
        get: async (id: string) => bots.get(id),
      },
    } as unknown as Context;
    const service = new ProactiveService(ctx, {
      proactiveGroupReviewEnabled: true,
      proactiveGroupFollowUpEnabled: false,
      proactiveModelOutputTokens: 512,
    } as never, {} as never);
    Object.assign(service, {
      read: vi.fn(async () => ({ kind: 'work', work })),
      readWork: vi.fn(async () => ({ kind: 'work', work })),
      change,
      validateTarget: vi.fn(async () => {}),
    });

    // Artifact > 2048 (groupContextMaxBytes) but < 65536 (GROUP_TEXT_MAX_BYTES) fails before preview/claim.
    await expect(service.groupReview({
      ticketId: 'ticket-1',
      expectedRevision: 1,
      group: groupKey(groupRecord),
      memberIds: ['m1', 'm2'],
    })).rejects.toThrow('Full artifact exceeds group review size');
    expect(change).not.toHaveBeenCalled();
    expect(startProactiveReview).not.toHaveBeenCalled();

    // When within budget and startProactiveReview rejects with a poisoned error, redacted diagnostics are logged.
    work.title = 'Short review title';
    const preview = await service.groupReview({
      ticketId: 'ticket-1',
      expectedRevision: 1,
      group: groupKey(groupRecord),
      memberIds: ['m1', 'm2'],
    });
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') throw new Error('Expected preview');
    const sentinel = 'PROACTIVE-REVIEW-START-SENTINEL';
    startProactiveReview.mockRejectedValueOnce(poisonedError(sentinel));
    const outcome = await service.groupReview({
      ticketId: 'ticket-1',
      expectedRevision: 1,
      group: groupKey(groupRecord),
      memberIds: ['m1', 'm2'],
      reviewedDigest: preview.digest,
    });
    expect(outcome).toEqual({ kind: 'unknown' });
    expect(warn).toHaveBeenCalledWith('[dsh-bot] proactive group review dispatch failed', {
      ticketId: 'ticket-1', groupId: 'g1', phase: 'start-proactive-review', errorName: 'unknown',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    await service.close();
  });
});

describe('Issue #57 Area 2 & 3: Host log redaction & registry post-commit isolation', () => {
  it('redacts poisoned errors in host/index.ts startup and volatile settings handlers', async () => {
    const sentinel = 'HOST-INDEX-SECRET-SENTINEL';
    const poisoned = poisonedError(sentinel);
    const errorLog = vi.fn();
    const infoLog = vi.fn();
    const warnLog = vi.fn();
    const listeners = new Map<string, () => void>();
    const restart = vi.fn(async () => { throw poisoned; });
    const ctx = new Context();
    Object.assign(ctx, {
      logger: { error: errorLog, warn: warnLog, info: infoLog },
      typert: { register: () => () => {} },
      loader: { await: async () => { throw poisoned; } },
      storageDomain: { open: async () => { throw poisoned; } },
      agentPresets: { register: async () => async () => {}, list: async () => [] },
    });

    let current = HostConfig({ seedExamples: false, dataDir: '/tmp/dsh-bot-test' }).get();
    const volatile = { get: () => current } as ReturnType<typeof HostConfig>;
    const fork = ctx.plugin({
      apply(owner: Context) {
        Object.assign(owner.fiber, { restart });
        const origOn = owner.on.bind(owner);
        vi.spyOn(owner, 'on').mockImplementation(((event: string, listener: () => void) => {
          listeners.set(event, listener);
          return origOn(event as never, listener as never);
        }) as typeof owner.on);
        applyHost(owner, volatile);
      },
    });

    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith('[dsh-bot] startup failed', {
      phase: 'startup', errorName: 'unknown',
    }));

    // Trigger non-hot setting change so ctx.fiber.restart() rejects with poisoned error.
    current = HostConfig({ seedExamples: true, dataDir: '/tmp/dsh-bot-test' }).get();
    listeners.get('loader/volatile-update')?.();
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith('[dsh-bot] settings restart failed', {
      phase: 'settings-restart', errorName: 'unknown',
    }));

    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain(sentinel);
    await fork.dispose();
    await ctx.fiber.dispose();
  });

  it('redacts poisoned errors across registry startup, workspace, preset, reconcile, and listener failures, and isolates post-commit update/duplicate errors', async () => {
    const sentinel = 'REGISTRY-POISONED-SENTINEL';
    const poisoned = poisonedError(sentinel);

    // 1. Storage startup failure redaction in lifecycle.ts.
    await withFacility(async ({ ctx, root }) => {
      const errorLog = vi.spyOn(ctx.logger, 'error');
      const openSpy = vi.spyOn(ctx.storageDomain, 'open').mockRejectedValueOnce(poisoned);
      try {
        const { DshBotRegistry } = await import('../lib/host/registry.js');
        const fork = ctx.plugin(DshBotRegistry, RegistryConfig({ seedExamples: false, dataDir: root }));
        await fork.await();
        expect(errorLog).toHaveBeenCalledWith('[dsh-bot] startup failed', {
          botId: '*', phase: 'startup', errorName: 'unknown',
        });
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sentinel);
        await fork.dispose();
      } finally { openSpy.mockRestore(); }
    });

    // 2. Workspace startup, preset startup, reconcile, listeners, and post-commit update/duplicate isolation.
    await withFacility(async ({ ctx, start, presets, workspaces }) => {
      const warnLog = vi.spyOn(ctx.logger, 'warn');
      const errorLog = vi.spyOn(ctx.logger, 'error');
      const { registry: nativeWs } = await workspaces();
      const wsCreate = vi.spyOn(nativeWs, 'create').mockRejectedValueOnce(poisoned);

      // Seed one bot so startup preset acquisition runs and fails with poisoned error.
      const seed = await openBotStores(ctx);
      await seed.bots.create({ id: 'alpha', name: 'Alpha' });
      await seed.close();
      presets.beforeRegister = async def => {
        if (def.name === 'Alpha') throw poisoned;
      };
      const { registry } = await start();
      wsCreate.mockRestore();
      expect(warnLog).toHaveBeenCalledWith('[dsh-bot] Bots workspace startup failed', {
        phase: 'workspace-startup', errorName: 'unknown',
      });
      expect(errorLog).toHaveBeenCalledWith('[dsh-bot] preset startup failed', {
        botId: 'alpha', phase: 'preset-startup', errorName: 'unknown',
      });

      // Trigger reconcile failure with poisoned error (from presets.ts:39):
      // Make alpha healthy, then fail both replacement and rollback so alpha has no lease and failed=true.
      presets.beforeRegister = undefined;
      await registry.update('alpha', { name: 'AlphaOk' });
      presets.beforeRegister = async () => { throw poisoned; };
      await expect(registry.update('alpha', { name: 'AlphaRejected' })).rejects.toMatchObject({ code: 'bot/rollback-failed' });
      await expect(registry.create({ id: 'gamma', name: 'Gamma' })).rejects.toMatchObject({ code: 'bot/unavailable' });
      expect(errorLog).toHaveBeenCalledWith('[dsh-bot] reconcile failed', {
        botId: 'alpha', phase: 'reconcile', errorName: 'unknown',
      });
      presets.beforeRegister = undefined;

      // Persona listener and dsh-bot/changed listener failures log redacted metadata.
      const unsubPersona = registry.subscribePersonaChanges(() => { throw poisoned; });
      const unsubChanged = ctx.on('dsh-bot/changed', () => { throw poisoned; });
      // Post-commit update mainSessions.find failure does not reject committed update.
      registry.mainSessions = {
        find: vi.fn(async () => { throw poisoned; }),
      } as unknown as NonNullable<typeof registry.mainSessions>;
      const updated = await registry.update('alpha', { name: 'CommittedUpdate' });
      expect(updated.name).toBe('CommittedUpdate');
      expect((await registry.get('alpha')).name).toBe('CommittedUpdate');
      await vi.waitFor(() => expect(warnLog).toHaveBeenCalledWith('[dsh-bot] changed listener failed', {
        botId: 'alpha', action: 'update', phase: 'changed-listener', errorName: 'AggregateError',
      }));
      expect(warnLog).toHaveBeenCalledWith('[dsh-bot] persona listener failed', {
        botId: 'alpha', action: 'update', phase: 'persona-listener', errorName: 'unknown',
      });
      expect(warnLog).toHaveBeenCalledWith('[dsh-bot] main session refresh after Bot update failed', {
        botId: 'alpha', phase: 'update-main-session', errorName: 'unknown',
      });

      // Post-commit duplicate connectors.copyDisabled failure does not reject committed duplicate.
      const releaseConnectors = ctx.provide('dshBotConnectors', {
        copyDisabled: vi.fn(async () => { throw poisoned; }),
      } as unknown as Context['dshBotConnectors']);
      const copied = await registry.duplicate('alpha', 'alpha-copy');
      expect(copied.id).toBe('alpha-copy');
      expect((await registry.get('alpha-copy')).id).toBe('alpha-copy');
      expect(warnLog).toHaveBeenCalledWith('[dsh-bot] connector copy after Bot duplicate failed', {
        sourceBotId: 'alpha', botId: 'alpha-copy', phase: 'duplicate-copy-connectors', errorName: 'unknown',
      });

      releaseConnectors();
      unsubPersona();
      unsubChanged();
      expect(JSON.stringify(warnLog.mock.calls)).not.toContain(sentinel);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sentinel);
    });
  });
});

describe('Issue #57 Area 3: turns.ts hardening & export-review relay preservation', () => {
  it('accept() preserves inputSeq on schedule failure and normalizes secondary putTurn failure to recovery-needed', () => withIntegrations(async f => {
    const s = await groupFixture(f);
    const warn = vi.spyOn(f.ctx.logger, 'warn');
    try {
      const g = await s.groups.create({ operationId: 'accept-hardening', name: 'Hardening', members: [alpha, beta], mode: 'natural', historyConfirmed: true });
      const key = groupKey(g);
      const turns = (s.groups as unknown as { turns: { schedule: (t: GroupTurn) => void } }).turns;
      const sentinel = 'ACCEPT-SCHEDULE-FAIL-SENTINEL';
      vi.spyOn(turns, 'schedule').mockImplementationOnce(() => { throw poisonedError(sentinel); });

      await expect(s.groups.send(key, { operationId: 'sched-fail', text: 'Preserve inputSeq', expectedMembershipRevision: 1 }))
        .rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      const saved = need((await s.groups.view(key)).turns.find(t => t.operationId === 'sched-fail'));
      expect(saved.state).toBe('recovery_needed');
      expect(saved.inputSeq).toBeTypeOf('number');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);

      // Now fail flush AND fail the catch's putTurn -> still throws OperationError('recovery-needed'), never raw error.
      const sentinel2 = 'ACCEPT-PUTTURN-FAIL-SENTINEL';
      s.flush.mockRejectedValueOnce(poisonedError(sentinel2));
      const state = (s.groups as unknown as { state: GroupState }).state;
      const origPutTurn = state.putTurn.bind(state);
      let putTurnCalls = 0;
      vi.spyOn(state, 'putTurn').mockImplementation(async (t: GroupTurn) => {
        putTurnCalls++;
        if (putTurnCalls === 2) throw poisonedError(sentinel2);
        return origPutTurn(t);
      });
      await expect(s.groups.send(key, { operationId: 'double-fail', text: 'Double failure', expectedMembershipRevision: 1 }))
        .rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel2);
    } finally { await s.close(); }
  }));

  it('followup() normalizes catch putTurn storage errors to recovery-needed without leaking sentinels', () => withIntegrations(async f => {
    const s = await groupFixture(f);
    const warn = vi.spyOn(f.ctx.logger, 'warn');
    try {
      s.setHold(true);
      const g = await s.groups.create({ operationId: 'followup-hardening', name: 'Followup', members: [alpha, beta], mode: 'natural', historyConfirmed: true });
      const key = groupKey(g);
      const members = (await s.groups.view(key)).members;
      const turn = await s.groups.send(key, { operationId: 'base-turn', text: 'Run', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await vi.waitFor(() => expect(s.calls).toHaveLength(1), { timeout: 5000 });
      const delivery = need((await s.groups.view(key)).deliveries[0]);

      const sentinel = 'FOLLOWUP-CATCH-PUTTURN-SENTINEL';
      s.prompt.mockRejectedValueOnce(poisonedError(sentinel));
      const state = (s.groups as unknown as { state: GroupState }).state;
      const origPutTurn = state.putTurn.bind(state);
      let calls = 0;
      vi.spyOn(state, 'putTurn').mockImplementation(async (t: GroupTurn) => {
        calls++;
        if (calls === 2) throw poisonedError(sentinel);
        return origPutTurn(t);
      });
      await expect(s.groups.send(key, {
        operationId: 'followup-double-fail',
        text: 'Supplement',
        expectedMembershipRevision: 1,
        followup: { turnId: turn.id, deliveryId: delivery.id },
      })).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally { await s.close(); }
  }));

  it('continueTurn() routes through state.schedule and cleans up chains cleanly', () => withIntegrations(async f => {
    const s = await groupFixture(f, { groupMaxContinuations: 1 });
    try {
      const g = await s.groups.create({ operationId: 'continue-schedule', name: 'Continue', members: [alpha, beta], mode: 'natural', historyConfirmed: true });
      const key = groupKey(g);
      const members = (await s.groups.view(key)).members;
      const state = (s.groups as unknown as { state: GroupState }).state;
      // Seed a paused protocol-2 turn with a pending automatic delivery.
      const turn = await s.groups.send(key, { operationId: 'seed-turn', text: 'Seed', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await s.settle(g);
      const settled = need((await s.groups.view(key)).turns.find(t => t.id === turn.id));
      const paused = await state.putTurn({ ...settled, state: 'paused', automaticExecutions: 1, continuationAllowance: 1 });
      await state.putDelivery({
        id: `${paused.id}:auto`,
        turnId: paused.id,
        memberId: need(members[1]).id,
        ordinal: 1,
        bot: beta,
        botRevision: need(f.bots.get('beta')).updatedAt,
        presetId: 'bot-beta',
        contextOutputMessageIds: [],
        contextTruncated: false,
        automatic: true,
        state: 'pending',
      });

      const scheduleSpy = vi.spyOn(state, 'schedule');
      await s.groups.continueTurn(key, paused.id, paused.revision);
      expect(scheduleSpy).toHaveBeenCalledWith(g.id, Number.MAX_SAFE_INTEGER, expect.any(Function));
      await s.settle(g);
      expect(state.chains.has(paused.id)).toBe(false);
    } finally { await s.close(); }
  }));

  it('archive() tolerates rejected running chains and failing drainDescendants/flush while still releasing root handle', () => withIntegrations(async f => {
    const s = await groupFixture(f);
    const warn = vi.spyOn(f.ctx.logger, 'warn');
    try {
      const g = await s.groups.create({ operationId: 'archive-hardening', name: 'Archive', members: [alpha, beta], mode: 'natural', historyConfirmed: true });
      const key = groupKey(g);
      const members = (await s.groups.view(key)).members;
      const turn = await s.groups.send(key, { operationId: 'running-turn', text: 'Work', memberIds: [need(members[0]).id], expectedMembershipRevision: 1 });
      await s.settle(g);

      const sentinel = 'ARCHIVE-TEARDOWN-SENTINEL';
      const state = (s.groups as unknown as { state: GroupState }).state;
      // Inject a rejecting chain entry and failing drainDescendants + flush.
      const rejectingChain = Promise.reject(poisonedError(sentinel));
      rejectingChain.catch(() => {});
      state.chains.set(turn.id, rejectingChain);
      s.drainDescendants.mockRejectedValueOnce(poisonedError(sentinel));
      s.flush.mockRejectedValueOnce(poisonedError(sentinel));

      const viewBefore = await s.groups.view(key);
      const archived = await s.groups.archive(key, viewBefore.group.revision);
      state.chains.delete(turn.id);
      expect(archived.archived).toBe(true);
      expect(s.groups.lifecycle().ownedRoots).toBe(0);
      expect(s.sequence).toContain('root-dispose');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally { await s.close(); }
  }));

  it('export-review relay path preserves completed relay delivery and invokes resumeRelay when post-release putTurn fails', () => withIntegrations(async f => {
    const domain = await f.ctx.storageDomain.open(groupsDomain);
    const warn = vi.spyOn(f.ctx.logger, 'warn');
    const state = new GroupState(f.ctx, f.registry, domain, () => {});
    const roots = new GroupRoots(state);
    const resumeRelay = vi.fn();
    const review = new GroupExportReview(state, roots, resumeRelay);
    try {
      const g: GroupRecord = {
        id: 'relay-group', operationId: 'create', createDigest: 'd', createdAt: 1, updatedAt: 1, schemaVersion: 1,
        name: 'Relay Group', rootSessionId: 'relay-root', rootPresetId: GROUP_ROOT_PRESET, cwd: f.root,
        mode: 'natural', membershipRevision: 1, revision: 1, archived: false, state: 'ready',
      };
      await state.putGroup(g);
      const memberA = { id: 'member-a', group: groupKey(g), bot: alpha, order: 0, joinedAt: 1, enabled: true };
      await state.table('members').put(memberA.id, memberA);
      const alphaBot = need(f.bots.get('alpha'));
      Object.assign(f.registry, {
        onboardingSnapshot: (id: string, createdAt: number) =>
          id === alpha.botId && createdAt === alpha.botCreatedAt ? alphaBot : undefined,
      });

      const guestBot = { botId: 'jarvis', botCreatedAt: 1 };
      f.bots.set('jarvis', { ...alphaBot, id: 'jarvis', name: 'Jarvis', createdAt: 1, updatedAt: 1 });
      const turn: GroupTurn = {
        id: 'turn:relay-1',
        group: groupKey(g),
        operationId: 'relay-op',
        requestDigest: 'r',
        inputMessageId: 'input-1',
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
        schemaVersion: 1,
        membershipRevision: 1,
        orderedMemberIds: ['guest:jarvis', memberA.id],
        guestQuestion: {
          bot: guestBot,
          name: 'Jarvis',
          via: { bot: alpha, name: alphaBot.name, memberId: memberA.id, botRevision: alphaBot.updatedAt, presetId: 'bot-alpha' },
        },
        mode: 'natural',
        protocol: 2,
        contextThroughSeq: -1,
        state: 'partial',
      };
      await state.table('turns').put(turn.id, turn);

      const flowId = '00000000-0000-4000-8000-000000000001';
      const delivery: GroupDelivery = {
        id: `${turn.id}:0`,
        revision: 1,
        turnId: turn.id,
        memberId: 'guest:jarvis',
        ordinal: 0,
        bot: guestBot,
        botRevision: 1,
        presetId: 'bot-jarvis',
        childSessionId: 'child-jarvis',
        contextOutputMessageIds: [],
        contextTruncated: false,
        state: 'failed',
        stopReason: 'completed',
        reasonCode: 'export-approval-required',
        exportFlowId: flowId,
      };
      await state.table('deliveries').put(delivery.id, delivery);

      const msg = createUserMessage({
        source: {
          kind: 'dsh-bot-group',
          group: groupKey(g),
          turnId: turn.id,
          memberId: delivery.memberId,
          speaker: { bot: guestBot, name: 'Jarvis' },
          guestReply: true,
          stopReason: 'completed',
          replyTo: turn.inputMessageId,
          causeId: turn.id,
        },
        content: [{ type: 'text', text: 'Private guest answer' }],
      });
      const envelope = {
        outlet: 'group-result',
        binding: { invocation: `${delivery.childSessionId}/${delivery.id}:result`, bot: guestBot, target: { kind: 'bot', bot: alpha } },
        content: JSON.stringify(msg),
        label: { readers: [alpha] },
      };
      const flow = {
        review: () => ({ envelope, digest: 'digest-1' }),
        approveReview: async () => flowId,
        dispatch: async (_id: string, send: () => unknown) => send(),
      };
      Object.assign(f.registry, { memoryKernel: {}, memoryOutlets: flow });
      state.roots.set(g.id, { ownership: 'borrowed', agent: { id: g.rootSessionId } as Agent });

      const preview = await review.review(groupKey(g), delivery.id);
      const sentinel = 'RELAY-PUTTURN-FAIL-SENTINEL';
      vi.spyOn(state, 'putTurn').mockRejectedValueOnce(poisonedError(sentinel));

      const decision = await review.decide(groupKey(g), delivery.id, preview.token, true);
      expect(decision).toBe(true);
      const updatedDelivery = need(state.table('deliveries').get(delivery.id));
      expect(updatedDelivery.state).toBe('completed');
      expect(updatedDelivery.relayAnswerFlowId).toBe(flowId);
      expect(state.table('deliveries').get(`${turn.id}:1`)?.state).toBe('pending');
      expect(resumeRelay).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[dsh-bot] Group handoff answer released; could not update turn summary', {
        groupId: g.id, turnId: turn.id, deliveryId: delivery.id, phase: 'relay-turn-summary', errorName: 'unknown',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    } finally {
      state.closeIndex();
      await domain.close();
    }
  }));
});
