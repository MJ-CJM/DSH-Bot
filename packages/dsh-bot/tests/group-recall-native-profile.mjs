import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';

export const inject = ['loader', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'llm'];
const chinese = '复盘';
const chineseSubstring = '验收';
const replaced = 'discardedcanary';
const current = { kind: 'surface', values: ['current'] };
const userType = { kind: 'type', values: ['user/message'] };
const eventFilters = [current, userType];
const excludedCanaries = /othergroupcanary|privatecanary|discardedcanary/;
const recallTool = 'bot_group_recall';
const route = { provider: 'recall-fixture', model: 'fixture' };
const project = '海图项目';
const question = `${project}今天验收通过，请记下我负责的部分。`;
const privateMarker = 'privatecanary';
const otherGroupMarker = 'othergroupcanary';
const answer = id => `负责验证-回答-${id.slice(0, 8)}`;
const groupKey = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });
const botKey = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });

class ProductAdapter extends LlmAdapter {
  calls = [];
  tool;
  async listModels(provider) { return [{ provider, id: route.model, name: 'Synthetic recall model' }]; }
  async *stream(options) {
    const tools = (options.tools ?? []).map(tool => tool.name);
    const containsRecallQuote = options.messages.some(message => message.role === 'tool' &&
      message.content.some(block => block.type === 'text' && block.text.includes(question)));
    this.calls.push({ sessionId: options.sessionId, tools, containsRecallQuote });
    if (this.tool?.sessionId === options.sessionId) {
      const { input } = this.tool;
      this.tool = undefined;
      assert.ok(tools.includes(recallTool), 'The native main Agent did not expose recall');
      const id = ToolCallId(randomUUID()), args = JSON.stringify(input);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: recallTool, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: recallTool, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = answer(options.sessionId);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function product(ctx, config, counts, releases, signal) {
  const cold = config.phase === 'product-cold';
  const wait = async check => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      signal.throwIfAborted();
      const value = await check();
      if (value) return value;
      await delay(20, undefined, { signal });
    }
    throw new Error('Product fixture timed out');
  };
  const adapter = new ProductAdapter();
  releases.push(ctx.llm.registerAdapter([route.provider], adapter));
  const registry = await wait(() => ctx.get('dshBots'));
  await registry.waitUntilReady();
  const groups = await wait(() => ctx.get('dshBotGroups'));
  const controller = ctx.get('sessionController');
  const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
  releases.push(() => peer.dispose());
  const recall = (bot, input = {}) => ctx.get('typertGateway').invoke({
    namespace: 'dshBot.groups', method: 'recallForBot', args: { bot, input }, peer, signal,
  });
  const sendTurn = async (sessionId, text) => {
    const { agent } = await controller.resolveAgent(sessionId);
    assert.ok(agent);
    const history = await ctx.sessionQuery.readSession(sessionId);
    const previousTurn = history.events.findLast(event => event.type === 'turn/end')?.seq ?? -1;
    const prompt = await controller.prompt({ sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text }] }, signal);
    assert.equal(prompt.accepted, true);
    const end = await wait(async () => (await ctx.sessionQuery.readSession(sessionId)).events.find(event =>
      event.type === 'turn/end' && event.seq > previousTurn));
    await agent.whenIdle();
    assert.equal(await ctx.sessions.flush(agent.session), true);
    return end.data.reason.kind;
  };
  const forkSession = async (parent, atSeq, expectsQuote = true) => {
    const { sessionId } = await controller.fork({ sessionId: parent, ...(atSeq === undefined ? {} : { atSeq }) });
    assert.ok(sessionId);
    const header = ctx.sessions.get(sessionId)?.header;
    assert.ok(header?.isSeeded);
    assert.equal(header.parentSession, undefined, 'Desktop rc.1 does not store the fork parent');
    const surface = await ctx.sessionQuery.readSurface(sessionId);
    assert.equal(surface.session.id, header.id);
    assert.equal(surface.session.isSeeded, true);
    assert.equal(surface.events.some(event => event.type === 'tool/result' && event.data.message.content.some(block =>
      block.type === 'text' && block.text.includes(question))), expectsQuote);
    return sessionId;
  };
  const assertForkRefused = async (sessionId, atSeq) => {
    const calls = adapter.calls.length;
    const agents = ctx.agents.list().map(agent => agent.session.id).sort();
    await assert.rejects(controller.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }) }), /This background task has ended/);
    assert.equal(adapter.calls.length, calls);
    assert.deepEqual(ctx.agents.list().map(agent => agent.session.id).sort(), agents);
  };
  const desktop = config.cliVersion === '0.2.2-rc.1';
  const noRecallSideEffects = async run => {
    const before = { ...counts };
    const calls = adapter.calls.length;
    const agents = ctx.agents.list().map(agent => agent.session.id).sort();
    const result = await run();
    assert.deepEqual(counts, before);
    assert.equal(adapter.calls.length, calls);
    assert.deepEqual(ctx.agents.list().map(agent => agent.session.id).sort(), agents);
    return result;
  };
  const checks = [];
  if (cold) {
    const warm = JSON.parse(await readFile(join(config.outputDir, 'product-warm.json'), 'utf8'));
    const { alpha, beta, gamma, group, expected, firstTurn, oldMember, mainSessionId, forks, recalledThroughSeq, cleanThroughSeq } = warm.fixture;
    assert.equal(adapter.calls.length, 0, 'Cold startup dispatched a model');
    assert.equal(ctx.agents.get(expected.items[0].childSessionId), undefined);
    await noRecallSideEffects(async () => {
      assert.deepEqual(await recall(alpha, { group, query: chineseSubstring, turnId: firstTurn }), expected);
      assert.deepEqual((await recall(gamma, { group, query: chineseSubstring })).items, []);
    });
    checks.push('cold Remote and no incremental Agent or model work');
    const edit = async members => {
      const { group: now } = (await groups.list()).find(row => row.group.id === group.groupId);
      return groups.edit(group, { expectedRevision: now.revision, expectedMembershipRevision: now.membershipRevision,
        name: now.name, mode: now.mode, members, historyConfirmed: true });
    };
    const opened = await registry.openConversation(alpha.botId);
    assert.equal(opened.sessionId, mainSessionId);
    const { agent } = await controller.resolveAgent(mainSessionId);
    assert.ok(agent);
    const betaMain = await registry.openConversation(beta.botId);
    const { agent: betaAgent } = await controller.resolveAgent(betaMain.sessionId);
    assert.ok(betaAgent);
    const hasRecallTool = agent => Boolean(agent.ctx.tools.get(recallTool, agent));
    assert.ok(hasRecallTool(agent) && hasRecallTool(betaAgent));
    const memoryEnabled = enabled => registry.update(alpha.botId, { expectedCreatedAt: alpha.botCreatedAt, memory: { enabled, injectLimit: 0 } });
    await memoryEnabled(false);
    assert.ok(!hasRecallTool(agent) && hasRecallTool(betaAgent));
    await noRecallSideEffects(async () => {
      const disabled = await recall(alpha, { group });
      assert.equal(disabled.unavailable, true);
      assert.deepEqual(disabled.items, []);
      const wrongGeneration = await recall(beta, { group: { ...group, groupCreatedAt: group.groupCreatedAt + 1 } });
      assert.deepEqual(wrongGeneration.items, []);
      const wrongBot = await recall({ ...beta, botCreatedAt: beta.botCreatedAt + 1 }, { group });
      assert.equal(wrongBot.unavailable, true);
      assert.deepEqual(wrongBot.items, []);
      assert.equal((await recall(beta, { group, query: chineseSubstring, turnId: firstTurn })).items.length, 1);
    });
    checks.push('memory off unavailable and incorrect Bot and group generations empty');
    assert.equal(await sendTurn(mainSessionId, '记忆关闭后请正常回应这条新消息。'), 'completed');
    assert.equal(adapter.calls.length, 1);
    assert.ok(!adapter.calls[0].tools.includes(recallTool));
    checks.push('ordinary main conversation continues with memory off and existing valid references');

    await edit([beta, gamma]);
    const inherited = [...forks];
    if (desktop) inherited.push(await forkSession(mainSessionId, recalledThroughSeq));
    else await assertForkRefused(mainSessionId, recalledThroughSeq);
    for (const sessionId of [mainSessionId, ...inherited]) {
      assert.notEqual(await sendTurn(sessionId, '成员权限收回后请回应这条新消息。'), 'completed');
      assert.equal(adapter.calls.length, 1, `Revoked recall reached the provider in ${sessionId}`);
    }
    checks.push(desktop ? 'revoked main and three inherited forks block the provider while memory is off'
      : 'revoked main blocks the provider and the original atSeq fork is refused');
    if (desktop) {
      const clean = await forkSession(mainSessionId, cleanThroughSeq, false);
      assert.equal(await sendTurn(clean, '分支不包含召回来源，请正常回应。'), 'completed');
      assert.equal(adapter.calls.at(-1).sessionId, clean);
      assert.equal(adapter.calls.at(-1).containsRecallQuote, false);
      checks.push('a clean fork at the pre-recall boundary still supports ordinary conversation');
    }
    await memoryEnabled(true);
    assert.ok(hasRecallTool(agent) && hasRecallTool(betaAgent));
    checks.push('retained main tool disappears and returns across the memory switch; other Bot unaffected');
    await noRecallSideEffects(async () => assert.deepEqual((await recall(alpha, { group })).items, []));
    await edit([alpha, beta, gamma]);
    const newMember = (await groups.view(group)).members.find(member => member.bot.botId === alpha.botId &&
      member.enabled && member.removedAt === undefined);
    assert.ok(newMember);
    assert.notEqual(newMember.id, oldMember);
    await noRecallSideEffects(async () => assert.deepEqual((await recall(alpha, { group })).items, []));
    checks.push('member removal and rejoin hide the original membership history');

    const citation = expected.items[0].sources.find(source => source.role === 'question');
    const root = ctx.agents.get(citation.sessionId);
    assert.ok(root);
    await noRecallSideEffects(async () => assert.equal((await recall(beta, { group, query: chineseSubstring, turnId: firstTurn })).items.length, 1));
    root.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '合成替换内容' }] }), {
      surfaceOp: { op: 'replace', startSeq: citation.seq, endSeq: citation.seq }, sourceEventSeqs: [citation.seq],
    });
    assert.equal(await ctx.sessions.flush(root.session), true);
    const raw = await ctx.sessionQuery.readEvent({ sessionId: citation.sessionId, seq: citation.seq }, signal);
    assert.equal(raw.target.data.id, citation.messageId);
    await noRecallSideEffects(async () => assert.deepEqual((await recall(beta, { group, query: chineseSubstring, turnId: firstTurn })).items, []));
    checks.push('product recall excludes a natively replaced question while raw event still exists');
    assert.equal(adapter.calls.length, desktop ? 2 : 1);
    return { checks, syntheticRequests: adapter.calls.length, startupOrMutationAgents: counts.agentCreations,
      recallAgentCreations: 0, recallModelStreams: 0, realModelRequests: 0 };
  }

  const [alpha, beta, gamma] = await Promise.all(['recall-alpha', 'recall-beta', 'recall-gamma'].map(async id => botKey(await registry.create({
    id, name: id, template: 'minimal', model: route, memory: { enabled: true, injectLimit: 0 },
  }))));
  const create = (name, members) => groups.create({ operationId: randomUUID(), name, mode: 'natural', members, historyConfirmed: true });
  const first = await create(project, [alpha, beta, gamma]);
  const other = await create('隔离群', [beta, gamma]);
  assert.equal(first.cwd, other.cwd);
  const group = groupKey(first);
  const view = await groups.view(group);
  const oldMember = view.members.find(member => member.bot.botId === alpha.botId).id;
  const send = async (target, bots, text) => {
    const key = groupKey(target), before = await groups.view(key);
    const memberIds = bots.map(bot => before.members.find(member => member.bot.botId === bot.botId).id);
    const turn = await groups.send(key, { operationId: randomUUID(), text, memberIds, expectedMembershipRevision: before.group.membershipRevision });
    const result = await wait(async () => {
      const page = await groups.view(key), row = page.turns.find(record => record.id === turn.id);
      if (row && !['accepted', 'running'].includes(row.state)) return { row, deliveries: page.deliveries.filter(delivery => delivery.turnId === turn.id) };
    });
    assert.ok(['idle', 'completed'].includes(result.row.state), JSON.stringify(result));
    assert.equal(result.deliveries.length, bots.length);
    assert.ok(result.deliveries.every(delivery => delivery.state === 'completed'));
    return result;
  };
  const firstRun = await send(first, [alpha, beta], question);
  const nextRun = await send(first, [alpha], '海图项目需要另外讨论排期。');
  await send(other, [beta], `这个消息只在隔离群 ${otherGroupMarker}`);
  const groupCalls = adapter.calls.length;
  assert.equal(groupCalls, 4);
  assert.ok(adapter.calls.every(call => !call.tools.includes(recallTool)));
  checks.push('two of three natural group members executed and recall tool absent from group workers');
  assert.deepEqual(await registry.memoryFor(alpha.botId).list(), []);
  const { sessionId } = await registry.openConversation(alpha.botId);
  assert.equal(await sendTurn(sessionId, `私人会话标记 ${privateMarker}`), 'completed');
  const cleanThroughSeq = (await ctx.sessionQuery.readSession(sessionId)).events.findLast(event => event.type === 'turn/end')?.seq;
  assert.ok(Number.isInteger(cleanThroughSeq));
  const alphaDelivery = firstRun.deliveries.find(delivery => delivery.bot.botId === alpha.botId);
  const betaDelivery = firstRun.deliveries.find(delivery => delivery.bot.botId === beta.botId);
  const firstTurn = firstRun.row.id;
  const expected = await noRecallSideEffects(async () => {
    const page = await recall(alpha, { group, query: chineseSubstring, turnId: firstTurn });
    assert.equal(page.items.length, 1, JSON.stringify(page));
    assert.equal(page.incomplete, false);
    const item = page.items[0];
    assert.equal(item.groupName, project);
    assert.equal(item.memberId, oldMember);
    assert.equal(item.deliveryId, alphaDelivery.id);
    assert.equal(item.childSessionId, alphaDelivery.childSessionId);
    assert.equal(item.sources.find(source => source.role === 'question').text, question);
    assert.equal(item.sources.find(source => source.role === 'answer').text, answer(alphaDelivery.childSessionId));
    for (const source of item.sources) {
      assert.equal(source.sessionId, first.rootSessionId);
      const native = await ctx.sessionQuery.readEvent({ sessionId: source.sessionId, seq: source.seq }, signal);
      assert.equal(native.target.data.id, source.messageId);
    }
    assert.deepEqual((await recall(gamma, { group, query: chineseSubstring })).items, []);
    assert.deepEqual((await recall(alpha, { query: otherGroupMarker })).items, []);
    assert.deepEqual((await recall(alpha, { query: privateMarker })).items, []);
    const betaPage = await recall(beta, { group, turnId: firstTurn });
    assert.equal(betaPage.items[0].sources.find(source => source.role === 'answer').text, answer(betaDelivery.childSessionId));
    const page1 = await recall(alpha, { group, limit: 1 });
    assert.ok(page1.nextCursor);
    const page2 = await recall(alpha, { group, limit: 1, cursor: page1.nextCursor });
    assert.deepEqual([...page1.items, ...page2.items].map(row => row.turnId), [nextRun.row.id, firstTurn]);
    assert.equal(page2.nextCursor, undefined);
    await assert.rejects(recall(beta, { group, limit: 1, cursor: page1.nextCursor }));
    return page;
  });
  checks.push('Chinese substring Remote result and exact native citation', 'own answer, nonparticipant, private and other-group isolation', 'product pagination and cross-Bot cursor rejection');

  adapter.tool = { sessionId, input: { group, query: chineseSubstring, turnId: firstTurn } };
  assert.equal(await sendTurn(sessionId, '请查询我参与的群经历。'), 'completed');
  const history = await ctx.sessionQuery.readSession(sessionId);
  const call = history.events.findLast(event => event.type === 'tool/call' && event.data.name === recallTool);
  assert.ok(call);
  const result = history.events.findLast(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
  assert.ok(result, 'The native tool call did not emit a result');
  assert.notEqual(result.data.message.isError, true, JSON.stringify(result.data.message.content));
  const quote = result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.deepEqual(JSON.parse(quote), expected);
  assert.doesNotMatch(quote, excludedCanaries);
  assert.equal(adapter.calls.length, 7);
  assert.deepEqual(await registry.memoryFor(alpha.botId).list(), []);
  checks.push('native main tool returns own source with zero saved memories');
  const recalledThroughSeq = history.events.findLast(event => event.type === 'turn/end')?.seq;
  assert.ok(Number.isInteger(recalledThroughSeq) && recalledThroughSeq > result.seq);
  const forks = [];
  let latest, forkToolAdvertised = false;
  if (config.browser) {
    await send(first, [alpha], `${project}浏览器验收第一条。`);
    const browserRun = await send(first, [alpha], `${project}浏览器验收第二条。`);
    latest = { turnId: browserRun.row.id, deliveryId: browserRun.deliveries[0].id,
      messageId: browserRun.row.inputMessageId, seq: browserRun.row.inputSeq };
  } else if (desktop) {
    let parent = sessionId;
    for (const generation of [1, 2]) {
      const fork = await forkSession(parent);
      const forkAgent = ctx.agents.get(fork);
      assert.ok(forkAgent);
      forkToolAdvertised ||= Boolean(forkAgent.ctx.tools.get(recallTool, forkAgent));
      assert.equal(await sendTurn(fork, `当前有权限，第 ${generation} 代分支请求。`), 'completed');
      assert.equal(adapter.calls.length, 7 + generation);
      assert.equal(adapter.calls.at(-1).sessionId, fork);
      assert.equal(adapter.calls.at(-1).containsRecallQuote, true);
      forks.push(fork);
      parent = fork;
    }
    checks.push('first and second native forks verify the inherited quote against the exact main receipt');
  } else {
    await assertForkRefused(sessionId);
    checks.push('rc.2 rejects native Bot fork creation without publishing an Agent');
  }
  assert.equal(adapter.calls.length, config.browser || desktop ? 9 : 7);
  return { checks, forkToolAdvertised, groupRequests: groupCalls, syntheticRequests: adapter.calls.length, recallAgentCreations: 0, recallModelStreams: 0,
    realModelRequests: 0, fixture: { alpha, beta, gamma, group, expected, firstTurn, oldMember, mainSessionId: sessionId,
      rootSessionId: first.rootSessionId, forks, recalledThroughSeq, cleanThroughSeq, ...(latest ? { latest } : {}) } };
}

