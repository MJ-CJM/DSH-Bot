import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ReloadAdapter } from './v066-reload-profile.mjs';

export const inject = ['loader', 'llm', 'sessions', 'sessionPersistence', 'sessionController', 'tools', 'approval', 'typertGateway'];
const botId = 'scope-bot';
const otherBot = 'other-bot';
const thirdBot = 'third-bot';
const denied = 'v066_denied_fixture';
const untrusted = 'v066_untrusted_fixture';
const noteId = 'v066-approval';
const oldNotice = 'v066-old-notice';
const watchTool = 'bot_follow_up';
const membershipPrivate = 'Synthetic product lifecycle membership-private-marker';
const membershipFailure = 'SYNTHETIC_GROUP_MEMBERSHIP_PREDECESSOR_FAILURE';
const membershipContinuation = 'SYNTHETIC_GROUP_MEMBERSHIP_APPROVED_CONTINUATION';

class MembershipAdapter extends ReloadAdapter {
  trace = [];
  async *stream(options) {
    const input = JSON.stringify(options.messages);
    this.trace.push({ sessionId: options.sessionId, hasPrivate: input.includes(membershipPrivate),
      predecessor: input.includes(membershipFailure), continuation: input.includes(membershipContinuation) });
    if (options.messages.some(message => message.content.some(block => block.type === 'text' &&
        block.text.includes(`"question":"${membershipFailure}"`)))) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic predecessor failed', code: 'INVALID_REQUEST', status: 400 } } };
      return;
    }
    yield* super.stream(options);
  }
}

async function runMembership({ ctx, saved, members, active, policyRevision, adapter, invoke, wait, signal }) {
  const subject = saved.group;
  const groups = ctx.get('dshBotGroups');
  const view = () => groups.view(subject.group);
  const cards = async value => (await invoke('followUpPage', { subject: value })).rows;
  const exactWatch = async () => {
    const rows = await cards(subject);
    assert.deepEqual(rows.filter(row => row.origin.kind === 'watch'), [active]);
    assert.ok(!JSON.stringify(rows).includes(membershipPrivate));
    for (const member of members) {
      assert.equal((await invoke('followUpSummary', member)).summary.policy.localEnabled, true);
      assert.deepEqual(await cards(member), []);
    }
  };
  const ownHistory = await persistedEvents(ctx, saved.sessionId, signal);
  assert.ok(ownHistory.some(event => event.type === 'user/message' && event.data.content.some(block => block.text === membershipPrivate)));
  const groupCalls = () => adapter.trace;
  assert.equal(groupCalls().length, 0);
  const initial = await view();
  const select = snapshot => snapshot.members.find(row => row.enabled && row.bot.botId === members[0].bot.botId);
  const oldMember = select(initial);
  const reporter = initial.members.find(row => row.enabled && row.bot.botId === members[1].bot.botId);
  assert.ok(oldMember && reporter);
  const predecessor = await groups.send(subject.group, { operationId: randomUUID(), text: membershipFailure,
    expectedMembershipRevision: initial.group.membershipRevision, memberIds: [reporter.id] });
  const settled = id => wait(async () => {
    const row = (await view()).turns.find(turn => turn.id === id);
    return row && !['accepted', 'running'].includes(row.state) && row;
  });
  assert.equal((await settled(predecessor.id)).state, 'partial');
  const failed = await wait(async () => (await cards(subject)).find(row => row.origin.kind === 'group-turn' &&
    row.origin.turnId === predecessor.id && row.condition.kind === 'failed'));
  const card = { subject, cardId: failed.id, expectedRevision: failed.revision };
  const choice = async memberId => (await invoke('followUpGroupChoice', { ...card, memberId })).choice;
  const previous = await choice(oldMember.id);
  assert.equal(groupCalls().length, 1);
  assert.equal(groupCalls()[0].predecessor, true);
  const turnIds = async () => (await view()).turns.map(turn => turn.id);
  const priorTurns = await turnIds();
  const beforeChanges = groupCalls().length;
  const accept = input => invoke('followUpGroupAccept', { ...card, commandId: randomUUID(), choice: input,
    text: membershipContinuation, approved: true, expectedPolicyRevision: policyRevision });
  const edit = async next => {
    const { group } = await view();
    return groups.edit(subject.group, { name: group.name, mode: group.mode, expectedRevision: group.revision,
      expectedMembershipRevision: group.membershipRevision, members: next.map(member => member.bot), historyConfirmed: true });
  };
  const removed = await edit(members.slice(1));
  assert.ok(!select(await view()));
  await assert.rejects(() => choice(oldMember.id));
  const departed = await accept(previous);
  assert.deepEqual(departed, { kind: 'rejected', code: 'stale' });
  await exactWatch();
  assert.equal(groupCalls().length, beforeChanges);
  assert.deepEqual(await turnIds(), priorTurns);
  const joined = await edit(members);
  const rejoined = select(await view());
  assert.ok(rejoined);
  assert.notEqual(rejoined.id, oldMember.id);
  assert.ok(joined.membershipRevision > removed.membershipRevision && removed.membershipRevision > previous.membershipRevision);
  const stale = await accept(previous);
  assert.deepEqual(stale, { kind: 'rejected', code: 'stale' });
  await exactWatch();
  await delay(800, undefined, { signal });
  assert.equal(groupCalls().length, beforeChanges);
  assert.deepEqual(await turnIds(), priorTurns);
  const fresh = await choice(rejoined.id);
  assert.equal(fresh.membershipRevision, joined.membershipRevision);
  const started = await accept(fresh);
  assert.equal(started.kind, 'started', JSON.stringify(started));
  assert.equal((await settled(started.turnId)).state, 'completed');
  const [delivery, ...extra] = (await view()).deliveries.filter(row => row.turnId === started.turnId);
  assert.equal(extra.length, 0);
  assert.equal(delivery.memberId, rejoined.id);
  assert.equal(delivery.state, 'completed');
  assert.equal(groupCalls().length - beforeChanges, 1);
  assert.deepEqual(groupCalls().at(-1), { sessionId: delivery.childSessionId, hasPrivate: false, predecessor: false, continuation: true });
  assert.ok(groupCalls().every(call => !call.hasPrivate));
  for (const id of [saved.rootId, saved.workerId, ...groupCalls().map(call => call.sessionId)]) {
    const events = await persistedEvents(ctx, id, signal);
    assert.ok(!JSON.stringify(events).includes(membershipPrivate));
  }
  await exactWatch();
  return { group: subject, card: active.id, oldMember: oldMember.id, newMember: rejoined.id, departed, stale,
    membershipRevisions: [previous.membershipRevision, removed.membershipRevision, joined.membershipRevision],
    rejectedModelRequests: 0, acceptedModelRequests: 1, acceptedTurn: started.turnId, selectedDelivery: delivery.id,
    activePersonalScopesWithoutCards: members.length, privateInputReachedOnlyMain: true, realModelRequests: 0 };
}

