import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';

// Keep the probe alive while the Bot provider it observes is replaced.
export const inject = ['loader', 'agentPresets', 'sessionController', 'sessions', 'llm', 'tools', 'approval'];
export const Config = Schema.object({
  outputDir: Schema.string().required(),
  endpoint: Schema.string().required(),
  suite: Schema.string().required(),
  fixtureEnabled: Schema.boolean().default(false).volatile(),
  fixtureExecutionEnabled: Schema.boolean().default(true).volatile(),
});
const botId = 'reload-bot';
const memory = 'SYNTHETIC_V066_PRIVATE_MEMORY';
const denied = 'v066_denied_fixture';
const untrusted = 'v066_untrusted_fixture';
const note = { policyId: 'v066-approval', text: 'Synthetic approval body' };

export class ReloadAdapter extends LlmAdapter {
  requests = [];
  tool = undefined;
  toolArguments = undefined;
  async listModels(provider) {
    return [{ provider, id: 'fixture', name: 'Synthetic reload fixture' }];
  }
  async *stream(options) {
    const { signal: _signal, ...request } = options;
    const serialized = JSON.stringify(request);
    const toolNames = (request.tools ?? []).map(tool => tool.name);
    this.requests.push({
      memory: serialized.includes(memory),
      persona: serialized.includes('SYNTHETIC_V066_PERSONA'),
      home: serialized.includes('Your private working directory'),
      tools: toolNames,
    });
    const { tool, toolArguments } = this;
    this.tool = undefined;
    this.toolArguments = undefined;
    if (tool) {
      const id = ToolCallId(randomUUID());
      const args = JSON.stringify(toolArguments ?? (tool === 'bot_notify' ? note : {}));
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const message = 'SYNTHETIC_V066_REPLY';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: message };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: message } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

async function until(check, signal) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(50, undefined, { signal });
  }
  throw new Error('Reload fixture timed out');
}

