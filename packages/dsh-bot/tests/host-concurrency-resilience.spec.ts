import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SessionTitle from '@deepseek-ai/dsh-session-title';
import Storage from '@deepseek-ai/dsh-storage';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import { describe, expect, it, vi } from 'vitest';
import { need } from '../src/host/common/operations.js';
import { bindings } from '../src/host/data-flow/agent-binding.js';
import { Groups, groupsDomain } from '../src/host/groups/service.js';
import { executeRootSetup } from '../src/host/groups/root-guard.js';
import {
  supergroupMetadata,
  validateSupergroupAuthority,
  type SupergroupAuthority,
} from '../src/host/groups/supergroup-admission.js';
import type { GroupState } from '../src/host/groups/state.js';
import { workerReservations } from '../src/host/groups/worker-tool.js';
import { MainSessions } from '../src/host/main-session.js';
import { MemoryConsolidation } from '../src/host/memory/consolidation.js';
import { Config as ConsolidationConfig } from '../src/host/memory/consolidation-config.js';
import { NativeSchedules } from '../src/host/native-schedule/service.js';
import { CoordinatorClient } from '../src/host/proactive/coordinator-client.js';
import { ProactiveService } from '../src/host/proactive/service.js';
import { keyOf as referenceKeyOf, referenceMemoryDomain, writers, type Live as ReferenceLive } from '../src/host/reference-memory/model.js';
import { ReferenceMemory } from '../src/host/reference-memory/service.js';
import { Config as RegistryConfig } from '../lib/host/registry.js';
import type { DshBotRegistry } from '../src/host/registry.js';
import { openBotStores } from '../src/host/store.js';
import { Config as SupergroupConfig } from '../src/host/supergroup/config.js';
import { Supergroup, supergroupDomain } from '../src/host/supergroup/service.js';
import { groupKey, groupRecordSchema, type GroupKey, type GroupRecord } from '../src/shared/groups.js';
import { deferred, withFacility } from './fixtures/registry.js';
import { alpha, beta, withIntegrations } from './integration-support.js';

const testBase = fileURLToPath(new URL('../../../.dsh-dev/issue-56-tests/', import.meta.url));

async function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createNaturalGroupsFixture(
  f: Parameters<Parameters<typeof withIntegrations>[0]>[0],
  options: { groupRoundTimeoutMs?: number } = {},
) {
  const roots = new Map<string, AgentHandle>();
  const persisted = new Map<string, AgentHandle>();
  const config = RegistryConfig({
    dataDir: f.root,
    seedExamples: false,
    groupRoundTimeoutMs: options.groupRoundTimeoutMs ?? 15_000,
    groupTaskTimeoutMs: options.groupRoundTimeoutMs ?? 15_000,
  });
  Object.assign(f.registry, {
    config,
    status: async () => [...f.bots.keys()].map((id) => ({ id, presetId: `bot-${id}`, preset: { state: 'ok' } })),
  });
  const workspaces = new Map<
    string,
    { id: string; path: string; sessionIds: SessionId[]; attachSession(id: SessionId): Promise<void> }
  >();
  const workspaceRegistry = {
    create: vi.fn(async (path: string) => {
      let workspace = workspaces.get(path);
      if (!workspace) {
        workspace = {
          id: `workspace-${workspaces.size}`,
          path,
          sessionIds: [],
          async attachSession(id: SessionId) {
            if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
          },
        };
        workspaces.set(path, workspace);
      }
      return workspace;
    }),
  };
  f.ctx.provide('workspaceRegistry', workspaceRegistry as never);
  Object.assign(f.registry, {
    ensureBotsWorkspace: async () => {
      const workspace = await workspaceRegistry.create(f.root);
      return { path: workspace.path, workspaceId: workspace.id };
    },
  });
  f.ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'synthetic', model: 'loopback' }),
  } as typeof f.ctx.agentDefaultModel);
  f.ctx.provide('agentPresets', {
    register: vi.fn(() => async () => {}),
    mount: vi.fn(async () => {}),
  } as unknown as typeof f.ctx.agentPresets);

  const create = vi.fn(async ({ sessionId, meta }: { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string } }) => {
    const session = Session.create(sessionId, undefined, {
      version: 4,
      id: sessionId,
      createdAt: Date.now(),
      isSeeded: false,
      ...meta,
    });
    let activity = Promise.resolve();
    const agent = {
      id: sessionId,
      session,
      ctx: f.ctx,
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: vi.fn(() => activity),
      followup: vi.fn((message: import('@deepseek-ai/dsh-llm').UserMessage) => {
        activity = (async () => {
          const turn = session.snapshotEvents().filter((event) => event.type === 'turn/start').length + 1;
          session.append('turn/start', { turn });
          try {
            expect(await executeRootSetup(agent, [message], turn)).toBe(true);
            session.append('turn/end', { turn, reason: { kind: 'completed' } });
          } catch {
            session.append('turn/end', { turn, reason: { kind: 'blocked' } });
          }
        })();
        void activity.catch(() => {});
      }),
    } as unknown as Agent;
    const h = {
      agent,
      dispose: vi.fn(async () => {
        roots.delete(sessionId);
      }),
    };
    roots.set(sessionId, h);
    persisted.set(sessionId, h);
    return h;
  });
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
    const h = persisted.get(resumeSessionId);
    if (!h || roots.has(resumeSessionId)) throw new Error('ownership');
    roots.set(resumeSessionId, h);
    return h;
  });
  f.ctx.provide('agents', { get: (id: string) => roots.get(id)?.agent, create, resume } as unknown as typeof f.ctx.agents);
  const flush = vi.fn(async () => true);
  f.ctx.provide('sessions', { flush } as unknown as typeof f.ctx.sessions);
  const rename = vi.fn(async ({ title }: { title: string }) => ({ title, renamed: true }));
  f.ctx.provide('sessionController', { rename } as unknown as typeof f.ctx.sessionController);

  let onStart:
    | ((
        input: { childId: SessionId; signal: AbortSignal; request: { parent: Agent; agentPreset: string; prompt: { text: string }[] } },
        index: number,
      ) => Promise<SubagentResult>)
    | undefined;
  let onDispose: (() => Promise<void>) | undefined;
  let sendMessageImpl:
    | ((parent: Agent, childId: SessionId, content: { text: string }[], opts: { signal?: AbortSignal }) => Promise<string>)
    | undefined;
  const interrupt = vi.fn();
  const drainChildren = vi.fn(async () => {});
  let startCount = 0;
  const startActivation = vi.fn(
    async (input: { childId: SessionId; signal: AbortSignal; request: { parent: Agent; agentPreset: string; prompt: { text: string }[] } }) => {
      startCount++;
      let finish!: (result: SubagentResult) => void;
      const result = new Promise<SubagentResult>((resolve) => {
        finish = resolve;
      });
      if (onStart) {
        void onStart(input, startCount).then(finish, () => finish({ output: [], stopReason: 'error' }));
      } else {
        finish({ output: [{ type: 'text', text: `reply-${startCount}` }], stopReason: 'completed' });
      }
      return {
        childId: input.childId,
        result,
        dispose: vi.fn(async () => {
          finish({ output: [], stopReason: 'aborted' });
          if (onDispose) await onDispose();
        }),
      };
    },
  );
  f.ctx.provide('subagents', {
    drainDescendants: vi.fn(async () => {}),
    drainChildren,
    getProvider: () => ({
      inheritsParentContext: false,
      capabilities: { agentPreset: true, agentOptions: true, depthLimit: true },
    }),
    startActivation,
    interrupt,
    sendMessage: (parent: Agent, childId: SessionId, content: { text: string }[], opts: { signal?: AbortSignal }) => {
      if (sendMessageImpl) return sendMessageImpl(parent, childId, content, opts);
      return Promise.resolve('resumed-msg');
    },
  } as unknown as typeof f.ctx.subagents);

  let domain = await f.ctx.storageDomain.open(groupsDomain);
  let groups = new Groups(f.ctx, f.registry, domain, () => {});
  await groups.start();
  return {
    get groups() {
      return groups;
    },
    get domain() {
      return domain;
    },
    rename,
    interrupt,
    drainChildren,
    startActivation,
    setOnStart(fn: NonNullable<typeof onStart>) {
      onStart = fn;
    },
    setOnDispose(fn?: () => Promise<void>) {
      onDispose = fn;
    },
    setSendMessage(fn: NonNullable<typeof sendMessageImpl>) {
      sendMessageImpl = fn;
    },
    async reopen() {
      await groups.close();
      domain = await f.ctx.storageDomain.open(groupsDomain);
      groups = new Groups(f.ctx, f.registry, domain, () => {});
      await groups.start();
    },
    close: () => groups.close(),
  };
}