function storedWatch(cardId) {
  const db = new DatabaseSync(join(process.env.DSH_HOME, 'dsh-bot-proactive', 'core.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT watch FROM pb_follow_up_head WHERE id=?').get(cardId);
    return row?.watch ? JSON.parse(row.watch) : undefined;
  } finally { db.close(); }
}

function nativeApproval(events, phase, outcome, after = -1) {
  const asked = events.find(event => event.seq > after && event.type === 'approval/asked' && event.data.toolName === watchTool);
  assert.ok(asked, `Missing native approval for ${phase}: ${JSON.stringify(events.filter(event => event.type === 'tool/result').map(event => event.data))}`);
  const decided = events.find(event => event.type === 'approval/decided' && event.data.id === asked.data.id);
  assert.equal(decided?.data.outcome, outcome);
  const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === asked.data.callId);
  assert.ok(result, `Missing native tool result for ${phase}`);
  assert.equal(Boolean(result.data.message.isError), outcome === 'rejected', JSON.stringify(result.data));
  return asked.data.id;
}

function watchTurn(events, phase, outcome) {
  const user = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user' &&
    event.data.content.some(block => block.type === 'text' && block.text === `Synthetic product lifecycle watch-${phase}`));
  assert.ok(user, `Missing original human message for ${phase}`);
  return { messageId: user.data.id, approvalId: nativeApproval(events, phase, outcome, user.seq) };
}

async function persistedEvents(ctx, sessionId, signal) {
  const reader = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
  try {
    const { events } = await reader.read(Number(reader.inheritedEventCount), 128, { signal });
    assert.ok(events.length < 128, 'Synthetic native session unexpectedly needs pagination');
    return events;
  } finally { await reader.close(); }
}

async function verifyGroupWatchProof(ctx, rootId, workerId, turnId, signal) {
  const root = await persistedEvents(ctx, rootId, signal);
  const user = root.find(event => event.type === 'user/message' && event.data.source.kind === 'user' &&
    event.data.source.turnId === turnId && event.data.content.some(block => block.text === 'Synthetic human group watch request'));
  assert.ok(user, 'Missing original human group input');
  assert.equal(root.filter(event => event.type === 'request/header').length, 0);
  const worker = await persistedEvents(ctx, workerId, signal);
  assert.deepEqual(worker.findLast(event => event.type === 'approval/policy')?.data, { policy: 'never', source: 'delegation' });
  assert.equal(worker.some(event => event.type === 'approval/asked' && event.data.toolName === watchTool), false);
  const call = worker.find(event => event.type === 'tool/call' && event.data.name === watchTool);
  assert.ok(call, 'Missing persisted original group tool call');
  const result = worker.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
  assert.ok(result && !result.data.message.isError, JSON.stringify(result?.data));
  assert.match(JSON.stringify(result.data.message.content), /awaiting-owner-confirmation/);
  return { kind: 'group-proposal', sessionId: rootId, messageId: user.data.id, workerSessionId: workerId, toolCallId: call.data.callId };
}