function appendUser(session, turn, text, replacement) {
  session.append('turn/start', { turn });
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const event = session.append('user/message', message, replacement === undefined ? { surfaceOp: 'append' } : {
    surfaceOp: { op: 'replace', startSeq: replacement, endSeq: replacement }, sourceEventSeqs: [replacement],
  });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
  return event.seq;
}

async function seed(ctx, cwd, releases) {
  const writers = [];
  async function create(meta) {
    const session = ctx.sessions.prepare(randomUUID(), { meta: { cwd, ...meta } });
    writers.push(await ctx.sessionPersistence.create(session.header));
    releases.push(ctx.sessions.enter(session));
    ctx.sessions.announce(session);
    return session;
  }
  try {
    const root = await create();
    const child = await create({ parentSession: root.id, origin: 'subagent' });
    const other = await create();
    const personal = await create();
    const oldSeq = appendUser(root, 1, `${chinese} ${replaced}`);
    const original = await ctx.sessionQuery.searchEvents({ sessionId: root.id, query: replaced, filters: eventFilters });
    assert.deepEqual(original.items.map(hit => [hit.seq, hit.surface]), [[oldSeq, 'current']]);
    const rootSeq = appendUser(root, 2, `${chinese} 今天验收通过 currentroot`, oldSeq);
    const secondSeq = appendUser(root, 3, `${chinese} currentsecond`);
    const childSeq = appendUser(child, 1, `${chinese} currentchild`);
    appendUser(other, 1, `${chinese} othergroupcanary`);
    appendUser(personal, 1, `${chinese} privatecanary`);
    for (const session of [root, child, other, personal]) assert.equal(await ctx.sessions.flush(session), true);
    return { root: root.id, child: child.id, other: other.id, personal: personal.id, oldSeq, rootSeq, secondSeq, childSeq };
  } finally {
    await Promise.all(writers.map(writer => writer.close()));
  }
}