describe('Issue #56 Fix 1: Registry <-> MemoryKernel AB-BA deadlock prevention', () => {
  it('completes concurrent Registry memory mutation and ManagedOutlets beforeAttempt without deadlocking', async () => {
    await withFacility(async (f) => {
      await f.ctx.plugin(SessionProjections).await();
      await f.ctx.plugin(SessionStore).await();
      await f.ctx.plugin(SessionTitle, { fallbackMaxWords: 10, fallbackMaxBytes: 128, maxTitleBytes: 256 }).await();
      const { registry, stop } = await f.start({
        supergroup: SupergroupConfig({ enabled: true, maxMembers: 4, maxExperts: 8, maxRequests: 16, timeoutMs: 60_000, allowedBotIds: [] }),
      });
      const alphaBot = await registry.create({ id: 'alpha', name: 'Alpha' });
      const betaBot = await registry.create({ id: 'beta', name: 'Beta' });
      const gammaBot = await registry.create({ id: 'gamma', name: 'Gamma' });
      const alphaKey = { botId: alphaBot.id, botCreatedAt: alphaBot.createdAt };
      const betaKey = { botId: betaBot.id, botCreatedAt: betaBot.createdAt };

      const liveAgents = new Map<string, Agent>();
      const sessionRows: Array<{ sessionId: SessionId; updatedAt: number; running: boolean; blank: boolean; agentAvailable: boolean }> = [];
      f.ctx.provide('agents', { get: (id: string) => liveAgents.get(id) } as unknown as Context['agents']);
      f.ctx.provide('sessionController', {
        list: async () => ({ items: sessionRows }),
        create: async ({ agentPreset }: { agentPreset?: string }) => {
          const id = SessionId(`main-${agentPreset ?? randomUUID()}`);
          const session = f.ctx.sessions.create(id, {
            meta: { createdAt: Math.max(Date.now(), alphaBot.createdAt, betaBot.createdAt), agentPreset },
          });
          sessionRows.push({ sessionId: session.id, updatedAt: Date.now(), running: false, blank: false, agentAvailable: true });
          return { sessionId: session.id };
        },
        rename: async ({ sessionId, title }: { sessionId: SessionId; title: string }) => {
          const session = need(f.ctx.sessions.get(sessionId));
          const accepted = f.ctx.sessionTitle.rename(session, title);
          return { title: accepted.title, seq: accepted.eventSeq };
        },
      } as unknown as Context['sessionController']);
      vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValue(true);
      await f.workspaces();

      const mains = new MainSessions(f.ctx, registry);
      await mains.start();
      registry.mainSessions = mains;

      const alphaMain = await mains.open(alphaBot.id, alphaBot.createdAt);
      const alphaSession = need(f.ctx.sessions.get(alphaMain.sessionId as SessionId));
      const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Coordinate report' }] });
      alphaSession.append('user/message', human, { surfaceOp: 'append' });
      const origin = { id: alphaSession.id, session: alphaSession } as Agent;
      liveAgents.set(alphaSession.id, origin);
      bindings.set(origin, alphaKey);

      const workDomain = await f.ctx.storageDomain.open(supergroupDomain);
      let capturedAuthority: SupergroupAuthority | undefined;
      const authorityCaptured = deferred();
      const releaseTurn = deferred();
      const sgGroup = {
        id: 'sg-1',
        createdAt: 1,
        revision: 1,
        membershipRevision: 1,
        name: 'SG',
        mode: 'natural' as const,
        rootSessionId: 'root-sg-1',
      };
      const stubGroups = {
        setExpertHandler: () => () => {},
        createSupergroup: async (_value: unknown, authority: SupergroupAuthority) => {
          capturedAuthority = authority;
          authorityCaptured.resolve();
          return sgGroup;
        },
        view: async () => ({
          group: sgGroup,
          members: [
            { id: 'm-alpha', enabled: true, bot: alphaKey },
            { id: 'm-beta', enabled: true, bot: betaKey },
          ],
          turns: [{ id: 'turn-1', state: 'running', revision: 1 }],
          deliveries: [],
          messages: [],
        }),
        sendSupergroup: async () => ({ id: 'turn-1', state: 'running', revision: 1 }),
        waitForTurn: async () => {
          await releaseTurn.promise;
        },
        cancel: async () => {},
        drain: async () => {},
      } as unknown as Groups;
      const supergroup = new Supergroup(f.ctx, registry, stubGroups, workDomain);
      await supergroup.start();
      const invokeTask = supergroup.invoke(
        origin,
        { action: 'start', memberIds: [alphaBot.id, betaBot.id] },
        new AbortController().signal,
      );
      await withTimeout(authorityCaptured.promise, 'supergroup authority capture');
      const authority = need(capturedAuthority);

      const group = groupRecordSchema.parse({
        ...sgGroup,
        operationId: 'op-1',
        createDigest: 'digest',
        updatedAt: 1,
        schemaVersion: 1,
        rootPresetId: 'dsh-bot-group-root',
        cwd: f.root,
        archived: false,
        state: 'ready',
        supergroup: supergroupMetadata(authority),
      });
      const groupState = {
        check() {},
        ctx: f.ctx,
        registry,
        bot: (key: typeof alphaKey) => registry.get(key.botId),
        botSnapshot: async (key: typeof alphaKey) => {
          const row = registry.botSnapshot(key.botId, key.botCreatedAt);
          if (!row) throw new Error('conflict');
          return row;
        },
      } as unknown as GroupState;

      const outlets = need(registry.memoryOutlets);
      await outlets.inherit(alphaSession.id, {
        readers: [alphaKey, betaKey],
        originTrust: 'candidate',
        sourceVersions: [],
        restrictions: [],
        grants: [],
      });
      const envelope = outlets.draft(
        'group-result',
        alphaKey,
        alphaSession.id,
        'deadlock-check',
        { kind: 'bot', bot: alphaKey },
        JSON.stringify({ ok: true }),
      );
      const flowId = await outlets.admit(envelope);

      const enteredBeforeAttempt = deferred();
      const releaseBeforeAttempt = deferred();
      const enteredRegistryQueue = deferred();

      // 1) Acquire MemoryKernel.tail first via ManagedOutlets.dispatch beforeAttempt.
      const dispatchTask = outlets.dispatch(
        flowId,
        () => 'DISPATCHED',
        new AbortController().signal,
        async () => {
          enteredBeforeAttempt.resolve();
          await releaseBeforeAttempt.promise;
          // Both Supergroup authority.check() AND Groups validateSupergroupAuthority() run while MemoryKernel.tail is held!
          await authority.check();
          await validateSupergroupAuthority(groupState, authority, group);
        },
      );
      await enteredBeforeAttempt.promise;

      // 2) Simultaneously acquire DshBotRegistry.tail and block on MemoryKernel.tail (retireShard / manageMemory).
      let registryBlockedOnKernel = false;
      const registryTask = registry.manageMemory(async (memory) => {
        enteredRegistryQueue.resolve();
        registryBlockedOnKernel = true;
        return memory.kernel.serial(() => 'KERNEL_ACQUIRED_AFTER_DISPATCH');
      });
      await enteredRegistryQueue.promise;
      expect(registryBlockedOnKernel).toBe(true);

      // Confirm DshBotRegistry.tail is genuinely held right now: a queued registry.get() stays pending.
      let queuedGetSettled = false;
      const queuedGet = registry.get(alphaBot.id).then((row) => {
        queuedGetSettled = true;
        return row;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(queuedGetSettled).toBe(false);

      // Also queue a real Bot removal (registry.remove -> retireShard -> MemoryKernel.commit) behind it.
      const removeTask = registry.remove(gammaBot.id);

      // 3) Release beforeAttempt: MUST complete without entering DshBotRegistry.tail (no AB-BA deadlock!).
      releaseBeforeAttempt.resolve();
      await withTimeout(
        Promise.all([
          expect(dispatchTask).resolves.toBe('DISPATCHED'),
          expect(registryTask).resolves.toBe('KERNEL_ACQUIRED_AFTER_DISPATCH'),
          expect(queuedGet).resolves.toMatchObject({ id: 'alpha' }),
          expect(removeTask).resolves.toBeUndefined(),
        ]),
        'concurrent dispatch and registry mutations',
      );

      // Verify strictness of committed synchronous snapshots (zero weakening of security gates).
      expect(mains.isBoundLiveMain(alphaBot.id, alphaBot.createdAt, origin)).toBe(true);
      expect(mains.isBoundLiveMain(alphaBot.id, alphaBot.createdAt + 1, origin)).toBe(false);
      // Wrong projected preset must fail closed.
      const projSpy = vi
        .spyOn(f.ctx.sessionProjections, 'snapshot')
        .mockReturnValue({ values: { agentPreset: 'standard' } } as ReturnType<Context['sessionProjections']['snapshot']>);
      expect(mains.isBoundLiveMain(alphaBot.id, alphaBot.createdAt, origin)).toBe(false);
      await expect(authority.check()).rejects.toMatchObject({ code: 'dsh-bot/approval-denied' });
      projSpy.mockRestore();
      // Reader updatedAt change must still fail closed.
      await registry.update(betaBot.id, { name: 'Beta Updated' });
      await expect(authority.check()).rejects.toMatchObject({ code: 'dsh-bot/conflict' });
      // Deleted bot must return undefined from botSnapshot.
      expect(registry.botSnapshot(gammaBot.id, gammaBot.createdAt)).toBeUndefined();

      bindings.delete(origin);
      releaseTurn.resolve();
      await supergroup.close();
      await invokeTask.catch(() => {});
      await workDomain.close();
      await mains.close();
      await stop();
    });
  });
});

describe('Issue #56 Fix 2: ConcurrentGroups.deliver() resumed (prior) protocol-2 abort safety', () => {
  it('settles cleanly when abort fires before subagent/start sets runId on a resumed worker', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      const scopes: Array<{ dispose(): void }> = [];
      try {
        const g = await s.groups.create({
          operationId: 'p2-abort-before-start',
          name: 'Resume Before Start',
          members: [alpha, beta],
          mode: 'natural',
          historyConfirmed: true,
        });
        const key = groupKey(g);
        const members = (await s.groups.view(key)).members;
        const alphaMember = need(members.find((m) => m.bot.botId === 'alpha'));
        const betaMember = need(members.find((m) => m.bot.botId === 'beta'));

        const resumedSent = deferred();
        s.setOnStart(async (input, index) => {
          const worker = f.createAgent(input.childId);
          scopes.push(worker.scope);
          worker.value.session = Session.create(input.childId, undefined, {
            version: 4,
            id: input.childId,
            createdAt: Date.now(),
            isSeeded: false,
            parentSession: input.request.parent.session.id,
            agentPreset: input.request.agentPreset,
          });
          await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', {
            agent: worker.agent,
            source: 'startup',
          });
          worker.agent.session.append('turn/start', { turn: 0 });
          worker.agent.session.append('step/start', { turn: 0, step: 0 });
          if (index === 1) {
            // Alpha asks Beta with requestReply so Alpha gets a resumed (prior) delivery after Beta finishes.
            const res = await worker.agent.ctx.tools.execute({
              agent: worker.agent,
              name: 'group_message',
              arguments: { action: 'send', to: betaMember.id, text: 'Beta please reply', requestReply: true },
              callId: ToolCallId('ask-beta'),
              signal: new AbortController().signal,
            });
            expect(res.isError).toBeFalsy();
            return { output: [{ type: 'text', text: 'Waiting on Beta' }], stopReason: 'completed' };
          }
          await vi.waitFor(async () =>
            expect((await s.groups.view(key)).deliveries.some((d) => d.memberId === alphaMember.id && d.state === 'completed')).toBe(
              true,
            ),
          );
          return { output: [{ type: 'text', text: 'Beta done' }], stopReason: 'completed' };
        });

        // Resumed sendMessage NEVER emits subagent/start or subagent/end!
        s.setSendMessage(async () => {
          resumedSent.resolve();
          return 'resumed-msg-no-start';
        });

        const turn = await s.groups.send(key, {
          operationId: 'turn-abort-before-start',
          text: 'Start work',
          memberIds: [alphaMember.id],
          expectedMembershipRevision: 1,
        });
        await withTimeout(resumedSent.promise, 'resumed sendMessage');
        // Wait until resumed delivery reaches running state (awaiting `end` with runId === undefined).
        await vi.waitFor(async () => {
          const v = await s.groups.view(key);
          expect(v.deliveries.some((d) => d.memberId === alphaMember.id && d.state === 'running')).toBe(true);
        });

        // Cancel the turn -> aborts controller.signal BEFORE subagent/start ever fires.
        const currentTurn = need((await s.groups.view(key)).turns.find((row) => row.id === turn.id));
        await s.groups.cancel(key, turn.id, currentTurn.revision);
        await withTimeout(s.groups.waitForTurn(turn.id), 'turn settlement after abort before subagent/start');

        const finalView = await s.groups.view(key);
        const resumedDelivery = finalView.deliveries.find((d) => d.memberId === alphaMember.id && d.id.startsWith('group-return:'));
        expect(resumedDelivery?.state).toBe('cancelled');
        expect(workerReservations.size).toBe(0);
        expect(s.groups.lifecycle()).toMatchObject({ workers: 0, activations: 0 });
      } finally {
        for (const scope of scopes) scope.dispose();
        await s.close();
      }
    }));

  it('settles cleanly when interrupt() fails to emit subagent/end and guards missing root in stop()', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      const scopes: Array<{ dispose(): void }> = [];
      try {
        const g = await s.groups.create({
          operationId: 'p2-abort-no-end',
          name: 'Resume No End',
          members: [alpha, beta],
          mode: 'natural',
          historyConfirmed: true,
        });
        const key = groupKey(g);
        const members = (await s.groups.view(key)).members;
        const alphaMember = need(members.find((m) => m.bot.botId === 'alpha'));
        const betaMember = need(members.find((m) => m.bot.botId === 'beta'));

        const resumedStarted = deferred();
        s.setOnStart(async (input, index) => {
          const worker = f.createAgent(input.childId);
          scopes.push(worker.scope);
          worker.value.session = Session.create(input.childId, undefined, {
            version: 4,
            id: input.childId,
            createdAt: Date.now(),
            isSeeded: false,
            parentSession: input.request.parent.session.id,
            agentPreset: input.request.agentPreset,
          });
          await f.ctx.serial(scopeTarget(worker.agent, worker.agent), 'agent/created', {
            agent: worker.agent,
            source: 'startup',
          });
          worker.agent.session.append('turn/start', { turn: 0 });
          worker.agent.session.append('step/start', { turn: 0, step: 0 });
          if (index === 1) {
            await worker.agent.ctx.tools.execute({
              agent: worker.agent,
              name: 'group_message',
              arguments: { action: 'send', to: betaMember.id, text: 'Need reply', requestReply: true },
              callId: ToolCallId('ask-beta-2'),
              signal: new AbortController().signal,
            });
            return { output: [{ type: 'text', text: 'Waiting' }], stopReason: 'completed' };
          }
          await vi.waitFor(async () =>
            expect((await s.groups.view(key)).deliveries.some((d) => d.memberId === alphaMember.id && d.state === 'completed')).toBe(
              true,
            ),
          );
          return { output: [{ type: 'text', text: 'Beta reply' }], stopReason: 'completed' };
        });

        // Resumed sendMessage emits subagent/start (setting runId), but interrupt() never emits subagent/end.
        s.setSendMessage(async (_parent, childId) => {
          f.ctx.emit('subagent/start', {
            id: childId,
            runId: 'run-stuck' as import('@deepseek-ai/dsh-subagent').SubagentRunId,
            provider: 'spawn',
            local: true,
          });
          resumedStarted.resolve();
          return 'resumed-msg-no-end';
        });
        s.interrupt.mockImplementation(() => {
          // Deliberately emit nothing (simulating failed/dropped interrupt).
        });

        const turn = await s.groups.send(key, {
          operationId: 'turn-abort-no-end',
          text: 'Start work 2',
          memberIds: [alphaMember.id],
          expectedMembershipRevision: 1,
        });
        await withTimeout(resumedStarted.promise, 'resumed subagent/start');
        await vi.waitFor(async () => {
          const v = await s.groups.view(key);
          expect(v.deliveries.some((d) => d.memberId === alphaMember.id && d.state === 'running')).toBe(true);
        });

        // Remove the root entry right before abort to prove stop() line 166 and finally line 239 guard missing root!
        const internalState = (s.groups as unknown as { state: GroupState }).state;
        const savedRoot = need(internalState.roots.get(g.id));
        internalState.roots.delete(g.id);

        const currentTurn = need((await s.groups.view(key)).turns.find((row) => row.id === turn.id));
        await s.groups.cancel(key, turn.id, currentTurn.revision);
        await withTimeout(s.groups.waitForTurn(turn.id), 'turn settlement when interrupt emits no subagent/end');

        // Restore root for clean shutdown.
        internalState.roots.set(g.id, savedRoot);
        expect(workerReservations.size).toBe(0);
        expect(internalState.controllers.size).toBe(0);
        expect(internalState.inputAdmissions.size).toBe(0);
        expect(internalState.activations.size).toBe(0);
        expect(internalState.settledInputs.size).toBe(0);
      } finally {
        for (const scope of scopes) scope.dispose();
        await s.close();
      }
    }));
});