async function runGroupWatch({ ctx, group, groupRecord, personal, other, adapter, invoke, wait, releases, signal }) {
  const groups = ctx.get('dshBotGroups');
  const view = () => groups.view(group.group);
  const selected = (await view()).members.find(member => member.bot.botId === personal.bot.botId);
  assert.ok(selected);
  const draft = { action: 'create', title: 'Synthetic group release report', completion: 'Group owner confirms the report' };
  let approvalCalls = 0;
  releases.push(ctx.on('approval/request', (request, next) => {
    if (request.toolName !== watchTool) return next();
    approvalCalls++;
    return Promise.resolve('allowed-once');
  }, { prepend: true }));
  const from = adapter.requests.length;
  adapter.tool = watchTool;
  adapter.toolArguments = draft;
  const turn = await groups.send(group.group, { operationId: randomUUID(), text: 'Synthetic human group watch request',
    expectedMembershipRevision: groupRecord.membershipRevision, memberIds: [selected.id] });
  const final = await wait(async () => {
    const current = await view();
    const saved = current.turns.find(item => item.id === turn.id);
    return saved && ['idle', 'completed', 'partial', 'stopped', 'recovery_needed'].includes(saved.state) && current;
  });
  const deliveries = final.deliveries.filter(row => row.turnId === turn.id && row.reasonCode !== 'message-published');
  assert.equal(deliveries.length, 1);
  const [worker] = deliveries;
  assert.equal(worker.state, 'completed', JSON.stringify(worker));
  assert.ok(worker.childSessionId);
  const source = await verifyGroupWatchProof(ctx, groupRecord.rootSessionId, worker.childSessionId, turn.id, signal);
  const [card] = (await invoke('followUpPage', { subject: group })).rows.filter(item => item.origin.kind === 'watch');
  assert.equal(card?.title, draft.title);
  assert.deepEqual(card.condition, { kind: 'approval-pending', completion: draft.completion });
  const persisted = storedWatch(card.id);
  assert.equal(persisted.state, 'pending');
  assert.deepEqual(persisted.source, source);
  assert.deepEqual((await invoke('followUpPage', { subject: personal })).rows, []);
  assert.deepEqual((await invoke('followUpPage', { subject: other })).rows, []);
  assert.equal(approvalCalls, 0);
  const promptModelRequests = adapter.requests.length - from;
  assert.equal(promptModelRequests, 2);
  assert.ok(adapter.requests[from].tools.includes(watchTool));
  await delay(1100, undefined, { signal });
  assert.equal(adapter.requests.length - from, promptModelRequests);
  return { group, rootId: groupRecord.rootSessionId, workerId: worker.childSessionId, turnId: turn.id, card, source,
    promptModelRequests, additionalModelRequests: 0, realModelRequests: 0 };
}