async function exactReads(query, ids, signal) {
  const surface = await query.readSurface(ids.root);
  assert.equal(surface.session.id, ids.root);
  assert.ok(surface.events.some(event => event.seq === ids.rootSeq));
  assert.ok(surface.events.some(event => event.seq === ids.secondSeq));
  assert.equal(surface.events.some(event => event.seq === ids.oldSeq), false);
  assert.doesNotMatch(JSON.stringify(surface.events), excludedCanaries);
  const literal = await query.filterEvents(ids.root, [...eventFilters, { kind: 'text', text: chineseSubstring }]);
  assert.deepEqual(literal.map(event => event.seq), [ids.rootSeq]);
  assert.match(literal[0].text, /今天验收通过/);
  assert.deepEqual(await query.filterEvents(ids.root, [...eventFilters, { kind: 'text', text: replaced }]), []);
  const child = await query.readSurface(ids.child);
  assert.equal(child.session.parentSession, ids.root);
  assert.deepEqual(child.events.filter(event => event.type === 'user/message').map(event => event.seq), [ids.childSeq]);
  const target = await query.readEvent({ sessionId: ids.root, seq: ids.rootSeq }, signal);
  assert.equal(target.session.id, ids.root);
  assert.deepEqual(target.events.map(event => event.seq), [ids.rootSeq]);
  const nearby = await query.readEvent({ sessionId: ids.root, seq: ids.rootSeq, before: 1, after: 1 }, signal);
  assert.deepEqual(nearby.events.map(event => event.seq), [ids.rootSeq - 1, ids.rootSeq, ids.rootSeq + 1]);
  await assert.rejects(query.readEvent({ sessionId: ids.root, seq: ids.rootSeq, before: 51 }, signal),
    { code: 'SESSION_QUERY_INVALID_WINDOW' });
  // Diagnostic control: raw history can still return the superseded content.
  const raw = await query.readEvent({ sessionId: ids.root, seq: ids.oldSeq }, signal);
  assert.match(JSON.stringify(raw.target), /discardedcanary/);
}