describe('Issue #56 Fix 3: GroupMembers.saveEdit() rename skipping, redacted logs, and recovery', () => {
  it('skips roots.rename() on editMembers when name is unchanged and survives a failing rename', () =>
    withIntegrations(async (f) => {
      f.bots.set('gamma', { ...need(f.bots.get('alpha')), id: 'gamma', name: 'Gamma' });
      const gamma = { botId: 'gamma', botCreatedAt: 1 };
      const s = await createNaturalGroupsFixture(f);
      try {
        const g = await s.groups.create({
          operationId: 'no-rename-group',
          name: 'Stable Name',
          members: [alpha, beta],
          mode: 'mention',
          historyConfirmed: true,
        });
        const key = groupKey(g);
        const renameCallsBefore = s.rename.mock.calls.length;
        s.rename.mockRejectedValue(new Error('SECRET_RENAME_TOKEN_DO_NOT_LEAK'));

        const edited = await s.groups.editMembers(key, {
          operationId: 'add-gamma-no-rename',
          expectedRevision: g.revision,
          expectedMembershipRevision: g.membershipRevision,
          members: [alpha, beta, gamma],
          historyConfirmed: true,
        });
        expect(edited.status).toBe('saved');
        expect(edited.group?.state).toBe('ready');
        expect(edited.group?.name).toBe('Stable Name');
        expect(s.rename.mock.calls.length).toBe(renameCallsBefore);
      } finally {
        await s.close();
      }
    }));

  it('logs strictly redacted metadata on transient rename failure and recovers cleanly on open/retry and across restart', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      const warn = vi.spyOn(f.ctx.logger, 'warn');
      try {
        const g = await s.groups.create({
          operationId: 'transient-rename-group',
          name: 'Original Name',
          members: [alpha, beta],
          mode: 'mention',
          historyConfirmed: true,
        });
        const key = groupKey(g);

        // 1) Transient rename failure during edit() -> logs redacted metadata, recovers on open().
        const secretErr = Object.assign(new Error('SENSITIVE_BACKEND_SECRET_42'), { code: 'EIO' });
        s.rename.mockRejectedValueOnce(secretErr);
        await expect(
          s.groups.edit(key, {
            name: 'Recovered Live Name',
            mode: 'mention',
            members: [alpha, beta],
            expectedRevision: g.revision,
            expectedMembershipRevision: g.membershipRevision,
          }),
        ).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });

        expect(warn).toHaveBeenCalledWith(
          '[dsh-bot] Group edit failed; recovery required',
          expect.objectContaining({ groupId: g.id, phase: 'rename', errorCode: 'EIO', errorName: 'Error' }),
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SENSITIVE_BACKEND_SECRET_42');
        expect((await s.groups.view(key)).group.state).toBe('recovery_needed');

        // Rename now succeeds -> opening the group reconciles the pending rename and restores ready state!
        await s.groups.open(key);
        const recovered = (await s.groups.view(key)).group;
        expect(recovered.state).toBe('ready');
        expect(recovered.name).toBe('Recovered Live Name');
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();

        // 2) Transient rename failure during edit() followed by restart (reopen) -> roots.start() recovers cleanly!
        s.rename.mockRejectedValueOnce(new Error('ANOTHER_SECRET_VALUE'));
        await expect(
          s.groups.edit(key, {
            name: 'Recovered Restart Name',
            mode: 'mention',
            members: [alpha, beta],
            expectedRevision: recovered.revision,
            expectedMembershipRevision: recovered.membershipRevision,
          }),
        ).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('ANOTHER_SECRET_VALUE');

        await s.reopen();
        const afterRestart = (await s.groups.view(key)).group;
        expect(afterRestart.state).toBe('ready');
        expect(afterRestart.name).toBe('Recovered Restart Name');
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();

        // Subsequent edits continue working normally (group is NOT bricked!).
        const nextEdit = await s.groups.edit(key, {
          name: 'Final Name',
          mode: 'natural',
          members: [alpha, beta],
          expectedRevision: afterRestart.revision,
          expectedMembershipRevision: afterRestart.membershipRevision,
        });
        expect(nextEdit.state).toBe('ready');
        expect(nextEdit.name).toBe('Final Name');

        // 3) Transient rename failure during operation-tracked editRecipe promotes member_edits receipt on recovery.
        const membersService = (s.groups as unknown as {
          membership: {
            editRecipe(
              targetKey: GroupKey,
              value: unknown,
              operationId: string,
              source: unknown,
            ): Promise<{ operationId: string; status: string; group?: GroupRecord }>;
          };
        }).membership;
        s.rename.mockRejectedValueOnce(new Error('RECIPE_RENAME_SECRET'));
        const pendingResult = await membersService.editRecipe(
          key,
          {
            name: 'Recipe Renamed',
            mode: 'natural',
            members: [alpha, beta],
            expectedRevision: nextEdit.revision,
            expectedMembershipRevision: nextEdit.membershipRevision,
          },
          'recipe-rename-op',
          { kind: 'recipe-test' },
        );
        expect(pendingResult).toEqual({ operationId: 'recipe-rename-op', status: 'unknown' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('RECIPE_RENAME_SECRET');

        // Checking result recovers the pending rename and promotes member_edits receipt to saved!
        const reconciledResult = await s.groups.getMemberEditResult(key, 'recipe-rename-op');
        expect(reconciledResult.status).toBe('saved');
        expect(reconciledResult.group?.state).toBe('ready');
        expect(reconciledResult.group?.name).toBe('Recipe Renamed');
      } finally {
        warn.mockRestore();
        await s.close();
      }
    }));

  it('retains pending_renames and idempotently finishes member_edits receipt on repeated getMemberEditResult and same-operationId retry after intermediate receipt write failure', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      const warn = vi.spyOn(f.ctx.logger, 'warn');
      try {
        const g = await s.groups.create({
          operationId: 'receipt-retry-group',
          name: 'Initial Title',
          members: [alpha, beta],
          mode: 'mention',
          historyConfirmed: true,
        });
        const key = groupKey(g);
        const membersService = (s.groups as unknown as {
          membership: {
            editRecipe(
              targetKey: GroupKey,
              value: unknown,
              operationId: string,
              source: unknown,
            ): Promise<{ operationId: string; status: string; group?: GroupRecord }>;
          };
        }).membership;

        // 1) Repeated getMemberEditResult() recovery from ready + unknown receipt + pending_renames.
        s.rename.mockRejectedValueOnce(new Error('SECRET_INITIAL_RENAME_FAIL'));
        const firstPending = await membersService.editRecipe(
          key,
          {
            name: 'Recovered Via Poll',
            mode: 'natural',
            members: [alpha, beta],
            expectedRevision: g.revision,
            expectedMembershipRevision: g.membershipRevision,
          },
          'op-poll-recover',
          { kind: 'poll-test' },
        );
        expect(firstPending).toEqual({ operationId: 'op-poll-recover', status: 'unknown' });
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        // Inject a single receipt.put rejection AFTER putGroup(ready) succeeds during reconcilePendingRename().
        const receiptPut1 = vi
          .spyOn(s.domain.table('member_edits'), 'put')
          .mockRejectedValueOnce(new Error('SECRET_RECEIPT_PUT_FAIL_1'));
        const midPoll = await s.groups.getMemberEditResult(key, 'op-poll-recover');
        receiptPut1.mockRestore();

        expect(midPoll).toEqual({ operationId: 'op-poll-recover', status: 'unknown' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_RECEIPT_PUT_FAIL_1');

        // Disk is now in the exact ready + unknown receipt + pending_renames intermediate state.
        const readyAfterRename = need(s.domain.table('groups').get(g.id));
        expect(readyAfterRename.state).toBe('ready');
        expect(readyAfterRename.name).toBe('Recovered Via Poll');
        expect(s.domain.table('pending_renames').get(g.id)).toMatchObject({
          group: key,
          revision: readyAfterRename.revision,
          name: 'Recovered Via Poll',
        });
        // Calling view() must NOT clear the recovery-needed reason while the receipt is still unfinalized.
        expect((await s.groups.view(key)).reason).toBe('recovery-needed');

        // Repeated getMemberEditResult() once storage is healthy idempotently finalizes the receipt and clears pending_renames.
        const recoveredPoll = await s.groups.getMemberEditResult(key, 'op-poll-recover');
        expect(recoveredPoll).toEqual({
          operationId: 'op-poll-recover',
          status: 'saved',
          group: readyAfterRename,
        });
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();
        expect((await s.groups.view(key)).reason).toBeUndefined();

        // 2) Same-operationId retry recovery from ready + unknown receipt + pending_renames.
        const retryInput = {
          name: 'Recovered Via Same Op Retry',
          mode: 'mention' as const,
          members: [alpha, beta],
          expectedRevision: readyAfterRename.revision,
          expectedMembershipRevision: readyAfterRename.membershipRevision,
        };
        const retrySource = { kind: 'same-op-retry' };
        s.rename.mockRejectedValueOnce(new Error('SECRET_SECOND_RENAME_FAIL'));
        expect(await membersService.editRecipe(key, retryInput, 'op-same-retry', retrySource)).toEqual({
          operationId: 'op-same-retry',
          status: 'unknown',
        });

        const receiptPut2 = vi
          .spyOn(s.domain.table('member_edits'), 'put')
          .mockRejectedValueOnce(new Error('SECRET_RECEIPT_PUT_FAIL_2'));
        expect(await s.groups.getMemberEditResult(key, 'op-same-retry')).toEqual({
          operationId: 'op-same-retry',
          status: 'unknown',
        });
        receiptPut2.mockRestore();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_RECEIPT_PUT_FAIL_2');

        const readyBeforeRetry = need(s.domain.table('groups').get(g.id));
        expect(readyBeforeRetry.state).toBe('ready');
        expect(readyBeforeRetry.name).toBe('Recovered Via Same Op Retry');
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        // Retrying the exact same operationId completes the receipt and returns the saved GroupRecord.
        const retried = await membersService.editRecipe(key, retryInput, 'op-same-retry', retrySource);
        expect(retried).toEqual({
          operationId: 'op-same-retry',
          status: 'saved',
          group: readyBeforeRetry,
        });
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();

        // Conflicting payload with the same operationId still fails with conflict.
        await expect(
          membersService.editRecipe(key, retryInput, 'op-same-retry', { kind: 'conflicting-source' }),
        ).rejects.toMatchObject({ code: 'dsh-bot/conflict' });

        // Subsequent new edits succeed cleanly.
        const nextEdit = await s.groups.edit(key, {
          name: 'After Same Op Recovery',
          mode: 'natural',
          members: [alpha, beta],
          expectedRevision: readyBeforeRetry.revision,
          expectedMembershipRevision: readyBeforeRetry.membershipRevision,
        });
        expect(nextEdit.state).toBe('ready');
        expect(nextEdit.name).toBe('After Same Op Recovery');
      } finally {
        warn.mockRestore();
        await s.close();
      }
    }));

  it('recovers ready + unknown receipt + pending_renames across real JSON restart without pruning credentials, unblocks new edits, and keeps partial members writes fail-closed', () =>
    withIntegrations(async (f) => {
      f.bots.set('gamma', { ...need(f.bots.get('alpha')), id: 'gamma', name: 'Gamma' });
      const gamma = { botId: 'gamma', botCreatedAt: 1 };
      const s = await createNaturalGroupsFixture(f);
      const warn = vi.spyOn(f.ctx.logger, 'warn');
      try {
        const g = await s.groups.create({
          operationId: 'receipt-restart-group',
          name: 'Before Restart Failure',
          members: [alpha, beta],
          mode: 'mention',
          historyConfirmed: true,
        });
        const key = groupKey(g);
        const membersService = () =>
          (s.groups as unknown as {
            membership: {
              editRecipe(
                targetKey: GroupKey,
                value: unknown,
                operationId: string,
                source: unknown,
              ): Promise<{ operationId: string; status: string; group?: GroupRecord }>;
            };
          }).membership;

        // 1) Rename fails during editRecipe -> recovery puts ready -> receipt.put fails once -> real JSON restart.
        s.rename.mockRejectedValueOnce(new Error('SECRET_RESTART_RENAME_FAIL'));
        expect(
          await membersService().editRecipe(
            key,
            {
              name: 'Restart Recovered Title',
              mode: 'natural',
              members: [alpha, beta],
              expectedRevision: g.revision,
              expectedMembershipRevision: g.membershipRevision,
            },
            'op-restart-recover',
            { kind: 'restart-test' },
          ),
        ).toEqual({ operationId: 'op-restart-recover', status: 'unknown' });

        const receiptPut = vi
          .spyOn(s.domain.table('member_edits'), 'put')
          .mockRejectedValueOnce(new Error('SECRET_RESTART_RECEIPT_FAIL'));
        expect(await s.groups.getMemberEditResult(key, 'op-restart-recover')).toEqual({
          operationId: 'op-restart-recover',
          status: 'unknown',
        });
        receiptPut.mockRestore();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_RESTART_RECEIPT_FAIL');

        const readyBeforeRestart = need(s.domain.table('groups').get(g.id));
        expect(readyBeforeRestart.state).toBe('ready');
        expect(readyBeforeRestart.name).toBe('Restart Recovered Title');
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        // First restart: inject another receipt.put failure during roots.start() -> pending_renames MUST NOT be deleted!
        const origOpen = f.ctx.storageDomain.open.bind(f.ctx.storageDomain);
        const openSpy = vi.spyOn(f.ctx.storageDomain, 'open').mockImplementationOnce(async (spec) => {
          const reopenedDomain = await origOpen(spec);
          if (spec === groupsDomain) {
            vi.spyOn(reopenedDomain.table('member_edits'), 'put').mockRejectedValueOnce(
              new Error('SECRET_BOOT_RECEIPT_FAIL'),
            );
          }
          return reopenedDomain;
        });
        await s.reopen();
        openSpy.mockRestore();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_BOOT_RECEIPT_FAIL');
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        // Second restart (storage healthy): roots.start() MUST finalize the receipt to saved and delete pending_renames only after receipt succeeds.
        await s.reopen();

        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();
        expect(await s.groups.getMemberEditResult(key, 'op-restart-recover')).toEqual({
          operationId: 'op-restart-recover',
          status: 'saved',
          group: readyBeforeRestart,
        });

        // Subsequent NEW edit() and editMembers() calls MUST succeed (not permanently blocked with recovery-needed).
        const afterRestartEdit = await s.groups.edit(key, {
          name: 'Post Restart New Edit',
          mode: 'mention',
          members: [alpha, beta],
          expectedRevision: readyBeforeRestart.revision,
          expectedMembershipRevision: readyBeforeRestart.membershipRevision,
        });
        expect(afterRestartEdit.state).toBe('ready');
        expect(afterRestartEdit.name).toBe('Post Restart New Edit');

        const afterRestartMembers = await s.groups.editMembers(key, {
          operationId: 'op-post-restart-members',
          expectedRevision: afterRestartEdit.revision,
          expectedMembershipRevision: afterRestartEdit.membershipRevision,
          members: [alpha, beta, gamma],
          historyConfirmed: true,
        });
        expect(afterRestartMembers.status).toBe('saved');
        expect(afterRestartMembers.group?.state).toBe('ready');

        // 2) Subsequent NEW saveEdit() called directly from ready + unknown receipt + pending_renames recovers first and succeeds.
        const base = need(afterRestartMembers.group);
        s.rename.mockRejectedValueOnce(new Error('SECRET_DIRECT_NEW_EDIT_RENAME_FAIL'));
        expect(
          await membersService().editRecipe(
            key,
            {
              name: 'Pending Before Direct New Edit',
              mode: 'natural',
              members: [alpha, beta, gamma],
              expectedRevision: base.revision,
              expectedMembershipRevision: base.membershipRevision,
            },
            'op-before-direct-new-edit',
            { kind: 'direct-new-edit' },
          ),
        ).toEqual({ operationId: 'op-before-direct-new-edit', status: 'unknown' });

        const receiptPutDirect = vi
          .spyOn(s.domain.table('member_edits'), 'put')
          .mockRejectedValueOnce(new Error('SECRET_DIRECT_RECEIPT_FAIL'));
        expect(await s.groups.getMemberEditResult(key, 'op-before-direct-new-edit')).toEqual({
          operationId: 'op-before-direct-new-edit',
          status: 'unknown',
        });
        receiptPutDirect.mockRestore();

        const readyBeforeDirectEdit = need(s.domain.table('groups').get(g.id));
        expect(readyBeforeDirectEdit.state).toBe('ready');
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        const directNewEdit = await s.groups.edit(key, {
          name: 'Direct New Edit Succeeded',
          mode: 'mention',
          members: [alpha, beta, gamma],
          expectedRevision: readyBeforeDirectEdit.revision,
          expectedMembershipRevision: readyBeforeDirectEdit.membershipRevision,
        });
        expect(directNewEdit.state).toBe('ready');
        expect(directNewEdit.name).toBe('Direct New Edit Succeeded');
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();
        expect(await s.groups.getMemberEditResult(key, 'op-before-direct-new-edit')).toEqual({
          operationId: 'op-before-direct-new-edit',
          status: 'saved',
          group: readyBeforeDirectEdit,
        });

        // 3) Receipt write failure directly inside initial saveEdit() (after putGroup(ready)) retains pending_renames and recovers across restart.
        const memberEditsTable = s.domain.table('member_edits');
        const originalMemberEditsPut = memberEditsTable.put.bind(memberEditsTable);
        let saveEditReceiptAttempt = 0;
        const saveEditReceiptSpy = vi.spyOn(memberEditsTable, 'put').mockImplementation(async (rowKey, value) => {
          saveEditReceiptAttempt++;
          if (saveEditReceiptAttempt === 2) throw new Error('SECRET_INITIAL_SAVE_RECEIPT_FAIL');
          return originalMemberEditsPut(rowKey, value);
        });
        expect(
          await membersService().editRecipe(
            key,
            {
              name: 'Initial Save Receipt Fail Title',
              mode: 'natural',
              members: [alpha, beta, gamma],
              expectedRevision: directNewEdit.revision,
              expectedMembershipRevision: directNewEdit.membershipRevision,
            },
            'op-initial-save-receipt-fail',
            { kind: 'initial-save-receipt-fail' },
          ),
        ).toEqual({ operationId: 'op-initial-save-receipt-fail', status: 'unknown' });
        saveEditReceiptSpy.mockRestore();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_INITIAL_SAVE_RECEIPT_FAIL');
        expect(s.domain.table('pending_renames').get(g.id)).toBeDefined();

        await s.reopen();
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();
        const recoveredInitialSave = await s.groups.getMemberEditResult(key, 'op-initial-save-receipt-fail');
        expect(recoveredInitialSave.status).toBe('saved');
        expect(recoveredInitialSave.group?.state).toBe('ready');
        expect(recoveredInitialSave.group?.name).toBe('Initial Save Receipt Fail Title');

        // 4) Genuine partial members.put failure (even with nameChanged=true) never writes pending_renames and stays strictly fail-closed.
        const latestBeforePartial = need(recoveredInitialSave.group);
        const membersPut = vi
          .spyOn(s.domain.table('members'), 'put')
          .mockRejectedValueOnce(new Error('SECRET_PARTIAL_MEMBERS_FAIL'));
        expect(
          await membersService().editRecipe(
            key,
            {
              name: 'Partial Members Fail Title',
              mode: 'mention',
              members: [alpha, beta],
              expectedRevision: latestBeforePartial.revision,
              expectedMembershipRevision: latestBeforePartial.membershipRevision,
            },
            'op-partial-members-fail',
            { kind: 'partial-members' },
          ),
        ).toEqual({ operationId: 'op-partial-members-fail', status: 'unknown' });
        membersPut.mockRestore();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_PARTIAL_MEMBERS_FAIL');
        expect(s.domain.table('pending_renames').get(g.id)).toBeUndefined();

        await s.reopen();
        const failedGroup = (await s.groups.view(key)).group;
        expect(failedGroup.state).toBe('recovery_needed');
        expect(await s.groups.getMemberEditResult(key, 'op-partial-members-fail')).toEqual({
          operationId: 'op-partial-members-fail',
          status: 'unknown',
        });
        await expect(
          s.groups.edit(key, {
            name: 'Blocked After Partial Members Failure',
            mode: 'mention',
            members: [alpha, beta],
            expectedRevision: failedGroup.revision,
            expectedMembershipRevision: failedGroup.membershipRevision,
          }),
        ).rejects.toMatchObject({ code: 'dsh-bot/recovery-needed' });
      } finally {
        warn.mockRestore();
        await s.close();
      }
    }));
});