async function runWatchTurns({ ctx, agent, sessionId, personal, other, adapter, prompt, invoke, releases, signal }) {
  const page = subject => invoke('followUpPage', { subject });
  const before = adapter.requests.length;
  let approval = 'rejected';
  const seenReasons = [];
  releases.push(ctx.on('approval/request', (request, next) => {
    if (request.toolName !== watchTool) return next();
    seenReasons.push(request.displayReason);
    return Promise.resolve(approval);
  }, { prepend: true }));
  const run = async (phase, args) => {
    const from = agent.session.snapshotEvents().length;
    const requests = adapter.requests.length;
    await prompt(`watch-${phase}`, watchTool, args);
    assert.equal(adapter.requests.length - requests, 2, `${phase} needs one native tool turn and its reply`);
    assert.ok(adapter.requests[requests].tools.includes(watchTool));
    return watchTurn(agent.session.snapshotEvents().slice(from), phase, approval);
  };
  const source = turn => ({ kind: 'message', sessionId, messageId: turn.messageId, confirmationId: `${sessionId}:${turn.approvalId}` });
  const draft = { title: 'Synthetic release report', completion: 'Owner confirms the report',
    waitReason: 'Waiting for logs', inputRequest: 'Provide the synthetic logs' };
  const denied = await run('reject', { action: 'create', ...draft, title: 'Rejected synthetic watch' });
  assert.deepEqual((await page(personal)).rows, []);
  approval = 'allowed-once';
  const created = await run('create', { action: 'create', ...draft });
  const [first] = (await page(personal)).rows;
  assert.equal(first.condition.kind, 'waiting-input');
  assert.equal(first.title, draft.title);
  assert.deepEqual(storedWatch(first.id).source, source(created));
  const updated = await run('update', { action: 'update', cardId: first.id, expectedRevision: first.revision,
    title: 'Synthetic release report revised', completion: 'Owner approves the revision' });
  const [second] = (await page(personal)).rows;
  assert.equal(second.id, first.id);
  assert.equal(second.revision, first.revision + 1);
  assert.deepEqual(second.condition, { kind: 'tracking', completion: 'Owner approves the revision' });
  assert.deepEqual(storedWatch(first.id).source, source(updated));
  const completed = await run('complete', { action: 'complete', cardId: second.id, expectedRevision: second.revision });
  const [card] = (await page(personal)).rows;
  assert.equal(card.id, first.id);
  assert.equal(card.revision, second.revision + 1);
  assert.equal(card.state, 'closed');
  assert.equal(storedWatch(card.id).state, 'completed');
  assert.deepEqual((await page(other)).rows, []);
  assert.equal(seenReasons.length, 4);
  assert.ok(seenReasons.every(reason => reason.en.includes('Scoped Bot') && reason.zh.includes('Scoped Bot')));
  assert.ok(seenReasons[0].en.includes('Rejected synthetic watch'));
  assert.ok(seenReasons[2].en.includes('Synthetic release report revised'));
  const promptModelRequests = adapter.requests.length - before;
  assert.equal(promptModelRequests, 8);
  await delay(1100, undefined, { signal });
  assert.equal(adapter.requests.length - before, promptModelRequests);
  return { sessionId, card, turns: { reject: denied, create: created, update: updated, complete: completed },
    updatedSource: source(updated), promptModelRequests, additionalModelRequests: 0, realModelRequests: 0 };
}

const workState = async service => (await service.workList()).map(row => ({
  assignmentId: row.assignmentId, state: row.state, revision: row.revision, notice: row.notice?.state ?? null,
}));

