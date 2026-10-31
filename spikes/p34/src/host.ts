import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/dsh-api-gateway';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import TeamService from '@deepseek-ai/dsh-experimental-agent-team';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import * as mcp from '@deepseek-ai/dsh-mcp-client';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import type { DshBotRegistry } from '../../../packages/dsh-bot/lib/host/registry.js';
import { startMcpFixture } from './mcp-fixture.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'p34-group': { kind: 'p34-group'; botId: string; childSessionId: string } }
}
export const name = 'p34-probes';
export const inject = ['loader', 'dshBots', 'agents', 'agentPresets', 'agentDefaultModel', 'sessionController', 'sessions', 'subagents', 'tools', 'credentials', 'typertGateway'];
export interface Config { outputDir: string; phase: 'first' | 'cold'; timeoutMs: number }
export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().required(), phase: Schema.union(['first', 'cold']).default('first'),
  timeoutMs: Schema.number().min(1000).max(120000).default(30000),
});
const groupPreset = 'p34-group-root';
const sendText = (text: string) => [{ type: 'text' as const, text }];
export function apply(ctx: Context, config: Config) {
  ctx.effect(() => {
    const abort = new AbortController();
    const owned = new Set<AgentHandle>();
    const fibers = new Set<Fiber>();
    const disposers: (() => unknown | Promise<unknown>)[] = [];
    const results: Record<string, unknown> = {};
    const secrets: string[] = [];
    const save = (file: string, value: unknown) => writeFile(resolve(config.outputDir, file), `${JSON.stringify(value, null, 2)}\n`);
    const deadline = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('P34 deadline')), config.timeoutMs); })]); }
      finally { clearTimeout(timer); }
    };
    const check = async (id: string, work: () => unknown | Promise<unknown>) => {
      try { results[id] = { status: 'PASS', evidence: await deadline(Promise.resolve().then(work)) }; }
      catch (error) { results[id] = { status: 'FAIL', error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
      const encoded = JSON.stringify(results);
      const clean = secrets.reduce((value, secret) => value.replaceAll(secret, '[SENTINEL_REDACTED]'), encoded);
      if (encoded !== clean) results['diagnostic-sentinel-leak'] = { status: 'FAIL', error: 'A diagnostic contained a synthetic sentinel; redacted before persistence' };
      await save(`${config.phase}.json`, JSON.parse(secrets.reduce((value, secret) => value.replaceAll(secret, '[SENTINEL_REDACTED]'), JSON.stringify(results))));
    };
    const running = (async () => {
      await ctx.loader.await();
      if (abort.signal.aborted) return;
      const bots = ctx.get('dshBots') as unknown as DshBotRegistry;
      await bots.waitUntilReady();
      const openBot = async (id: string) => {
        const until = Date.now() + config.timeoutMs;
        for (;;) {
          try { return await bots.openConversation(id); }
          catch (error) { if (!(error instanceof Error) || !error.message.includes('Main sessions are starting') || Date.now() >= until) throw error; await delay(20); }
        }
      };
      const route = ctx.agentDefaultModel.currentSelection();
      assert.equal(route.provider, 'deepseek-official');
      const rootContribution = ctx.plugin({ inject: ['agentPresets'], async apply(owner: Context) {
        await owner.effect(async () => owner.agentPresets.register({ id: groupPreset, name: 'P34 root', plugins: [
          { id: 'p34-guard', name: 'dsh-bot-p34-probes/root-guard' },
        ] }));
      } });
      await rootContribution.await();
      let unregister = async () => { await rootContribution.dispose(); };
      disposers.push(() => unregister());
      const setup = async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, groupPreset); };
      const createRoot = async (id: string) => {
        const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: config.outputDir, agentPreset: groupPreset }, agentOptions: route, setup });
        owned.add(handle); return handle;
      };
      const finish = async (agent: Agent) => { await deadline(agent.whenIdle()); assert.equal(await ctx.sessions.flush(agent.session), true); };
      const names = (agent: Agent) => ctx.tools.schemas(agent).filter(t => t.name.startsWith('mcp__')).map(t => t.name).sort();
      const call = (agent: Agent, name: string) => ctx.tools.execute({ agent, name, arguments: {}, callId: ToolCallId(randomUUID()), signal: abort.signal });
      let root: AgentHandle | undefined;
      if (config.phase === 'first') {
        await check('public-entrypoints', () => ({ mcp: typeof mcp.apply, teams: typeof TeamService, route, runtimeImports: 'package roots only' }));
        await check('bots-and-owned-root', async () => {
          for (const id of ['alpha', 'beta']) await bots.create({ id, name: `P34 ${id}`, template: 'minimal', persona: { prefix: `P34_PERSONA_${id.toUpperCase()}` }, memory: { enabled: false, injectLimit: 20 } });
          const statuses = await bots.status();
          assert.ok(statuses.filter(row => ['alpha', 'beta'].includes(row.id)).every(row => row.preset.state === 'ok'));
          const alpha = await openBot('alpha'); const beta = await openBot('beta');
          root = await createRoot(`p34-root-${randomUUID()}`);
          const message = createUserMessage({ source: { kind: 'user' }, content: sendText('P34 group timeline') });
          root.agent.session.append('user/message', message, { surfaceOp: 'append' });
          await finish(root.agent);
          await save('state.json', { rootId: root.agent.id, alpha, beta, messageId: message.id });
          return { rootId: root.agent.id, alpha, beta, messageId: message.id, flush: true, botModel: (await bots.get('beta')).model ?? null };
        });
      } else {
        await check('cold-owned-root-and-identities', async () => {
          const state = JSON.parse(await readFile(resolve(config.outputDir, 'state.json'), 'utf8'));
          assert.equal(ctx.agents.get(state.rootId), undefined);
          root = await ctx.agents.resume({ resumeSessionId: SessionId(state.rootId), agentOptions: route, setup }); owned.add(root);
          assert.ok(root.agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.id === state.messageId));
          assert.ok(root.agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.source.kind === 'p34-group'));
          assert.equal((await openBot('alpha')).sessionId, state.alpha.sessionId);
          assert.equal((await openBot('beta')).sessionId, state.beta.sessionId);
          return { rootId: root.agent.id, originalMessagesRestored: true, mainIdentitiesPreserved: true };
        });
      }
      await check('group-native-prompt-blocked', async () => {
        assert.ok(root);
        const receipt = await ctx.sessionController.prompt({ sessionId: root.agent.id, requestId: randomUUID() as SessionRequestId, mode: 'queue', content: sendText('P34_ROOT_BYPASS_MUST_NOT_REACH_MODEL') }, abort.signal);
        assert.equal(receipt.accepted, true); await finish(root.agent);
        assert.ok(root.agent.session.snapshotEvents().some(e => e.type === 'turn/end' && e.data.reason.kind === 'blocked'));
        assert.equal(root.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0);
        return { receipt, terminal: 'blocked', rootAssistantMessages: 0 };
      });
      if (config.phase === 'first') {
        await check('spawn-caller-independent-presets-default-route', async () => {
          assert.ok(root);
          const provider = ctx.subagents.getProvider('spawn'); assert.ok(provider);
          assert.equal(provider.inheritsParentContext, false);
          assert.ok(provider.capabilities.agentPreset && provider.capabilities.agentOptions && provider.capabilities.depthLimit);
          const out = [];
          for (const id of ['alpha', 'beta']) {
            const status = (await bots.status()).find(row => row.id === id); assert.ok(status);
            const activation: SubagentActivation = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', label: `P34 ${id}`, signal: abort.signal,
              request: { parent: root.agent, agentPreset: status.presetId, agentOptions: route, prompt: sendText(`P34_MEMBER_${id.toUpperCase()}`), maxDepth: 1 } });
            disposers.push(() => activation.dispose());
            const result: SubagentResult = await deadline(activation.result); assert.equal(result.stopReason, 'completed'); assert.ok(result.output?.length);
            const message = createUserMessage({ source: { kind: 'p34-group', botId: id, childSessionId: activation.childId }, content: [...result.output] });
            root.agent.session.append('user/message', message, { surfaceOp: 'append' }); await finish(root.agent);
            out.push({ id, childId: activation.childId, outputMessageId: message.id, stopReason: result.stopReason, route });
            await activation.dispose();
          }
          assert.equal(root.agent.inbox.nextTurn.length + root.agent.inbox.nextStep.length, 0);
          const state = JSON.parse(await readFile(resolve(config.outputDir, 'state.json'), 'utf8'));
          assert.equal((await openBot('alpha')).sessionId, state.alpha.sessionId);
          assert.equal((await openBot('beta')).sessionId, state.beta.sessionId);
          return { members: out, callerDidNotWakeRoot: true, unchangedMainSessions: true };
        });
      }
      await check('mcp-secret-bridge-scope-hot-swap-cleanup', async () => {
        const alphaMain = await openBot('alpha'); const betaMain = await openBot('beta');
        const a = ctx.agents.get(SessionId(alphaMain.sessionId)); const b = ctx.agents.get(SessionId(betaMain.sessionId)); assert.ok(a && b);
        const standard = await ctx.sessionController.create({ cwd: config.outputDir, agentPreset: 'minimal' });
        const resolved = await ctx.sessionController.resolveAgent(standard.sessionId); assert.ok(!('error' in resolved));
        const ordinary = resolved.agent;
        const fixtureA = await startMcpFixture('alpha'); const fixtureB = await startMcpFixture('beta');
        disposers.push(() => fixtureA.close(), () => fixtureB.close());
        const refA = credentialRef('P34_ALPHA_TOKEN'); const refB = credentialRef('P34_BETA_TOKEN');
        const oldEnvA = process.env[refA]; const oldEnvB = process.env[refB];
        disposers.push(() => { if (oldEnvA === undefined) delete process.env[refA]; else process.env[refA] = oldEnvA; if (oldEnvB === undefined) delete process.env[refB]; else process.env[refB] = oldEnvB; });
        const tokenA = process.env[refA]; const tokenB = process.env[refB]; assert.ok(tokenA && tokenB); secrets.push(tokenA, tokenB);
        const credentials = ctx.credentials;
        try {
        process.env[refA] = tokenA; process.env[refB] = tokenB;
        fixtureA.authorize(tokenA); fixtureB.authorize(tokenB);
        const snapshots: unknown[] = [];
        const mount = async (agent: Agent, ref: typeof refA, url: string) => {
          const secret = await ctx.credentials.resolve(ref); assert.ok(secret);
          assert.ok(secret.value === (ref === refA ? process.env[refA] : process.env[refB]), 'Credential value must match the intended fixture account');
          // No config is passed to ctx.plugin. The secret exists only in this closure/native transport memory.
          const fiber = agent.ctx.plugin({ name: 'p34-private-mcp', inject: ['tools'], async apply(child: Context) {
            await mcp.apply(child, mcp.Config({ transport: 'streamable-http', serverName: 'github', url,
              headers: { Authorization: `Bearer ${secret.value}` }, failOnStartupError: true,
              toolCallTimeoutMs: config.timeoutMs, reconnect: { enabled: false } }));
          } });
          fibers.add(fiber);
          try { await fiber.await(); } catch (error) { await fiber.dispose(); fibers.delete(fiber); throw error; }
          snapshots.push({ config: fiber.config }); return fiber;
        };
        let clientA = await mount(a, refA, fixtureA.url); const clientB = await mount(b, refB, fixtureB.url);
        await assert.rejects(() => mount(a, refA, fixtureA.url));
        assert.deepEqual(names(a), ['mcp__github__alpha']);
        assert.deepEqual(names(a), ['mcp__github__alpha']); assert.deepEqual(names(b), ['mcp__github__beta']); assert.deepEqual(names(ordinary), []);
        assert.notEqual((await call(a, 'mcp__github__alpha')).isError, true);
        const denied = await call(b, 'mcp__github__alpha'); assert.equal(denied.isError, true);
        const rotated = `P34_SENTINEL_${randomUUID()}`; secrets.push(rotated);
        let credentialEvents = 0;
        const stopWatching = ctx.on('credentials/reference-updated', ref => { if (ref === refA) credentialEvents++; }); disposers.push(stopWatching);
        a.followup(createUserMessage({ source: { kind: 'user' }, content: sendText('P34_BUSY_ALPHA') }));
        assert.equal(a.status, 'running'); process.env[refA] = rotated;
        assert.ok((await ctx.credentials.resolve(refA))?.value === tokenA, 'CLI process layer is an immutable launch snapshot');
        await ctx.credentials.set(refA, rotated);
        assert.ok(credentialEvents >= 1);
        assert.throws(() => a.runMaintenance(async () => {}));
        assert.deepEqual(names(a), ['mcp__github__alpha']);
        await finish(a);
        await a.runMaintenance(async () => {
          await clientA.dispose(); fibers.delete(clientA); fixtureA.authorize(rotated);
          clientA = await mount(a, refA, fixtureA.url);
        });
        await call(a, 'mcp__github__alpha');
        const guard = a.ctx.tools.guard(exec => exec.name.startsWith('mcp__github__') ? 'P34 revoked' : undefined);
        disposers.push(guard);
        assert.equal((await call(a, 'mcp__github__alpha')).isError, true);
        await clientA.dispose(); fibers.delete(clientA); await clientB.dispose(); fibers.delete(clientB);
        assert.deepEqual(names(a), []); assert.deepEqual(names(b), []);
        fixtureA.failDiscovery(true);
        await assert.rejects(() => mount(a, refA, fixtureA.url));
        assert.deepEqual(names(a), []);
        fixtureA.failDiscovery(false); fixtureA.authorize('intentionally-wrong');
        await assert.rejects(() => mount(a, refA, fixtureA.url));
        assert.deepEqual(names(a), []);

        const descriptions = await Promise.all([ctx.credentials.describe(refA), ctx.credentials.describe(refB)]);
        const docs = await Promise.all(['alpha', 'beta'].map(async id => ctx.agentPresets.readDocument((await bots.status()).find(row => row.id === id)?.presetId ?? '')));
        const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
        disposers.push(() => peer.dispose());
        const remoteDto = await ctx.typertGateway.invoke({ namespace: 'dshBot', method: 'list', args: {}, peer, signal: abort.signal });
        assert.ok(Array.isArray(remoteDto) && remoteDto.length === 2);
        const surfaces = JSON.stringify({ snapshots, docs, descriptions, tools: ctx.tools.schemas(a), remoteDto });
        assert.ok(secrets.every(secret => !surfaces.includes(secret)));
        await save(`${config.phase}-config-surfaces.json`, JSON.parse(surfaces));
        await save(`${config.phase}-sentinel-check.json`, { surfacesClean: true, sentinelCount: secrets.length });
        // Scan current Host stdout via the runner, without persisting raw sentinels.

        return { separateNamespace: true, ordinaryInvisible: true, busyDeferred: true, maintenanceRotation: true, revokedDenied: true, toolsAfterDispose: names(a), fixtureA: fixtureA.stats(), fixtureB: fixtureB.stats(), surfacesClean: true, nativeRemoteDispatch: true, launchEnvironmentFrozen: true, providerManagedRotation: true, credentialEvents };
        } catch (error) {
          const causes: string[] = [];
          let current: unknown = error;
          while (current instanceof Error && causes.length < 5) { causes.push(current.message); current = current.cause; }
          const failure = JSON.stringify({ fixtureA: fixtureA.stats(), fixtureB: fixtureB.stats(), causes });
          await save(`${config.phase}-mcp-failure.json`, JSON.parse(secrets.reduce((value, secret) => value.replaceAll(secret, '[SENTINEL_REDACTED]'), failure)));
          throw error;
        } finally { await credentials.unset(refA); }
      });
      await check('stdio-process-dispose', async () => {
        assert.ok(root);
        const pidFile = resolve(config.outputDir, `${config.phase}-stdio-pid.json`);
        const fiber = root.agent.ctx.plugin({ async apply(child: Context) {
          await mcp.apply(child, mcp.Config({ transport: 'stdio', serverName: 'stdio', command: process.execPath,
            args: [resolve(config.outputDir, 'stdio-fixture.js'), pidFile], env: {}, cwd: config.outputDir,
            failOnStartupError: true, reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 20, maxAttempts: 3 } }));
        } }); fibers.add(fiber); await fiber.await();
        assert.deepEqual(names(root.agent), ['mcp__stdio__stdio']);
        const { pid } = JSON.parse(await readFile(pidFile, 'utf8'));
        process.kill(pid, 'SIGTERM');
        let replacement = pid;
        const until = Date.now() + config.timeoutMs;
        while (Date.now() < until && replacement === pid) {
          await delay(20); replacement = JSON.parse(await readFile(pidFile, 'utf8')).pid;
        }
        assert.notEqual(replacement, pid); await delay(50);
        assert.deepEqual(names(root.agent), ['mcp__stdio__stdio']);
        await fiber.dispose(); fibers.delete(fiber); assert.deepEqual(names(root.agent), []);
        assert.throws(() => process.kill(pid, 0)); assert.throws(() => process.kill(replacement, 0));
        return { pid, replacement, nativeReconnect: true, exited: true, remainingTools: [] };

      });
      await check('im-public-service', async () => {
        const service = ctx.get('dshIm') as unknown as { listBots(): Promise<unknown>; consumeInbound: unknown; describeBot: unknown; sendChecked: unknown; replyChecked: unknown } | undefined;
        assert.ok(service, 'Locked dsh-im public service is not available');
        for (const method of ['consumeInbound', 'describeBot', 'sendChecked', 'replyChecked'] as const) assert.equal(typeof service[method], 'function');
        return { methodsPresent: true, bots: await service.listBots(), realPlatformCalls: 0 };
      });
      await check('im-consumer-exclusive-dispose', () => { throw new Error('NOT_RUN: no public fake-platform injection seam for the locked real plugin; zero configured accounts. Contract mock cannot prove native fallback suppression. U04 inbound remains disabled pending this gate.'); });
      let teams: TeamService | undefined;
      await check('teams-roster-cas-dependency-inheritance', async () => {
        teams = ctx.get('agentTeams');
        if (!teams) { const fiber = ctx.plugin(TeamService, {}); fibers.add(fiber); await fiber.await(); teams = ctx.get('agentTeams'); }
        assert.ok(teams);
        const leadMain = await openBot('alpha'); const lead = ctx.agents.get(SessionId(leadMain.sessionId)); assert.ok(lead);
        if (config.phase === 'cold') {
          const rows = teams.listMembers(lead); const tasks = teams.listTasks(lead);
          assert.ok(rows.some(row => row.role === 'teammate')); assert.ok(tasks.some(task => task.status === 'completed'));
          return { rows, tasks, restoredFromNativeLog: true };
        }
        const teammate = await teams.spawnTeammate(lead, { name: 'helper', description: 'P34 inherited lead', context: 'fresh', provider: 'spawn', prompt: sendText('P34_TEAM_INHERITED_ALPHA'), signal: abort.signal });
        const child = ctx.agents.get(teammate.member.id); assert.ok(child); await finish(child);
        assert.equal(child.session.header.parentSession, lead.id);
        assert.equal(child.session.header.agentPreset, lead.session.header.agentPreset);
        const teamService = teams;
        const task = await teams.createTask(lead, { subject: 'P34 blocker', description: 'CAS native task' });
        const dependent = await teams.createTask(lead, { subject: 'P34 dependent', description: 'Must wait', blockedBy: [task.id] });
        await assert.rejects(() => teamService.updateTask(child, { taskId: dependent.id, expectedRevision: dependent.revision, action: 'claim' }));
        const raced = await Promise.allSettled([lead, child].map(agent => teamService.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })));
        assert.equal(raced.filter(row => row.status === 'fulfilled').length, 1);
        const index = raced.findIndex(row => row.status === 'fulfilled'); const winner = index === 0 ? lead : child;
        const claimed = teams.getTask(lead, task.id);
        await teams.updateTask(winner, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' });
        assert.equal(teams.getTask(lead, dependent.id).ready, true);
        assert.equal(await ctx.sessions.flush(lead.session), true);
        return { roster: teams.listMembers(lead), tasks: teams.listTasks(lead), casWinners: 1, dependencyBlocked: true, inheritedPreset: child.session.header.agentPreset, independentBotPresetUnsupported: true };
      });
      await check('root-resume-race-and-retained-guard', async () => {
        assert.ok(root);
        const id = root.agent.id;
        await assert.rejects(() => ctx.agents.resume({ resumeSessionId: id, agentOptions: route, setup })); await root.dispose(); owned.delete(root);
        const native = await ctx.sessionController.resolveAgent(id); assert.ok(!('error' in native));
        await assert.rejects(() => ctx.agents.resume({ resumeSessionId: id, agentOptions: route, setup }));
        await unregister(); unregister = async () => {};
        const receipt = await ctx.sessionController.prompt({ sessionId: id, requestId: randomUUID() as SessionRequestId, mode: 'queue', content: sendText('P34_ROOT_AFTER_PRESET_UNREGISTER') }, abort.signal);
        assert.equal(receipt.accepted, true); await finish(native.agent);
        assert.equal(native.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message').length, 0);
        assert.equal(native.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason.kind, 'blocked');
        return { duplicateResumeRejected: true, controllerOwnedNotTakenOver: true, retainedGenerationGuard: true, contributionFiberUnloaded: true, rootAssistantMessages: 0 };
      });
      console.log('P34_PROBES_DONE', config.phase);
    })().catch(async error => { results.fatal = { status: 'FAIL', error: String(error) }; await save(`${config.phase}.json`, results); console.log('P34_PROBES_DONE', config.phase); });
    return async () => {
      abort.abort(); await running;
      const errors: string[] = [];
      const cleanup = async (work: () => unknown | Promise<unknown>) => { try { await work(); } catch (error) { errors.push(String(error)); } };
      for (const fiber of fibers) await cleanup(() => fiber.dispose());
      for (const handle of owned) await cleanup(() => handle.dispose());
      owned.clear(); fibers.clear();
      for (const dispose of disposers.reverse()) await cleanup(dispose);
      await save(`${config.phase}-disposed.json`, { disposed: errors.length === 0, ownedHandles: owned.size, pendingFibers: fibers.size, errors });

    };
  });
}