async function probeRecovery(ctx, adapter, signal, save, read) {
  const registry = () => ctx.get('dshBots');
  const proactive = () => ctx.get('dshBotProactive');
  const ready = async state => until(async () => {
    const service = proactive();
    return (await service?.status())?.state === state && registry()?.mainSessions ? service : undefined;
  }, signal);
  const setGlobalDisabled = async () => {
    const editor = ctx.get('configEditor');
    const entry = editor.entries().find(row => row.options.name === 'dsh-bot');
    assert.ok(entry);
    await editor.edit(entry, raw => ({ ...raw, proactiveEnabled: false }));
    return ready('disabled');
  };
  const committed = result => {
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    assert.equal(result.receipt.status, 'committed');
  };
  const records = () => ctx.get('dshBotNotifications').list().filter(row => row.source.kind === 'proactive');
  const service = await ready('ready');
  const oldBot = await registry().create({ id: 'old-scope', name: 'Old disabled scope', template: 'minimal' });
  const newBot = await registry().create({ id: 'new-scope', name: 'New requested scope', template: 'minimal' });
  const owner = { botId: oldBot.id, botCreatedAt: oldBot.createdAt };
  const target = { bot: owner, botUpdatedAt: oldBot.updatedAt, ...(await service.status()).directRoute };
  const scope = { repository: 'fixture/reload', branch: 'main', generation: 1 };
  const sourceId = `ci:${createHash('sha256').update(JSON.stringify([scope.repository, scope.branch])).digest('hex')}`;
  await ctx.get('dshBotNotifications').savePolicy({
    id: 'v066-recovery-notice', owner, channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 5,
    cooldownSec: 0, authorization: { mode: 'ask' },
  }, 0, true);
  committed(await service.observeCi(randomUUID(), scope, {
    complete: true, before: null, after: 'v066-fixture',
    rows: ['queued-notice', 'pending-dispatch', 'auto-after-disable'].map((job, index) => ({
      repository: scope.repository, branch: scope.branch, job, runId: String(index + 1), commit: 'c'.repeat(40),
      observedAt: new Date().toISOString(), attempt: 1, conclusion: 'failure',
    })),
  }));
  const suggestions = await service.suggestions();
  const approval = job => {
    const row = suggestions.find(item => item.job === job);
    assert.ok(row);
    return { decisionId: row.id, sourceId, policyVersion: row.policyVersion, expectedRevision: row.revision, target, approved: true };
  };
  const noticeApproval = approval('queued-notice');
  committed(await service.accept(randomUUID(), noticeApproval));
  const delivered = await until(async () => (await service.workList()).find(row =>
    row.decisionId === noticeApproval.decisionId && row.state === 'delivered'), signal);
  await service.notify(delivered.decisionId, delivered.assignmentId, signal);
  assert.ok((await service.read({ kind: 'notice-due' })).items.some(item => item.assignmentId === delivered.assignmentId));

  // Use normal coordinator commands and deliberately stop before the Host enqueue boundary.
  const pending = approval('pending-dispatch');
  committed(await service.change(randomUUID(), { kind: 'accept-decision', ...pending }));
  committed(await service.change(randomUUID(), {
    kind: 'responsibility-mutation', input: {
      kind: 'create', id: 'v066-old-auto', owner, draft: {
        name: 'Old automatic rule', mode: 'auto', source: { id: sourceId, ...scope }, target,
        action: 'inspect-ci-result', conditions: { jobs: ['auto-after-disable'] },
        acceptance: { goal: 'Explain the synthetic failure', deliverables: ['Evidence'],
          checks: [{ id: 'check', title: 'Check evidence', kind: 'both' }] },
        limits: { dailyRequests: 8, dailyTokens: 65536, taskTokens: 8192, taskAttempts: 2, taskWallTimeMs: 120000, concurrency: 1 },
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    },
  }));
  const snapshot = async current => {
    const rows = await current.workList();
    return {
      work: rows.map(row => ({ decisionId: row.decisionId, assignmentId: row.assignmentId, state: row.state,
        revision: row.revision, notice: row.notice?.state, sessionId: row.sessionId })),
      autoCandidates: (await current.read({ kind: 'auto-candidates' })).rows.map(row => row.suggestion.id),
      autoMode: (await current.responsibilities(owner))[0]?.responsibility.mode,
      due: (await current.read({ kind: 'notice-due' })).items.map(item => item.assignmentId),
      notificationRecords: records().length, modelCalls: adapter.requests.length,
      directExecution: (await current.status()).capabilities.directExecution,
    };
  };
  const beforeDisable = await snapshot(service);
  assert.equal(beforeDisable.modelCalls, 1);
  assert.equal(beforeDisable.notificationRecords, 0);
  assert.equal(beforeDisable.autoCandidates.length, 1);
  assert.equal(beforeDisable.autoMode, 'auto');
  assert.equal(beforeDisable.work.find(row => row.decisionId === pending.decisionId)?.state, 'pending');
  const disabled = await setGlobalDisabled();
  await save('recovery-before.json', { beforeDisable, disabled: (await disabled.status()).state });
  console.log('B4_WEB_READY');
  await until(() => read('enable.json').catch(() => undefined), signal);
  // 0.6.5 only exposes a global setup action. The new Bot is the intended Subject,
  // and the baseline action lacks a Subject or operationId to bind to it.
  const enableRequest = { action: 'enable-suggestions' };
  const enableReply = await disabled.setup(enableRequest);
  const reenabled = await ready('ready');
  await delay(12000, undefined, { signal });
  const afterEnable = await snapshot(reenabled);
  const disabledAgain = await setGlobalDisabled();
  const stateBeforeRetry = (await disabledAgain.status()).state;
  const staleRetry = await disabledAgain.setup(enableRequest);
  const afterRetry = await ready('ready');
  await save('recovery-result.json', {
    beforeDisable, afterEnable, enableReply, intendedSubject: { botId: newBot.id, botCreatedAt: newBot.createdAt },
    stateBeforeRetry, staleRetry, stateAfterRetry: (await afterRetry.status()).state,
    realModelRequests: 0,
  });
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController();
    const signal = stop.signal;
    const adapter = new ReloadAdapter();
    const bootId = randomUUID();
    const releases = [];
    const volatileEvents = [];
    const fixtureFlags = () => ({ enabled: config.fixtureEnabled.get(), executionEnabled: config.fixtureExecutionEnabled.get() });
    let toolBodies = 0, approvalAnswers = 0, externalSends = 0;
    const save = (name, value) => writeFile(join(config.outputDir, name), JSON.stringify(value, null, 2));
    const read = name => readFile(join(config.outputDir, name), 'utf8').then(JSON.parse);
    const run = (async () => {
      assert.equal(ctx.llm.listProviders().length, 0);
      releases.push(ctx.llm.registerAdapter(['dp-loopback'], adapter));
      for (const name of [denied, untrusted]) {
        releases.push(ctx.tools.register(defineTool({
          name, description: 'Synthetic side-effect counter', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { toolBodies++; return 'synthetic fixture body'; },
        })));
      }
      releases.push(ctx.on('approval/request', (request, next) => {
        if (request.toolName !== 'bot_notify') return next();
        approvalAnswers++;
        assert.match(request.reason, /Synthetic approval body/);
        return Promise.resolve('rejected');
      }, { prepend: true }));
      releases.push(ctx.on('loader/volatile-update', paths => {
        volatileEvents.push({ paths, flags: fixtureFlags() });
      }));
      await ctx.loader.await();
      await until(() => ctx.get('dshBots'), signal);
      const registry = () => ctx.get('dshBots');
      await registry().waitUntilReady();
      await until(() => registry()?.mainSessions, signal);
      if (config.suite === 'v066-volatile-bootstrap') {
        console.log('B4_WEB_READY');
        return;
      }
      if (config.suite === 'v066-recovery') {
        await probeRecovery(ctx, adapter, signal, save, read);
        return;
      }
      const prior = await read('before.json').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!prior) {
        await registry().create({ id: botId, name: 'Reload verification', template: 'minimal',
          persona: { prefix: 'SYNTHETIC_V066_PERSONA' }, tools: { deny: [denied] } });
        await registry().memoryFor(botId).save({ content: memory });
      }
      const bot = await registry().get(botId);
      const { sessionId } = prior ?? await registry().openConversation(botId);
      const openAgent = async () => {
        const { agent } = await ctx.sessionController.resolveAgent(sessionId);
        assert.ok(agent);
        return agent;
      };
      const activeAgent = await openAgent();
      const attachPort = async (createPolicy = false) => {
        const notifications = await until(() => ctx.get('dshBotNotifications'), signal);
        releases.push(notifications.attachPort({
          async describe() { return { targetDigest: 'v066-approval-target-v1', label: 'Synthetic target' }; },
          async send() { externalSends++; },
        }));
        if (createPolicy) await notifications.savePolicy({
          id: note.policyId, owner: { botId, botCreatedAt: bot.createdAt }, channel: 'im', targetRef: 'fixture-target',
          enabled: true, timezone: 'UTC', dailyLimit: 5, cooldownSec: 0, authorization: { mode: 'ask' },
        }, 0, false);
      };
      const probe = async (agent, phase) => {
        const initial = agent.session.snapshotEvents().length;
        const requestCount = adapter.requests.length;
        const tools = Object.fromEntries([denied, untrusted, 'bot_memory_list', 'bot_notify'].map(name =>
          [name, Boolean(agent.ctx.tools.get(name, agent))]));
        const execute = async name => {
          try {
            const result = await agent.ctx.tools.execute({
              agent, name, arguments: {}, callId: ToolCallId(randomUUID()), signal,
            });
            return result.isError ? result.error : 'success';
          } catch (error) {
            return { message: error.message, cause: error.cause?.message };
          }
        };
        const prompt = async (kind, tool) => {
          adapter.tool = tool;
          try {
            const response = await ctx.sessionController.prompt({
              sessionId, requestId: `v066-${phase}-${kind}`, mode: 'queue',
              content: [{ type: 'text', text: `Synthetic ${phase} ${kind}` }],
            }, signal);
            assert.equal(response.accepted, true);
            await Promise.race([agent.whenIdle(), delay(15000, undefined, { signal, ref: false }).then(() => {
              throw new Error('Native Agent did not return to idle');
            })]);
          } finally {
            adapter.tool = undefined;
          }
        };
        await prompt('chat');
        const direct = { denied: await execute(denied), untrusted: await execute(untrusted) };
        if (tools.bot_memory_list) await prompt('untrusted', untrusted);
        if (tools.bot_notify) await prompt('approval', 'bot_notify');
        assert.equal(await ctx.sessions.flush(agent.session), true);
        const events = agent.session.snapshotEvents().slice(initial);
        const statuses = await registry().status();
        const activities = await registry().listActivity();
        return {
          bootId, sessionId,
          mainSessionId: statuses.find(row => row.id === botId)?.mainSessionId,
          activityVisible: activities.sessions.some(row => row.sessionId === sessionId),
          tools, direct, toolBodies, approvalAnswers, externalSends,
          requests: adapter.requests.slice(requestCount),
          turns: events.filter(event => event.type === 'turn/end').map(event => event.data.reason),
          replies: events.filter(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('SYNTHETIC_V066_REPLY')).length,
          toolResults: events.filter(event => event.type === 'tool/result').map(event => event.data),
          approval: events.filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
            .map(event => ({ type: event.type, data: event.data })),
          realModelRequests: 0,
        };
      };
      if (prior) {
        const volatile = config.suite === 'v066-volatile';
        const expectedState = volatile ? 'disabled' : 'ready';
        await until(async () => (await ctx.get('dshBotProactive')?.status())?.state === expectedState, signal);
        await attachPort();
        await save('cold.json', { fixtureFlags: fixtureFlags(), ...await probe(activeAgent, 'cold') });
        console.log('B4_WEB_READY');
        return;
      }
      await attachPort(true);
      ctx.approval.setPolicy(activeAgent, 'ask');
      await save('before.json', await probe(activeAgent, 'before'));
      const old = ctx.get('dshBotProactive');
      const oldKernel = registry().memoryKernel;
      assert.ok(oldKernel);
      assert.equal(registry().memoryKernel, oldKernel);
      assert.equal((await old.status()).state, 'disabled');
      console.log('B4_WEB_READY');
      await until(() => read('enable.json').catch(() => undefined), signal);
      const callsBeforeSetup = adapter.requests.length;
      if (config.suite === 'v066-volatile') {
        const editor = ctx.get('configEditor');
        const entry = ctx.loader.resolve(ctx.loader.locate(ctx.fiber));
        assert.ok(editor.entries().includes(entry));
        const flagsBefore = fixtureFlags();
        await editor.edit(entry, raw => ({ ...raw, fixtureEnabled: true, fixtureExecutionEnabled: false }));
        const sameLiveAgent = await openAgent() === activeAgent;
        await save('warm.json', {
          flagsBefore, flagsAfter: fixtureFlags(), volatileEvents, sameLiveAgent,
          memoryKernelReplaced: registry().memoryKernel !== oldKernel, enableModelCalls: adapter.requests.length - callsBeforeSetup,
          directExecution: (await old.status()).capabilities.directExecution, ...await probe(activeAgent, 'volatile'),
        });
        return;
      }
      const enable = await old.setup({ action: 'enable-suggestions' });
      const replacement = await until(async () => {
        const service = ctx.get('dshBotProactive');
        return (await service?.status())?.state === 'ready' && registry()?.mainSessions ? service : undefined;
      }, signal);
      const status = await replacement.status();
      const enableModelCalls = adapter.requests.length - callsBeforeSetup;
      const live = await openAgent();
      const sameLiveAgent = live === activeAgent;
      let selectError;
      try {
        await ctx.agentPresets.select(live, `bot-${botId}`);
      } catch (error) {
        selectError = { message: error.message, code: error.code };
      }
      await attachPort();
      await save('warm.json', {
        enable, enableModelCalls, sameLiveAgent, memoryKernelReplaced: registry().memoryKernel !== oldKernel, selectError,
        directExecution: status.capabilities.directExecution, ...await probe(live, 'warm'),
      });
    })().catch(async error => {
      if (signal.aborted) return;
      await save('fixture-error.json', { error: String(error), stack: error.stack });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => {
      stop.abort();
      await run;
      for (const release of releases.reverse()) release();
    };
  });
}