async function stageLegacy(service, registry, notices, owner, wait, signal) {
  const ci = { repository: 'fixture/v066-lifecycle', branch: 'main', generation: 1 };
  const sourceId = `ci:${createHash('sha256').update(JSON.stringify([ci.repository, ci.branch])).digest('hex')}`;
  const bot = await registry.get(owner.botId);
  const status = await service.status();
  assert.ok(status.directRoute);
  const target = { bot: owner, botUpdatedAt: bot.updatedAt, ...status.directRoute };
  const committed = reply => {
    assert.equal(reply.kind, 'receipt', JSON.stringify(reply));
    assert.equal(reply.receipt.status, 'committed');
  };
  await notices.savePolicy({
    id: oldNotice, owner, channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 5,
    cooldownSec: 0, authorization: { mode: 'ask' },
  }, 0, true);
  committed(await service.observeCi(randomUUID(), ci, {
    complete: true, before: null, after: 'v066-old-1',
    rows: ['notice', 'pending', 'auto'].map((job, index) => ({
      repository: ci.repository, branch: ci.branch, job, runId: String(index + 1), commit: 'd'.repeat(40),
      observedAt: new Date().toISOString(), attempt: 1, conclusion: 'failure',
    })),
  }));
  const suggestions = await service.suggestions();
  const approve = job => {
    const row = suggestions.find(item => item.job === job);
    assert.ok(row);
    return { decisionId: row.id, sourceId, policyVersion: row.policyVersion, expectedRevision: row.revision, approved: true, target };
  };
  const accepted = approve('notice');
  committed(await service.accept(randomUUID(), accepted));
  const delivered = await wait(async () => (await service.workList()).find(row =>
    row.decisionId === accepted.decisionId && row.state === 'delivered'));
  await service.notify(delivered.decisionId, delivered.assignmentId, signal);
  assert.ok((await service.read({ kind: 'notice-due' })).items.some(item => item.assignmentId === delivered.assignmentId));
  committed(await service.change(randomUUID(), { kind: 'accept-decision', ...approve('pending') }));
  committed(await service.change(randomUUID(), { kind: 'responsibility-mutation', input: {
    kind: 'create', id: 'v066-old-auto', owner, draft: {
      name: 'Old automatic rule', mode: 'auto', source: { id: sourceId, ...ci }, target,
      action: 'inspect-ci-result', conditions: { jobs: ['auto'] },
      acceptance: { goal: 'Explain the synthetic failure', deliverables: ['Evidence'],
        checks: [{ id: 'check', title: 'Check evidence', kind: 'both' }] },
      limits: { dailyRequests: 8, dailyTokens: 65536, taskTokens: 8192, taskAttempts: 2, taskWallTimeMs: 120000, concurrency: 1 },
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  } }));
  assert.equal((await service.read({ kind: 'auto-candidates' })).rows.length, 1);
  const work = await workState(service);
  assert.ok(work.some(row => row.state === 'pending' && row.revision === 0));
  assert.ok(work.some(row => row.state === 'delivered' && row.notice === 'intent'));
  assert.equal(notices.list().filter(row => row.source.kind === 'proactive').length, 0);
  return work;
}

async function checkLegacy(service, notices, expected) {
  if (!expected) return;
  assert.deepEqual(await workState(service), expected);
  assert.deepEqual((await service.read({ kind: 'auto-candidates' })).rows, []);
  assert.deepEqual((await service.read({ kind: 'notice-due' })).items, []);
  assert.equal(notices.list().filter(row => row.source.kind === 'proactive').length, 0);
  assert.equal((await service.status()).capabilities.directExecution, false);
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController();
    const signal = stop.signal;
    const membershipProbe = config.suite === 'v066-follow-up-group-membership';
    const adapter = membershipProbe ? new MembershipAdapter() : new ReloadAdapter();
    const registry = () => ctx.get('dshBots');
    const service = () => ctx.get('dshBotProactive');
    const save = (name, value) => writeFile(join(config.outputDir, name), JSON.stringify(value, null, 2));
    const releases = [];
    let peer, externalSends = 0, toolBodies = 0;
    const wait = async check => {
      for (let n = 0; n < 400; n++) {
        const result = await check();
        if (result) return result;
        await delay(50, undefined, { signal });
      }
      throw new Error('Product lifecycle fixture timed out');
    };
    const run = (async () => {
      assert.equal(ctx.llm.listProviders().length, 0);
      releases.push(ctx.llm.registerAdapter(['dp-loopback'], adapter));
      for (const name of [denied, untrusted]) {
        releases.push(ctx.tools.register(defineTool({
          name, description: 'Synthetic side-effect counter', parameters: {},
          output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
          async execute() { toolBodies++; return 'synthetic body'; },
        })));
      }
      releases.push(ctx.on('approval/request', (request, next) =>
        request.toolName === 'bot_notify' ? Promise.resolve('rejected') : next(), { prepend: true }));
      await ctx.loader.await();
      await wait(() => registry()?.mainSessions && ctx.get('dshBotGroups') && service());
      const crashProbe = config.suite === 'v066-follow-up-crash';
      const groupWatchProbe = config.suite === 'v066-follow-up-group-watch-tool' || membershipProbe;
      const watchProbe = config.suite === 'v066-follow-up-watch-tool' || groupWatchProbe;
      const stateFile = crashProbe ? 'product-crash-intent.json' : watchProbe ? 'product-watch-warm.json' : 'product-warm.json';
      const saved = await readFile(join(config.outputDir, stateFile), 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input, namespace = 'dshBot.proactive') =>
        ctx.typertGateway.invoke({ namespace, method, args: { input }, peer, signal });
      const notices = ctx.get('dshBotNotifications');
      releases.push(notices.attachPort({
        async describe() { return { targetDigest: 'v066-approval-target-v1', label: 'Synthetic target' }; },
        async send() { externalSends++; },
      }));
      if (!saved) {
        await registry().create({ id: botId, name: 'Scoped Bot', template: 'minimal',
          persona: { prefix: 'SYNTHETIC_V066_PERSONA' }, tools: { deny: [denied] } });
        await registry().create({ id: otherBot, name: 'Other Bot', template: 'minimal' });
        if (membershipProbe) await registry().create({ id: thirdBot, name: 'Third Bot', template: 'minimal' });
        await registry().memoryFor(botId).save({ content: 'SYNTHETIC_V066_PRIVATE_MEMORY' });
      }
      const key = async id => {
        const bot = await registry().get(id);
        return { botId: id, botCreatedAt: bot.createdAt };
      };
      const personal = { kind: 'bot', bot: await key(botId) };
      const other = { kind: 'bot', bot: await key(otherBot) };
      const personalScopes = [personal, other];
      if (membershipProbe) personalScopes.push({ kind: 'bot', bot: await key(thirdBot) });
      if (!saved) await notices.savePolicy({
        id: noteId, owner: personal.bot, channel: 'im', targetRef: 'fixture-target',
        enabled: true, timezone: 'UTC', dailyLimit: 5, cooldownSec: 0, authorization: { mode: 'ask' },
      }, 0, false);
      const { sessionId } = saved ?? await registry().openConversation(botId);
      const { agent } = await ctx.sessionController.resolveAgent(sessionId);
      assert.ok(agent);
      if (!saved) ctx.approval.setPolicy(agent, 'ask');
      const prompt = async (phase, tool, toolArguments) => {
        adapter.tool = tool;
        adapter.toolArguments = toolArguments;
        assert.equal((await ctx.sessionController.prompt({
          sessionId, requestId: `v066-product-${phase}`, mode: 'queue',
          content: [{ type: 'text', text: `Synthetic product lifecycle ${phase}` }],
        }, signal)).accepted, true);
        await agent.whenIdle();
        // The watch tool must flush its own approval. The fixture never flushes these turns.
        if (tool !== watchTool) assert.equal(await ctx.sessions.flush(agent.session), true);
        assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed');
      };
      const checkGuards = async phase => {
        const from = adapter.requests.length;
        const eventFrom = agent.session.snapshotEvents().length;
        await prompt(`${phase}-chat`);
        await prompt(`${phase}-unaudited`, untrusted);
        await prompt(`${phase}-approval`, 'bot_notify');
        const requests = adapter.requests.slice(from);
        assert.equal(requests.length, 5);
        assert.ok(requests.every(row => row.memory && row.persona && row.home &&
          row.tools.includes('bot_memory_list') && row.tools.includes('bot_notify') && !row.tools.includes(denied)));
        const events = agent.session.snapshotEvents().slice(eventFrom);
        assert.ok(events.some(event => event.type === 'tool/result' && JSON.stringify(event.data).includes('Data export blocked')));
        const asked = events.find(event => event.type === 'approval/asked' && event.data.toolName === 'bot_notify');
        assert.ok(asked);
        assert.ok(events.some(event => event.type === 'approval/decided' &&
          event.data.id === asked.data.id && event.data.outcome === 'rejected'));
        assert.equal(toolBodies, 0);
        assert.equal(externalSends, 0);
        return { requests: requests.length, approvalRejected: true, blockedToolBodies: toolBodies, externalSends };
      };
      const summary = subject => invoke('followUpSummary', subject);
      const assertReceipt = result => assert.equal(result.kind, 'receipt', JSON.stringify(result));
      const editor = ctx.get('configEditor');
      const entry = editor.entries().find(row => row.options.name === 'dsh-bot');
      assert.ok(entry);
      const disable = () => editor.edit(entry, raw => ({ ...raw, proactiveEnabled: false }));
      if (saved) {
        assert.equal((await registry().openConversation(botId)).sessionId, sessionId);
        if (groupWatchProbe) {
          const status = await wait(async () => {
            const row = await summary(saved.group);
            return row.state === 'ready' && row;
          });
          assert.deepEqual(await verifyGroupWatchProof(ctx, saved.rootId, saved.workerId, saved.turnId, signal), saved.source);
          const page = async () => (await invoke('followUpPage', { subject: saved.group })).rows.filter(row => row.origin.kind === 'watch');
          assert.deepEqual(await page(), [saved.card]);
          assert.deepEqual(storedWatch(saved.card.id).source, saved.source);
          assert.equal(storedWatch(saved.card.id).state, 'pending');
          const turnIds = async () => (await ctx.get('dshBotGroups').view(saved.group.group)).turns.map(turn => turn.id);
          const originalTurns = await turnIds();
          const confirm = { commandId: randomUUID(), subject: saved.group, cardId: saved.card.id, expectedRevision: saved.card.revision,
            expectedPolicyRevision: status.summary.policy.revision, action: 'confirm-watch' };
          assert.deepEqual(await invoke('followUpAction', { ...confirm, commandId: randomUUID(), subject: personal }), { kind: 'rejected', code: 'stale' });
          const result = await invoke('followUpAction', confirm);
          assertReceipt(result);
          assert.equal(result.receipt.stored, 1);
          const replay = await invoke('followUpAction', confirm);
          assert.equal(replay.receipt.status, 'duplicate');
          assert.equal(replay.receipt.receiptId, result.receipt.receiptId);
          const [active] = await page();
          assert.deepEqual(active, { ...saved.card, revision: saved.card.revision + 1,
            condition: { kind: 'tracking', completion: saved.card.condition.completion } });
          const persisted = storedWatch(active.id);
          assert.equal(persisted.state, 'active');
          assert.deepEqual(persisted.source, { ...saved.source, confirmationId: confirm.commandId });
          assert.deepEqual((await invoke('followUpPage', { subject: personal })).rows, []);
          await delay(1100, undefined, { signal });
          assert.deepEqual(await turnIds(), originalTurns);
          assert.equal(adapter.requests.length, 0);
          if (membershipProbe) {
            const result = await runMembership({ ctx, saved, members: personalScopes, active, policyRevision: status.summary.policy.revision,
              adapter, invoke, wait, signal });
            assert.equal(externalSends, 0);
            await save('product-membership.json', result);
          }
          await save('product-watch-cold.json', { sessionId, groupCard: saved.card.id, confirmationReceipt: result.receipt,
            additionalModelRequests: 0, realModelRequests: 0 });
          console.log('B4_WEB_READY');
          return;
        }
        if (watchProbe) {
          await wait(async () => (await summary(personal)).state === 'ready');
          // This is a newly resolved Agent after the old Host exited. Its native
          // session replays persistence on both rc.2 and the desktop runtime.
          const history = agent.session.snapshotEvents();
          for (const [phase, turn] of Object.entries(saved.turns)) {
            assert.deepEqual(watchTurn(history, phase, phase === 'reject' ? 'rejected' : 'allowed-once'), turn);
          }
          const page = () => invoke('followUpPage', { subject: personal });
          assert.deepEqual((await page()).rows, [saved.card]);
          assert.deepEqual(storedWatch(saved.card.id).source, saved.updatedSource);
          const policy = (await summary(personal)).summary.policy;
          const forget = { commandId: randomUUID(), subject: personal, action: 'forget', cardId: saved.card.id,
            expectedRevision: saved.card.revision, expectedPolicyRevision: policy.revision };
          assertReceipt(await invoke('followUpAction', forget));
          assert.equal((await invoke('followUpAction', forget)).receipt.status, 'duplicate');
          assert.deepEqual((await page()).rows, []);
          assert.equal(storedWatch(saved.card.id), undefined);
          assert.deepEqual(agent.session.snapshotEvents(), history);
          assert.equal(adapter.requests.length, 0);
          await save('product-watch-cold.json', { sessionId, recoveredApprovals: Object.keys(saved.turns).length,
            forgotCard: saved.card.id, nativeHistoryRetained: true, additionalModelRequests: 0, realModelRequests: 0 });
          console.log('B4_WEB_READY');
          return;
        }
        if (crashProbe) {
          const recovered = await wait(async () => {
            const row = await summary(personal);
            return row.state === 'ready' && row;
          });
          assert.equal(recovered.summary.policy.localEnabled, true);
          assert.equal(recovered.summary.policy.revision, 1);
          assert.equal((await summary(other)).summary.policy.localEnabled, false);
          const receipt = await invoke('followUpPolicy', saved.first);
          assertReceipt(receipt);
          assert.equal(receipt.receipt.commandId, saved.first.commandId);
          assert.equal(adapter.requests.length, 0);
          await disable();
          assert.deepEqual(await invoke('followUpPolicy', saved.first), { kind: 'rejected', code: 'stale' });
          assert.deepEqual(await summary(personal), { state: 'disabled', configEpoch: recovered.configEpoch });
          await save('product-crash-cold.json', { sessionId, recovered, receipt,
            guards: await checkGuards('crash-cold'), staleReplayRejected: true, realModelRequests: 0 });
          console.log('B4_WEB_READY');
          return;
        }
        const group = await summary(saved.group);
        assert.equal(group.summary.policy.localEnabled, true);
        assert.equal(group.configEpoch, saved.groupStatus.configEpoch);
        assert.equal((await summary(personal)).summary.policy.localEnabled, false);
        if (saved.legacy) await delay(1100, undefined, { signal });
        await checkLegacy(service(), notices, saved.legacy);
        await save('product-cold.json', { sessionId, group, legacy: saved.legacy, guards: await checkGuards('cold'), realModelRequests: 0 });
        console.log('B4_WEB_READY');
        return;
      }
      const groupRecord = await invoke('create', {
        operationId: randomUUID(), name: 'Scoped fixture group', mode: 'mention',
        members: personalScopes.map(subject => subject.bot), historyConfirmed: true,
      }, 'dshBot.groups');
      const group = { kind: 'group', group: { groupId: groupRecord.id, groupCreatedAt: groupRecord.createdAt } };
      const legacy = config.suite === 'v066-follow-up-legacy'
        ? await stageLegacy(service(), registry(), notices, personal.bot, wait, signal) : undefined;
      if (legacy) {
        await disable();
        await wait(async () => (await service()?.status())?.state === 'disabled');
      }
      const before = await checkGuards('before');
      assert.deepEqual(await summary(personal), { state: 'disabled', configEpoch: null });
      const old = service(), kernel = registry().memoryKernel;
      const beforeSetup = adapter.requests.length;
      const first = { commandId: randomUUID(), action: 'enable-local', subject: groupWatchProbe ? group : personal,
        expectedRevision: null, expectedConfigEpoch: null };
      if (crashProbe) {
        await save(stateFile, { sessionId, first, before });
        console.log('B4_WEB_READY');
        await wait(() => readFile(join(config.outputDir, 'begin-crash-enable'), 'utf8').catch(() => undefined));
        const result = await invoke('followUpPolicy', first);
        throw new Error(`Crash-stage gate failed to hold the reply: ${JSON.stringify(result)}`);
      }
      assertReceipt(await invoke('followUpPolicy', first));
      if (groupWatchProbe) {
        const status = await summary(group);
        assert.equal(status.summary.policy.localEnabled, true);
        assert.equal((await summary(personal)).summary.policy.localEnabled, false);
        assert.equal(adapter.requests.length, beforeSetup);
        if (membershipProbe) {
          for (const subject of personalScopes) assertReceipt(await invoke('followUpPolicy', {
            commandId: randomUUID(), action: 'enable-local', subject, expectedRevision: 0, expectedConfigEpoch: status.configEpoch,
          }));
          assert.equal(adapter.requests.length, beforeSetup);
          await prompt('membership-private-marker');
          assert.deepEqual(adapter.trace.at(-1), { sessionId, hasPrivate: true, predecessor: false, continuation: false });
        }
        const from = membershipProbe ? adapter.trace.length : 0;
        const receipt = await runGroupWatch({ ctx, group, groupRecord, personal, other, adapter, invoke, wait, releases, signal });
        if (membershipProbe) {
          assert.equal(adapter.trace.length - from, 2);
          assert.ok(adapter.trace.slice(from).every(call => call.sessionId === receipt.workerId && !call.hasPrivate));
        }
        assert.equal(externalSends, 0);
        await save(stateFile, { ...receipt, sessionId });
        console.log('B4_WEB_READY');
        return;
      }
      const personalStatus = await summary(personal);
      assert.equal(personalStatus.state, 'ready');
      assert.equal(personalStatus.scopeOnly, true);
      assert.equal(personalStatus.summary.policy.localEnabled, true);
      assert.equal((await summary(group)).summary.policy.localEnabled, false);
      assert.equal(old.acceptsNativeInput, false);
      if (watchProbe) {
        assert.equal(adapter.requests.length, beforeSetup);
        assert.equal((await ctx.sessionController.resolveAgent(sessionId)).agent, agent);
        const receipt = await runWatchTurns({ ctx, agent, sessionId, personal, other, adapter, prompt, invoke, releases, signal });
        assert.equal(externalSends, 0);
        await save(stateFile, receipt);
        console.log('B4_WEB_READY');
        return;
      }
      const active = service();
      assertReceipt(await invoke('followUpPolicy', { ...first, action: 'pause', commandId: randomUUID(),
        expectedRevision: personalStatus.summary.policy.revision, expectedConfigEpoch: personalStatus.configEpoch }));
      const paused = await summary(personal);
      assert.equal(paused.summary.policy.localEnabled, false);
      assert.equal(service(), active);
      assertReceipt(await invoke('followUpPolicy', first));
      assert.equal((await summary(personal)).summary.policy.localEnabled, false);
      assertReceipt(await invoke('followUpPolicy', { ...first, commandId: randomUUID(),
        expectedRevision: paused.summary.policy.revision, expectedConfigEpoch: paused.configEpoch }));
      await disable();
      const off = await summary(group);
      assert.deepEqual(off, { state: 'disabled', configEpoch: personalStatus.configEpoch });
      assert.deepEqual(await invoke('followUpPolicy', first), { kind: 'rejected', code: 'stale' });
      assertReceipt(await invoke('followUpPolicy', { ...first, commandId: randomUUID(), subject: group,
        expectedConfigEpoch: off.configEpoch }));
      const groupStatus = await summary(group);
      assert.notEqual(groupStatus.configEpoch, off.configEpoch);
      assert.equal(groupStatus.summary.policy.localEnabled, true);
      assert.equal((await summary(personal)).summary.policy.localEnabled, false);
      assert.equal((await summary(other)).summary.policy.localEnabled, false);
      assert.deepEqual(await invoke('followUpPolicy', first), { kind: 'rejected', code: 'stale' });
      if (legacy) {
        // Cross several actual maintenance cycles without waiting for the
        // deliberately slow timer used to seed the old ready runtime safely.
        await editor.edit(entry, raw => ({ ...raw, proactiveMaintenanceIntervalMs: 250 }));
        await wait(async () => (await summary(group)).state === 'ready');
        await delay(1100, undefined, { signal });
      }
      assert.equal(adapter.requests.length, beforeSetup);
      assert.equal(registry().memoryKernel, kernel);
      assert.equal((await ctx.sessionController.resolveAgent(sessionId)).agent, agent);
      assert.equal((await registry().status()).find(row => row.id === botId)?.mainSessionId, sessionId);
      await checkLegacy(service(), notices, legacy);
      await save('product-warm.json', { sessionId, group, groupStatus, before, legacy, guards: await checkGuards('warm'),
        configurationModelRequests: 0, realModelRequests: 0 });
      console.log('B4_WEB_READY');
    })().catch(async error => {
      if (!signal.aborted) {
        await save('product-error.json', { message: String(error), stack: error.stack });
        console.error('B4_WEB_FAILED', error);
      }
    });
    return async () => {
      stop.abort();
      await run;
      await peer?.dispose();
      for (const release of releases.reverse()) release();
    };
  });
}