async function indexedReads(query, ids, signal, coldCursor) {
  const all = await query.searchSessions({ query: chinese, eventFilters, limit: 10 }, { signal });
  assert.deepEqual(all.items.map(hit => hit.header.id).sort(), [ids.root, ids.child, ids.other, ids.personal].sort());
  const request = { query: chinese, sessionFilters: [{ kind: 'id', values: [ids.root, ids.child] }], eventFilters, limit: 1 };
  const first = await query.searchSessions(request, { signal });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const next = await query.searchSessions({ ...request, cursor: first.nextCursor }, { signal });
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, undefined);
  const hits = [...first.items, ...next.items];
  assert.deepEqual(hits.map(hit => hit.header.id).sort(), [ids.root, ids.child].sort());
  for (const hit of hits) {
    assert.equal(hit.bestMatch.sessionId, hit.header.id);
    assert.equal(hit.bestMatch.surface, 'current');
    assert.doesNotMatch(hit.bestMatch.snippet, excludedCanaries);
  }
  const exact = await query.searchSessions({ ...request, sessionFilters: [{ kind: 'id', values: [ids.root] }] }, { signal });
  assert.deepEqual(exact.items.map(hit => hit.header.id), [ids.root]);
  const prefix = await query.searchSessions({ ...request, sessionFilters: [{ kind: 'id', values: [ids.root.slice(0, -1)] }] }, { signal });
  assert.deepEqual(prefix.items, []);
  await assert.rejects(query.searchSessions({ ...request, query: 'currentroot', cursor: first.nextCursor }, { signal }),
    { code: 'SESSION_QUERY_INVALID_CURSOR' });
  if (coldCursor) {
    await assert.rejects(query.searchSessions({ ...request, cursor: coldCursor }, { signal }),
      { code: 'SESSION_QUERY_INVALID_CURSOR' });
  }
  await assert.rejects(query.searchSessions({ ...request, limit: 101 }, { signal }), { code: 'SESSION_QUERY_INVALID_LIMIT' });
  const eventRequest = { sessionId: ids.root, query: chinese, filters: eventFilters, limit: 1 };
  const events = await query.searchEvents(eventRequest, { signal });
  assert.ok(events.nextCursor);
  const nextEvents = await query.searchEvents({ ...eventRequest, cursor: events.nextCursor }, { signal });
  assert.equal(nextEvents.nextCursor, undefined);
  assert.equal(events.session.id, ids.root);
  assert.equal(nextEvents.session.id, ids.root);
  const eventHits = [...events.items, ...nextEvents.items];
  assert.deepEqual(eventHits.map(hit => hit.seq).sort((a, b) => a - b), [ids.rootSeq, ids.secondSeq]);
  assert.ok(eventHits.every(hit => hit.surface === 'current' && hit.sessionId === ids.root));
  assert.doesNotMatch(JSON.stringify(eventHits), excludedCanaries);
  assert.deepEqual((await query.searchEvents({ ...eventRequest, query: replaced }, { signal })).items, []);
  assert.deepEqual((await query.searchEvents({ ...eventRequest, query: chineseSubstring }, { signal })).items, []);
  const raw = await query.searchEvents({ ...eventRequest, query: replaced, filters: [userType] }, { signal });
  assert.deepEqual(raw.items.map(hit => [hit.seq, hit.surface]), [[ids.oldSeq, 'shadowed']]);
  const aborted = AbortSignal.abort(new Error('recall fixture pre-abort'));
  await assert.rejects(query.searchSessions(request, { signal: aborted }), { code: 'SESSION_QUERY_ABORTED' });
  const control = new AbortController();
  const pending = query.searchEvents(eventRequest, { signal: control.signal });
  control.abort(new Error('recall fixture abort during search'));
  await assert.rejects(pending, { code: 'SESSION_QUERY_ABORTED' });
  return first.nextCursor;
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController(), { signal } = stop;
    const counts = { sessionCreations: 0, agentCreations: 0, agentRequests: 0, modelStreams: 0 };
    const releases = [
      ctx.on('session/created', () => { counts.sessionCreations++; }),
      ctx.on('agent/created', () => { counts.agentCreations++; }),
      ctx.on('agent/request', (_payload, next) => { counts.agentRequests++; return next(); }),
      ctx.on('llm/stream', (_payload, next) => { counts.modelStreams++; return next(); }),
    ];
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      const { phase, outputDir } = config;
      if (phase.startsWith('product-')) {
        const report = await product(ctx, config, counts, releases, signal);
        await writeFile(join(outputDir, `${phase}.json`), JSON.stringify({ phase, ...report }, null, 2));
        console.log('RECALL_NATIVE_READY');
        return;
      }
      assert.deepEqual(ctx.agents.list(), []);
      assert.deepEqual(ctx.sessions.list(), []);
      const warmFile = join(outputDir, 'warm.json');
      const warm = phase === 'warm';
      const saved = warm ? undefined : JSON.parse(await readFile(warmFile, 'utf8'));
      const ids = saved?.ids ?? await seed(ctx, outputDir, releases);
      const checks = [];
      const query = ctx.sessionQuery;
      const scoped = await query.filterSessions([{ kind: 'id', values: [ids.root, ids.child] }], signal);
      assert.deepEqual(scoped.map(row => row.header.id).sort(), [ids.root, ids.child].sort());
      assert.ok(scoped.every(row => row.live === warm && row.persisted));
      await exactReads(query, ids, signal);
      checks.push('exact IDs', 'current surface and Chinese literal', 'raw read window');
      if (warm) checks.push('indexed replacement invalidation');
      let cursor;
      if (phase === 'disabled') {
        await assert.rejects(query.searchSessions({ query: chinese }, { signal }), { code: 'SESSION_QUERY_SEARCH_DISABLED' });
        await assert.rejects(query.searchEvents({ sessionId: ids.root, query: chinese }, { signal }), { code: 'SESSION_QUERY_SEARCH_DISABLED' });
        checks.push('FTS disabled with exact-read fallback');
      } else {
        cursor = await indexedReads(query, ids, signal, saved?.cursor);
        checks.push('FTS exact IDs and surface', 'Chinese full token and substring limit', 'opaque pages and limits', 'search cancellation');
        if (saved) checks.push('prior-process cursor rejected');
      }
      const aborted = AbortSignal.abort(new Error('recall fixture read cancellation'));
      await assert.rejects(query.readEvent({ sessionId: ids.root, seq: ids.rootSeq }, aborted),
        error => error === aborted.reason || error.code === 'SESSION_QUERY_ABORTED');
      checks.push('exact read pre-abort');
      assert.deepEqual(ctx.agents.list(), []);
      if (!warm) assert.deepEqual(ctx.sessions.list(), []);
      await writeFile(join(outputDir, `${phase}.json`), JSON.stringify({ phase, ids, cursor, checks, ...counts }, null, 2));
      console.log('RECALL_NATIVE_READY');
    })().catch(error => {
      if (!signal.aborted) console.error('RECALL_NATIVE_FAILED', error);
    });
    return async () => {
      stop.abort();
      await run;
      for (const release of releases.reverse()) await release();
    };
  });
}