describe('Issue #56 Fix 4: Isolated teardown and cleanup under fault injection', () => {
  it('cleans up live map, disposers, global writers map, and domain even when ReferenceWriter child.dispose() throws', async () => {
    await mkdir(testBase, { recursive: true });
    const root = await mkdtemp(join(testBase, 'ref-teardown-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const ctx = new Context();
    try {
      await ctx.plugin(Storage).await();
      await ctx.plugin(storageJson, { root }).await();
      await ctx.plugin(storageDomain, { backend: 'json' }).await();
      const domain = await ctx.storageDomain.open(referenceMemoryDomain);
      const closeSpy = vi.spyOn(domain, 'close');
      const changed = vi.fn();
      const service = new ReferenceMemory(
        ctx,
        { config: { referenceMemoryMaxFileBytes: 1024, referenceMemoryTimeoutMs: 1000 } } as unknown as DshBotRegistry,
        domain,
        changed,
      );
      const off1 = vi.fn(() => {
        throw new Error('off1 failed');
      });
      const off2 = vi.fn();
      const writerKey = join(root, 'dsh-bot', 'memory', referenceKeyOf(alpha));
      const liveEntry: ReferenceLive = {
        bot: alpha,
        agent: {} as Agent,
        identity: 'id-1',
        accepting: true,
        copying: false,
        tail: Promise.resolve(),
        allowed: new Set(),
        off: [off1, off2],
        child: {
          dispose: vi.fn(async () => {
            throw new Error('child dispose exploded');
          }),
          await: async () => {},
        },
      };
      (service as unknown as { live: Map<string, ReferenceLive> }).live.set(referenceKeyOf(alpha), liveEntry);
      writers.set(writerKey, liveEntry);

      await expect(service.close()).rejects.toThrow('child dispose exploded');
      expect(off1).toHaveBeenCalledOnce();
      expect(off2).toHaveBeenCalledOnce();
      expect((service as unknown as { live: Map<string, ReferenceLive> }).live.size).toBe(0);
      expect(writers.has(writerKey)).toBe(false);
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalled();
    } finally {
      await ctx.fiber.dispose();
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans up workerReservations and all delivery maps when activation.dispose() throws in protocol-1 and protocol-2', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      try {
        s.setOnDispose(async () => {
          throw new Error('activation dispose boom');
        });
        const g1 = await s.groups.create({
          operationId: 'p1-dispose-fault',
          name: 'P1 Fault',
          members: [alpha, beta],
          mode: 'mention',
          historyConfirmed: true,
        });
        const key1 = groupKey(g1);
        const member1 = need((await s.groups.view(key1)).members[0]);
        const t1 = await s.groups.send(key1, {
          operationId: 'p1-turn',
          text: 'Hello',
          memberIds: [member1.id],
          expectedMembershipRevision: 1,
        });
        await s.groups.waitForTurn(t1.id).catch(() => {});

        const internalState = (s.groups as unknown as { state: GroupState }).state;
        expect(internalState.workers.size).toBe(0);
        expect(workerReservations.size).toBe(0);
        expect(internalState.controllers.size).toBe(0);
        expect(internalState.inputAdmissions.size).toBe(0);
        expect(internalState.activations.size).toBe(0);
        expect(internalState.settledInputs.size).toBe(0);

        const g2 = await s.groups.create({
          operationId: 'p2-dispose-fault',
          name: 'P2 Fault',
          members: [alpha, beta],
          mode: 'natural',
          historyConfirmed: true,
        });
        const key2 = groupKey(g2);
        const member2 = need((await s.groups.view(key2)).members[0]);
        const t2 = await s.groups.send(key2, {
          operationId: 'p2-turn',
          text: 'Hello p2',
          memberIds: [member2.id],
          expectedMembershipRevision: 1,
        });
        await s.groups.waitForTurn(t2.id).catch(() => {});

        expect(internalState.workers.size).toBe(0);
        expect(workerReservations.size).toBe(0);
        expect(internalState.controllers.size).toBe(0);
        expect(internalState.inputAdmissions.size).toBe(0);
        expect(internalState.activations.size).toBe(0);
        expect(internalState.settledInputs.size).toBe(0);
      } finally {
        s.setOnDispose(undefined);
        await s.close();
      }
    }));

  it('drains all chains via Promise.allSettled and cleans activations/workerReservations in Groups.close()', () =>
    withIntegrations(async (f) => {
      const s = await createNaturalGroupsFixture(f);
      const internalState = (s.groups as unknown as { state: GroupState }).state;
      let slowFinished = false;
      const slowDone = deferred();
      const fastReject = Promise.reject(new Error('chain-1 failed'));
      void fastReject.catch(() => {});
      const slowChain = slowDone.promise.then(() => {
        slowFinished = true;
      });
      internalState.chains.set('chain-fast', fastReject);
      internalState.chains.set('chain-slow', slowChain);
      const leakedBinding = {
        turnId: 't',
        deliveryId: 'd',
        childId: 'leaked-child',
        rootId: 'r',
        presetId: 'bot-alpha',
        audience: [alpha],
      };
      internalState.workers.set('leaked-child', leakedBinding);
      workerReservations.set('leaked-child', leakedBinding);
      internalState.activations.set('act-1', {
        childId: SessionId('leaked-child'),
        result: Promise.resolve({ output: [], stopReason: 'aborted' }),
        dispose: vi.fn(async () => {
          throw new Error('activation close failed');
        }),
      });
      const domainClose = vi.spyOn(s.domain, 'close');

      const closing = s.groups.close();
      await Promise.resolve();
      expect(slowFinished).toBe(false);
      slowDone.resolve();
      await expect(closing).rejects.toBeInstanceOf(AggregateError);
      expect(slowFinished).toBe(true);
      expect(workerReservations.has('leaked-child')).toBe(false);
      expect(internalState.activations.size).toBe(0);
      expect(domainClose).toHaveBeenCalledOnce();
    }));

  it('isolates MemoryConsolidation.close() and DshBotRegistry shutdown steps when earlier steps reject', async () => {
    await withFacility(async (f) => {
      const { registry, stop } = await f.start();
      await registry.create({ id: 'alpha', name: 'Alpha' });
      const kernel = need(registry.memoryKernel);
      const consolidation = new MemoryConsolidation(
        kernel,
        ConsolidationConfig({ enabled: true }),
        () => true,
        async () => ({ text: '{"content":null,"sourceIds":[]}' }),
      );
      const failedRun = Promise.reject(new Error('consolidation active rejected'));
      void failedRun.catch(() => {});
      (consolidation as unknown as { active?: { id: string; abort: AbortController; done: Promise<unknown> } }).active = {
        id: 'op-1',
        abort: new AbortController(),
        done: failedRun,
      };
      // MemoryConsolidation.close() must NOT reject when active.done rejects!
      await expect(consolidation.close()).resolves.toBeUndefined();

      // Now inject failures into consolidationService.close() and memoryAdmission.close() inside DshBotRegistry shutdown:
      // preset leases and stores.close() MUST still execute!
      const storesClose = vi.spyOn(
        (registry as unknown as { stores: { close(): Promise<void> } }).stores,
        'close',
      );
      (registry as unknown as { consolidationService?: { close(): Promise<void> } }).consolidationService = {
        close: vi.fn(async () => {
          throw new Error('consolidation close failed');
        }),
      };
      vi.spyOn(registry.memoryAdmission, 'close').mockRejectedValueOnce(new Error('admission close failed'));

      await expect(registry.close()).rejects.toBeInstanceOf(AggregateError);
      expect(storesClose).toHaveBeenCalledOnce();
      expect(f.presets.current.size).toBe(0);
      await stop();
    });
  });

  it('always closes CoordinatorClient in ProactiveService.close() even when earlier teardown steps throw', async () => {
    await mkdir(testBase, { recursive: true });
    const root = await mkdtemp(join(testBase, 'proactive-teardown-'));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
    const ctx = new Context();
    const storeId = randomUUID();
    const clientClose = vi.fn(async () => {});
    const launchSpy = vi.spyOn(CoordinatorClient, 'launch').mockResolvedValue({
      available: true,
      request: vi.fn(async (body: { kind: string }) => {
        if (body.kind === 'hello') {
          return {
            kind: 'hello',
            storeId,
            capabilities: { ingest: true, snapshot: true, work: true, feedback: true },
          };
        }
        if (body.kind === 'work-list') return { kind: 'work-list', work: [] };
        return { kind: 'snapshot', snapshot: { storeId, executionControl: { paused: false } } };
      }),
      close: clientClose,
    } as unknown as CoordinatorClient);
    try {
      await ctx.plugin(Storage).await();
      await ctx.plugin(storageJson, { root }).await();
      await ctx.plugin(storageDomain, { backend: 'json' }).await();
      ctx.provide('subprocess', {} as Context['subprocess']);
      ctx.provide('dshBots', {
        config: { dataDir: root },
        invalidate: () => {},
        onboardingSnapshot: () => undefined,
      } as unknown as Context['dshBots']);
      const service = new ProactiveService(
        ctx,
        RegistryConfig({ dataDir: root, proactiveEnabled: true, proactiveMaintenanceIntervalMs: 60_000 }),
      );
      await service.start();
      expect((await service.status()).state).toBe('ready');
      expect(clientClose).not.toHaveBeenCalled();
      vi.spyOn(service.execution, 'close').mockRejectedValueOnce(new Error('execution close failed'));
      vi.spyOn(service.governance, 'close').mockRejectedValueOnce(new Error('governance close failed'));

      await expect(service.close()).rejects.toBeInstanceOf(AggregateError);
      expect(clientClose).toHaveBeenCalledExactlyOnceWith(storeId);
      expect((await service.status()).state).toBe('unavailable');
    } finally {
      launchSpy.mockRestore();
      await ctx.fiber.dispose();
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates Connectors, openBotStores, and NativeSchedules teardown loops when an earlier close throws', async () => {
    await withIntegrations(async (f) => {
      const a1 = f.createAgent('conn-a1');
      const a2 = f.createAgent('conn-a2');
      await f.connectors.attach(a1.agent, alpha);
      await f.connectors.attach(a2.agent, beta);
      const liveSet = (f.connectors as unknown as {
        live: Set<{ entries: Map<string, { child?: { dispose(): Promise<void> }; status: { state: string; reasonCode?: string } }> }>;
      }).live;
      const [firstLive, secondLive] = [...liveSet];
      const secondDispose = vi.fn(async () => {});
      const otherAgentDispose = vi.fn(async () => {});
      need(firstLive).entries.set('e1', {
        child: {
          dispose: vi.fn(async () => {
            throw new Error('entry 1 dispose boom');
          }),
        },
        status: { state: 'ready' },
      });
      need(firstLive).entries.set('e2', {
        child: { dispose: secondDispose },
        status: { state: 'ready' },
      });
      need(secondLive).entries.set('e3', {
        child: { dispose: otherAgentDispose },
        status: { state: 'ready' },
      });
      await expect(f.connectors.close()).rejects.toThrow('entry 1 dispose boom');
      expect(secondDispose).toHaveBeenCalledOnce();
      expect(otherAgentDispose).toHaveBeenCalledOnce();
      expect(liveSet.size).toBe(0);
    });

    // openBotStores: memory.close() still executes if bot domain.close() throws.
    await mkdir(testBase, { recursive: true });
    const storeRoot = await mkdtemp(join(testBase, 'stores-teardown-'));
    const storeCtx = new Context();
    try {
      await storeCtx.plugin(Storage).await();
      await storeCtx.plugin(storageJson, { root: resolve(storeRoot) }).await();
      await storeCtx.plugin(storageDomain, { backend: 'json' }).await();
      const stores = await openBotStores(storeCtx, { memoryV2: { dataDir: resolve(storeRoot, 'mem') } });
      const botDomainInstance = need(storeCtx.storageDomain.get('dsh_bot'));
      const memoryDomainInstance = need(stores.memoryKernel?.domain);
      vi.spyOn(botDomainInstance, 'close').mockRejectedValueOnce(new Error('bot domain close failed'));
      const memClose = vi.spyOn(memoryDomainInstance, 'close');
      await expect(stores.close()).rejects.toThrow();
      expect(memClose).toHaveBeenCalledOnce();

      // NativeSchedules: bindings.close() still executes if legacy.close() throws.
      const schedules = new NativeSchedules(storeCtx, { list: async () => [], status: async () => [] });
      await schedules.start();
      const legacyDomainInstance = (schedules as unknown as { legacy?: { close(): Promise<void> } }).legacy;
      const bindingsDomainInstance = (schedules as unknown as { bindings?: { close(): Promise<void> } }).bindings;
      vi.spyOn(need(legacyDomainInstance), 'close').mockRejectedValueOnce(new Error('legacy close failed'));
      const bindingsClose = vi.spyOn(need(bindingsDomainInstance), 'close');
      await expect(schedules.close()).rejects.toThrow('legacy close failed');
      expect(bindingsClose).toHaveBeenCalledOnce();
    } finally {
      await storeCtx.fiber.dispose();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
