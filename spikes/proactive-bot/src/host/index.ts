import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-schedule';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentActivation, SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import Schema from '@deepseek-ai/schemastery';
import { type Assignment, type BotKey, type Grant, rejectReason } from './authorization.js';
import { type HostReceipt, lifecycleDomain, openReceipts } from './receipts.js';
import { FixtureAdapter, type ModelCall, nativeIpc, provider, reply, route, toolName, until } from './runtime-support.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pb00-event': {
      kind: 'pb00-event';
      form: 'notice';
      summary: string;
      receiptId: string;
      ticketId: string;
      assignmentId: string;
      effectId: string;
    };
  }
}

export const name = 'pb00-probes';
export const inject = [
  'loader', 'llm', 'agents', 'agentPresets', 'sessions', 'sessionController',
  'subagents', 'subprocess', 'schedule', 'tools', 'approval', 'storageDomain', 'sandboxPolicy',
];
export interface Config {
  outputDir: string;
  modelUrl: string;
  subprocessFixture: string;
  productGuardModule: string;
  phase: 'live' | 'crash' | 'cold';
  timeoutMs: number;
}
export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().required(),
  modelUrl: Schema.string().required(),
  subprocessFixture: Schema.string().required(),
  productGuardModule: Schema.string().required(),
  phase: Schema.union(['live', 'crash', 'cold']).default('live'),
  timeoutMs: Schema.number().min(2000).max(60000).default(12000),
});

const presetId = 'pb00-fixture';
const bot: BotKey = { botId: 'pb00-bot', botCreatedAt: 1 };
const task: Assignment = {
  ticketId: 'pb00-ticket', assignmentId: 'pb00-assignment', effectId: 'pb00-effect',
  bot, policyRevision: 1, action: 'fixture-read', target: 'fixture-local', dataScope: 'synthetic', modelBudget: 1,
};
const childEffectId = 'pb00-native-child-source-control';
const sourceFor = (row: HostReceipt) => ({
  kind: 'pb00-event' as const, form: 'notice' as const, summary: 'PB00 local synthetic event',
  receiptId: row.receiptId, ticketId: row.assignment.ticketId, assignmentId: row.assignment.assignmentId,
  effectId: row.assignment.effectId,
});
const text = (value: string) => [{ type: 'text' as const, text: value }];
const persisted = (ctx: Context, agent: Agent) => ctx.sessions.flush(agent.session);
async function awaitIdle(agent: Agent, signal: AbortSignal) {
  let idle = false;
  void agent.whenIdle().then(() => { idle = true; });
  try { await until(() => idle ? true : undefined, signal); }
  catch (error) {
    agent.cancel({ kind: 'hook', reason: 'PB00 fixture deadline' });
    throw error;
  }
}
async function receive(agent: Agent, message: ReturnType<typeof createUserMessage>, signal: AbortSignal) {
  agent.followup(message);
  await awaitIdle(agent, signal);
}
function lastTurn(agent: Agent) {
  const turn = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end');
  return turn?.type === 'turn/end' ? turn.data.reason : undefined;
}

type Check = { status: 'PASS' | 'FAIL(CAPABILITY)' | 'FAIL'; evidence?: unknown; error?: string };
const write = (config: Config, file: string, value: unknown) =>
  writeFile(resolve(config.outputDir, file), `${JSON.stringify(value, null, 2)}\n`);

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const abort = new AbortController();
    const run = Promise.resolve().then(() => runProbes(ctx, config, abort.signal)).catch(async (error) => {
      await write(config, `${config.phase}-fatal.json`, { error: String(error), stack: error instanceof Error ? error.stack : undefined });
      console.error('PB00_HOST_FATAL', String(error));
    });
    return async () => {
      abort.abort();
      await run;
      await write(config, `${config.phase}-disposed.json`, { pid: process.pid });
    };
  });
}

async function runProbes(ctx: Context, config: Config, signal: AbortSignal) {
  await ctx.loader.await();
  signal.throwIfAborted();
  const checks: Record<string, Check> = {};
  const calls: ModelCall[] = [];
  const modelLimits = new Map<string, number>();
  const activeSignals = () => AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
  const save = () => write(config, `${config.phase}.json`, { phase: config.phase, pid: process.pid, checks, calls });
  async function check(id: string, work: () => Promise<Check> | Check) {
    try { checks[id] = await work(); }
    catch (error) { checks[id] = { status: 'FAIL', error: String(error) }; }
    await save();
  }
  const pass = (evidence: unknown): Check => ({ status: 'PASS', evidence });
  const before = ctx.llm.listProviders().map(row => row.id);
  checks.providerIsolation = { status: before.length === 0 ? 'PASS' : 'FAIL', evidence: { before } };
  assert.deepEqual(before, [], 'unexpected real model provider before registration');
  ctx.effect(() => ctx.llm.registerAdapter([provider], new FixtureAdapter(new URL(config.modelUrl), calls, modelLimits)));
  const after = ctx.llm.listProviders().map(row => row.id);
  assert.deepEqual(after, [provider]);
  checks.providerIsolation = pass({ before, after });
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    agent.ctx.effect(() => agent.ctx.tools.restrict({ allow: [] }));
  }));
  ctx.effect(() => ctx.tools.guard(({ name }) => name === toolName ? undefined : 'PB00 only permits its fixed approval probe'));
  const releasePreset = await ctx.effect(() => ctx.agentPresets.register({ id: presetId, name: 'PB00 local fixture', plugins: [] }));
  const receipts = await openReceipts(ctx);
  const releaseReceipts = await ctx.effect(() => () => receipts.close());
  const owned = new Set<AgentHandle>();
  const releaseAgents = await ctx.effect(() => async () => {
    await Promise.all([...owned].map(handle => handle.dispose()));
    owned.clear();
  });
  const createAgent = async (owner: Context) => ctx.agents.create({
    sessionId: SessionId(randomUUID()),
    meta: { cwd: config.outputDir, agentPreset: presetId },
    agentOptions: route,
    signal: activeSignals(),
    setup: async (agentCtx) => { await owner.agentPresets.mount(agentCtx, presetId); },
  });

  if (config.phase === 'crash') {
    const pending = { ...task, effectId: 'pb00-crash-effect' };
    await receipts.create({ receiptId: randomUUID(), assignment: pending, state: 'dispatching' });
    await write(config, 'crash-barrier.json', { pid: process.pid, effectId: pending.effectId, durable: receipts.get(pending.effectId)?.state });
    // The launcher kills the Host at this receipt cut, before any native dispatch.
    console.log('PB00_HOST_CRASH_BARRIER');
    return;
  }

  if (config.phase === 'cold') {
    await check('coldReceipts', async () => {
      const direct = receipts.get(task.effectId);
      const completed = receipts.get(childEffectId);
      const unknown = receipts.get('pb00-crash-effect');
      assert.equal(direct?.state, 'completed');
      assert.equal(completed?.state, 'completed');
      assert.equal(unknown?.state, 'dispatching');
      assert.ok(direct?.parentId && direct.sourceId && direct.assistantMessageId && direct.turnNumber);
      assert.ok(completed?.childId && completed.childMessageId && completed.runId);
      assert.equal(completed.parentSourceReceiptId, direct.receiptId);
      const parent = await ctx.sessionController.inspect(SessionId(direct.parentId));
      const child = await ctx.sessionController.inspect(SessionId(completed.childId));
      assert.ok(parent.events.some(event => event.type === 'user/message' && event.data.id === direct.sourceId &&
        event.data.source.kind === 'pb00-event' && event.data.source.receiptId === direct.receiptId));
      assert.ok(parent.events.some(event => event.type === 'assistant/message' &&
        event.data.message.id === direct.assistantMessageId && Number(event.data.turn) === direct.turnNumber));
      assert.ok(child.events.some(event => event.type === 'user/message' && event.data.id === completed.childMessageId &&
        event.data.source.kind === 'user'));
      assert.equal(calls.length, 0);
      return pass({ direct, completed, unknownDisposition: 'hold-and-reconcile', unknownReceipt: unknown, replays: 0 });
    });
  } else {
    await check('schedule', async () => {
      // The session is created using native sessionController so the schedule
      // service can restore and drive it through its standard admission.
      const scheduled = await ctx.sessionController.create({ cwd: config.outputDir, agentPreset: presetId });
      const sessionId = scheduled.sessionId;
      const native = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in native) throw native.error;
      let scheduleChanged = 0;
      const observer = ctx.plugin({
        apply(owner: Context) { owner.effect(() => owner.on('schedule/changed', () => { scheduleChanged++; })); },
      });
      await observer.await();
      let scheduledAt: string;
      let scheduleId: string;
      try {
        const record = await ctx.schedule.create(sessionId, { title: 'PB00 due fixture', prompt: 'PB00 synthetic scheduled source', after_seconds: 2 });
        scheduledAt = record.scheduledAt;
        scheduleId = record.id;
        const deadline = activeSignals();
        const history = await until(async () => {
          const result = await ctx.schedule.history({ sessionId, id: record.id, limit: 1 });
          if ('records' in result) return result.records[0];
        }, deadline);
        const delivered = await until(() => native.agent.session.snapshotEvents().find(event =>
          event.type === 'user/message' && event.data.id === history.messageId), deadline);
        assert.ok(delivered.type === 'user/message');
        const sourceKind: string = delivered.data.source.kind;
        assert.equal(sourceKind, 'schedule');
        await awaitIdle(native.agent, deadline);
        const turnReason = lastTurn(native.agent);
        const modelRequests = calls.filter(call => call.sessionId === sessionId).length;
        const stopped = await ctx.schedule.create(sessionId, { title: 'PB00 stop fixture', prompt: 'PB00 must never deliver', after_seconds: 2 });
        await ctx.schedule.delete({ sessionId, id: stopped.id });
        await observer.dispose();
        const changedAtUnload = scheduleChanged;
        await delay(Math.max(Date.parse(stopped.scheduledAt) - Date.now(), 0) + 200, undefined, { signal: deadline });
        const stoppedRequests = calls.filter(call => call.sessionId === sessionId).length - modelRequests;
        const stoppedHistory = await ctx.schedule.history({ sessionId, id: stopped.id, limit: 1 });
        assert.equal(stoppedRequests, 0);
        assert.ok('code' in stoppedHistory && stoppedHistory.code === 'schedule_not_found');
        assert.equal(scheduleChanged, changedAtUnload);
        const evidence = { sessionId, scheduleId, scheduledAt, history, sourceKind,
          scheduleChanged, sourceCallbackAvailable: false, sourceTriggers: 0, expectedModelRequests: 0, modelRequests, turnReason, agentOptions: native.agent.options, stoppedRequests, stoppedScheduleId: stopped.id, stoppedHistory };
        return { status: modelRequests === 0 ? 'FAIL' : 'FAIL(CAPABILITY)', evidence,
          error: modelRequests === 0 ? 'Positive native model-path control missing' : 'Native due schedule resumes the original Agent and invokes the model' };
      } finally { await observer.dispose(); }
    });

    const grant: Grant = { bot, revision: 1, action: task.action, target: task.target, dataScope: task.dataScope,
      expiresAt: Date.now() + 60000, modelBudget: 1 };
    async function accept(assignment: Assignment, currentBot: BotKey, currentGrant: Grant | undefined): Promise<HostReceipt> {
      const previous = receipts.get(assignment.effectId);
      if (previous) {
        assert.deepEqual(previous.assignment, assignment, 'conflicting assignment for known effect');
        return previous;
      }
      const rejection = rejectReason(assignment, currentBot, currentGrant, Date.now());
      const row: HostReceipt = { receiptId: randomUUID(), assignment, state: rejection ? 'denied' : 'accepted',
        ...(rejection ? { rejection } : {}) };
      await receipts.create(row);
      return row;
    }
    async function recheck(row: HostReceipt, currentBot: BotKey, currentGrant: Grant | undefined) {
      assert.equal(row.state, 'accepted');
      const rejection = rejectReason(row.assignment, currentBot, currentGrant, Date.now());
      if (rejection) await receipts.save({ ...row, state: 'denied', rejection });
      return rejection;
    }
    await check('authorizationDenials', async () => {
      const initialCalls = calls.length;
      const negatives: [string, Assignment, BotKey, Grant | undefined][] = [
        ['no-grant', task, bot, undefined],
        ['target', { ...task, target: 'another-target' }, bot, grant],
        ['action', { ...task, action: 'egress' }, bot, grant],
        ['data-scope', { ...task, dataScope: 'private' }, bot, grant],
        ['expired', task, bot, { ...grant, expiresAt: Date.now() - 1 }],
        ['revoked', task, bot, { ...grant, revoked: true }],
        ['bot-generation', task, { ...bot, botCreatedAt: bot.botCreatedAt + 1 }, grant],
        ['policy-revision', task, bot, { ...grant, revision: 2 }],
        ['budget', { ...task, modelBudget: 3 }, bot, grant],
      ];
      for (const [reason, assignment, currentBot, currentGrant] of negatives) {
        const accepted = await accept({ ...assignment, effectId: `reject-${reason}` }, currentBot, currentGrant);
        assert.equal(accepted.rejection, reason);
      }
      const races = [
        { key: 'revoked', currentBot: bot, currentGrant: { ...grant, revoked: true } },
        { key: 'bot-generation', currentBot: { ...bot, botCreatedAt: 2 }, currentGrant: grant },
        { key: 'policy-revision', currentBot: bot, currentGrant: { ...grant, revision: 2 } },
      ];
      for (const race of races) {
        const accepted = await accept({ ...task, effectId: `race-${race.key}` }, bot, grant);
        assert.equal(await recheck(accepted, race.currentBot, race.currentGrant), race.key);
        assert.equal(receipts.get(accepted.assignment.effectId)?.state, 'denied');
      }
      assert.equal(calls.length, initialCalls);
      return pass({ admission: negatives.map(([reason]) => reason), beforeSideEffect: races.map(race => race.key), modelRequests: 0, nativeStarts: 0 });
    });

    let direct: { parent: AgentHandle; receipt: HostReceipt } | undefined;
    await check('directSessionExecution', async () => {
      const initialCalls = calls.length;
      const accepted = await accept(task, bot, grant);
      // Simulate a lost accept response by reading the stable effect key
      // before creating any Agent or delivering work.
      const row = receipts.get(task.effectId);
      assert.deepEqual(row, accepted);
      assert.ok(row);
      assert.equal((await accept(task, bot, grant)).receiptId, row.receiptId);
      await assert.rejects(() => accept({ ...task, target: 'other' }, bot, grant), /conflicting assignment/);
      const parent = await createAgent(ctx);
      owned.add(parent);
      const sandbox = ctx.sandboxPolicy.resolve({ session: parent.agent.session });
      assert.equal(sandbox.mode, 'read-only');
      assert.notEqual(ctx.approval.overrideOf(parent.agent.session), 'never');
      assert.deepEqual(ctx.tools.schemas(parent.agent), []);
      assert.equal(await recheck(row, bot, grant), undefined);
      modelLimits.set(parent.agent.id, task.modelBudget);
      const input = createUserMessage({ source: sourceFor(row), content: text('PB00 fixed authorized synthetic work') });
      const dispatching: HostReceipt = { ...row, state: 'dispatching', parentId: parent.agent.id, sourceId: input.id };
      await receipts.save(dispatching);
      await receive(parent.agent, input, activeSignals());
      assert.equal(lastTurn(parent.agent)?.kind, 'completed', JSON.stringify(lastTurn(parent.agent)));
      assert.ok(await persisted(ctx, parent.agent));
      const events = parent.agent.session.snapshotEvents();
      const inputIndex = events.findIndex(event => event.type === 'user/message' && event.data.id === input.id);
      const storedInput = events[inputIndex];
      assert.ok(storedInput?.type === 'user/message');
      assert.deepEqual(storedInput.data.source, sourceFor(row));
      const start = events.slice(0, inputIndex).findLast(event => event.type === 'turn/start');
      assert.ok(start?.type === 'turn/start');
      const end = events.findIndex(event => event.type === 'turn/end' && event.data.turn === start.data.turn &&
        event.data.reason.kind === 'completed');
      assert.ok(end > inputIndex);
      const assistant = events.slice(inputIndex + 1, end).find(event =>
        event.type === 'assistant/message' && event.data.turn === start.data.turn);
      assert.ok(assistant?.type === 'assistant/message');
      assert.deepEqual(assistant.data.message.content, text(reply));
      assert.equal(calls.length - initialCalls, task.modelBudget);
      const completed: HostReceipt = { ...dispatching, state: 'completed', turnNumber: Number(assistant.data.turn),
        assistantMessageId: assistant.data.message.id };
      await receipts.save(completed);
      assert.deepEqual(receipts.get(task.effectId), completed);
      direct = { parent, receipt: completed };
      return pass({ receipt: completed, presetId, sandboxMode: sandbox.mode, toolCount: 0, approvalOverride: null,
        lostAcknowledgementRequery: true, modelRequests: calls.length - initialCalls });
    });
    await check('productRecursionGuard', async () => {
      assert.ok(direct);
      const parent = direct.parent;
      const { assertInteractiveOrigin } = await import(pathToFileURL(config.productGuardModule).href) as {
        assertInteractiveOrigin(agent: Agent, runs: undefined): void;
      };
      assert.throws(() => assertInteractiveOrigin(parent.agent, undefined), {
        code: 'automation/depth',
        message: 'Background notices cannot start another delegation chain',
      });
      return pass({ sourceKind: 'pb00-event', nativeParentSessionId: parent.agent.id,
        code: 'automation/depth', invokedProductGuard: true, interactiveDelegateInvocations: 0 });
    });

    await check('directCancellation', async () => {
      const initialCalls = calls.length;
      const handle = await createAgent(ctx);
      let intercepted = false;
      const off = await handle.agent.ctx.effect(() => handle.agent.ctx.on('agent/request', ({ signal }) => {
        intercepted = true;
        return delay(config.timeoutMs * 2, undefined, { signal }).then(() => {
          throw new Error('PB00 cancellation gate was not released');
        });
      }));
      try {
        const controller = activeSignals();
        handle.agent.followup(createUserMessage({
          source: sourceFor({ assignment: task, receiptId: 'cancellation-control', state: 'dispatching' }),
          content: text('PB00 cancellation fixture'),
        }));
        await until(() => intercepted ? true : undefined, controller);
        handle.agent.cancel({ kind: 'hook', reason: 'PB00 cancellation fixture' });
        await awaitIdle(handle.agent, controller);
        assert.equal(lastTurn(handle.agent)?.kind, 'aborted');
        assert.ok(await persisted(ctx, handle.agent));
        assert.equal(calls.length, initialCalls);
      } finally {
        await off();
        await handle.dispose();
      }
      assert.equal(ctx.agents.get(handle.agent.id), undefined);
      return pass({ sessionId: handle.agent.id, turnEnd: 'aborted', modelRequests: 0, disposed: true });
    });

    await check('backgroundDispatch', async () => {
      assert.ok(direct, 'Direct fixture must settle before checking child attribution');
      const { parent, receipt: parentReceipt } = direct;
      const initialCalls = calls.length;
      // Deliberately independent capability-only child run. Never treat this
      // path as an approved production action or a continuation of a human turn.
      const row = await accept({ ...task, assignmentId: 'pb00-child-source-control', effectId: childEffectId }, bot, grant);
      const spawn = ctx.subagents.getProvider('spawn');
      assert.ok(spawn && !spawn.inheritsParentContext && spawn.capabilities.agentPreset &&
        spawn.capabilities.agentOptions && spawn.capabilities.depthLimit);
      const childId = SessionId(randomUUID());
      const starts: SubagentRunInfo[] = [];
      const ends: SubagentRunEndInfo[] = [];
      const watch = ctx.plugin({
        apply(owner: Context) {
          owner.effect(() => owner.on('subagent/start', (run) => { if (run.id === childId) starts.push(run); }));
          owner.effect(() => owner.on('subagent/end', (run) => { if (run.id === childId) ends.push(run); }));
        },
      });
      await watch.await();
      let activation: SubagentActivation | undefined;
      try {
        assert.equal(await recheck(row, bot, grant), undefined);
        modelLimits.set(childId, task.modelBudget);
        const dispatching: HostReceipt = { ...row, state: 'dispatching', parentId: parent.agent.id,
          parentSourceReceiptId: parentReceipt.receiptId, sourceId: parentReceipt.sourceId, childId };
        await receipts.save(dispatching);
        activation = await ctx.subagents.startActivation({ childId, provider: 'spawn', label: 'PB00 fixed fixture', delivery: 'caller',
          signal: activeSignals(), request: { parent: parent.agent, agentPreset: presetId, agentOptions: route,
            prompt: text('PB00 fixed local work'), maxDepth: 1 } });
        const result = await activation.result;
        assert.equal(result.stopReason, 'completed');
        assert.deepEqual(result.output, text(reply));
        assert.equal(activation.childId, childId);
        assert.ok(activation.messageId);
        assert.equal(starts.length, 1);
        assert.equal(ends.length, 1);
        assert.equal(starts[0]?.runId, ends[0]?.runId);
        const runId = starts[0]?.runId;
        assert.ok(runId);
        const child = await ctx.sessionController.inspect(childId);
        const message = child.events.find(event => event.type === 'user/message' && event.data.id === activation?.messageId);
        assert.ok(message?.type === 'user/message');
        const completed: HostReceipt = { ...dispatching, state: 'completed', runId, childMessageId: activation.messageId };
        await receipts.save(completed);
        assert.deepEqual(receipts.get(childEffectId), completed);
        assert.equal(calls.length - initialCalls, task.modelBudget);
        const evidence = { receipt: completed, capabilityControlOnly: true, duplicateNativeStarts: starts.length - 1,
          nativeStart: starts[0], nativeEnd: ends[0], parentSource: sourceFor(parentReceipt),
          childSource: message.data.source, explicitChildSourceField: false, stopReason: result.stopReason,
          childListed: (await ctx.subagents.listChildren(parent.agent.id)).some(entry => entry.id === childId) };
        if (message.data.source.kind === 'user') return { status: 'FAIL(CAPABILITY)', evidence,
          error: 'Native startActivation emits a user-attributed initial child message and has no explicit source field' };
        return pass(evidence);
      } finally {
        await activation?.dispose();
        await watch.dispose();
      }
    });

    await check('nativeApproval', async () => {
      const handle = await createAgent(ctx);
      owned.add(handle);
      let answererCalls = 0;
      let sends = 0;
      const releaseAnswerer = await handle.agent.ctx.effect(() => handle.agent.ctx.on('approval/request', (request, next) => {
        if (request.agent !== handle.agent || request.toolName !== toolName) return next();
        answererCalls++;
        return Promise.resolve('rejected' as const);
      }, { prepend: true }));
      const releaseTool = await handle.agent.ctx.effect(() => handle.agent.ctx.tools.register(defineTool({
        name: toolName,
        description: 'Ask native approval for a synthetic external action that must be denied.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
        execute: async (_args, exec) => {
          assert.equal(exec.agent, handle.agent);
          const outcome = await ctx.approval.request({
            agent: handle.agent, toolName, callId: exec.callId, reason: 'PB00 synthetic destination and payload', signal: AbortSignal.any([exec.signal, AbortSignal.timeout(2500)]),
          });
          if (outcome === 'allowed-once') sends++;
          return outcome;
        },
      })));
      async function ask(label: string) {
        const after = handle.agent.session.snapshotEvents().length;
        await receive(handle.agent, createUserMessage({
          source: sourceFor({ assignment: task, receiptId: label, state: 'denied' }),
          content: text('PB00 native approval denial fixture'),
        }), activeSignals());
        assert.equal(lastTurn(handle.agent)?.kind, 'completed', JSON.stringify(lastTurn(handle.agent)));
        assert.ok(await persisted(ctx, handle.agent));
        const events = handle.agent.session.snapshotEvents().slice(after);
        const asked = events.find(event => event.type === 'approval/asked' && event.data.toolName === toolName);
        assert.ok(asked?.type === 'approval/asked', JSON.stringify(events.filter(event => event.type === 'tool/result')));
        const decided = events.find(event => event.type === 'approval/decided' && event.data.id === asked.data.id);
        assert.ok(decided?.type === 'approval/decided');
        return { approvalId: asked.data.id, outcome: decided.data.outcome };
      }
      try {
        const nativeDenial = await ask('approval-denial');
        assert.equal(nativeDenial.outcome, 'rejected');
        assert.equal(answererCalls, 1);
        assert.notEqual(ctx.approval.overrideOf(handle.agent.session), 'never');
        // This separate negative control asks under never and verifies that
        // the native policy itself rejects before consulting an answerer.
        setApprovalPolicy(handle.agent.session, 'never');
        const never = await ask('approval-never-negative-control');
        assert.equal(never.outcome, 'rejected');
        assert.equal(answererCalls, 1);
        setApprovalPolicy(handle.agent.session, 'ask');
        await releaseAnswerer();
        const noAnswerer = await ask('approval-no-answerer');
        assert.ok(['unavailable', 'cancelled'].includes(noAnswerer.outcome));
        assert.equal(sends, 0);
        return pass({ sessionId: handle.agent.id, nativeDenial, never, noAnswerer, answererCalls, sends });
      } finally { await releaseTool(); await releaseAnswerer(); }
    });

    await check('groupAutomaticOrigin', () => ({
      status: 'FAIL(CAPABILITY)',
      evidence: { evidenceLayer: 'SOURCE', existingProductSource: 'user', nativeChildStartExplicitSource: false, automaticDispatchAttempts: 0 },
      error: 'GroupTurns.send is an interactive source boundary. An explicit separately authorized background entry is required.',
    }));
    await check('notificationAutomaticEgress', () => ({
      status: 'FAIL(CAPABILITY)',
      evidence: { evidenceLayer: 'SOURCE', nativeApprovalRequired: true, externalPortsRegistered: 0, externalSends: 0 },
      error: 'The existing notification path requires live native approval for exact external data and destination.',
    }));

    await releaseAgents();
    await check('lifecycle', async () => {
      const base = ctx.agents.list().map(agent => agent.id).sort();
      const cycles: { cycle: number; listener: number; agents: number; subprocesses: number; storageDomains: number; pid: number }[] = [];
      let notifications = 0;
      let storageDomains = 0;
      let subprocesses = 0;
      for (let cycle = 1; cycle <= 20; cycle++) {
        const signal = activeSignals();
        let agentId: string | undefined;
        let pid: number | undefined;
        const generation = ctx.plugin({
          async apply(owner: Context) {
            await owner.effect(() => owner.on('schedule/changed', () => { notifications++; }));
            const domain = await owner.storageDomain.open(lifecycleDomain);
            storageDomains++;
            await owner.effect(() => async () => { await domain.close(); storageDomains--; });
            const handle = await createAgent(owner);
            agentId = handle.agent.id;
            await owner.effect(() => () => handle.dispose());
            let child: SubprocessHandle | undefined;
            await owner.effect(() => async () => {
              if (!child) return;
              child.terminate();
              assert.equal(await child.waitForExit(AbortSignal.timeout(config.timeoutMs)), true);
              await child.done;
              subprocesses--;
            });
            const ipc = await nativeIpc(owner, config.subprocessFixture, config.outputDir, signal, (processHandle) => {
              child = processHandle;
              subprocesses++;
            });
            pid = ipc.pid;
          },
        });
        const initialNotifications = notifications;
        try {
          await generation.await();
          assert.ok(agentId && pid);
          assert.equal(ctx.agents.list().length, base.length + 1);
          assert.equal(subprocesses, 1);
          assert.equal(storageDomains, 1);
          ctx.emit('schedule/changed');
          assert.equal(notifications, initialNotifications + 1);
        } finally { await generation.dispose(); }
        ctx.emit('schedule/changed');
        assert.equal(notifications, initialNotifications + 1);
        assert.deepEqual(ctx.agents.list().map(agent => agent.id).sort(), base);
        assert.equal(subprocesses, 0);
        assert.equal(storageDomains, 0);
        assert.ok(pid);
        assert.equal(ctx.storageDomain.get(lifecycleDomain.name), undefined);
        const exitedPid = pid;
        assert.throws(() => process.kill(exitedPid, 0), { code: 'ESRCH' });
        cycles.push({ cycle, listener: 0, agents: ctx.agents.list().length - base.length, subprocesses, storageDomains, pid });
      }
      return pass({ baselineAgents: base.length, cycles, ipc: ['stdin/stdout', 'separate control'], nativeTerminate: true });
    });
  }
  await releaseAgents();
  await releaseReceipts();
  await releasePreset();
  await save();
  console.log('PB00_HOST_DONE');
}
