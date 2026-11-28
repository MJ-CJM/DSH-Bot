// Real Host and native tool dispatch; only model and external backends are local fixtures.
import { allowLoopbackFixturePort } from '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'group-tool-permissions-fixture';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController', 'typertGateway', 'permissionPresets'];
export function apply(ctx, config) { ctx.effect(() => {
  const stop = new AbortController(), releases = [], calls = [], approvals = [], backends = [], steps = new Map(), agents = new Map();
  let phase = 'setup', origin, group, held, unblock, started;
  const save = (name, value) => writeFile(resolve(config.outputDir, name + '.json'), JSON.stringify(value, null, 2));
  const wait = async fn => { const deadline = Date.now() + 45000; while (!stop.signal.aborted && Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(20); } throw Error('Timeout: ' + phase); };
  const policyOf = agent => { const approval = agent.ctx.get('approval'); return approval.overrideOf(agent.session) ?? approval.config.policy ?? 'ask'; };
  const results = agent => agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    backends.push({ phase, path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/plain' }).end('LOCAL_NATIVE_WEB_FETCH'); return; }
    if (req.url === '/search') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sources: [{ url: origin + '/page', title: 'Local reference', snippet: 'LOCAL_NATIVE_WEB_SEARCH' }], truncated: false })); return; }
    if (req.url === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const body = JSON.parse(raw || '{}');
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'parity', version: '1' } } : body.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Local permission parity marker', inputSchema: { type: 'object', properties: {} } }] } : body.method === 'tools/call' ? { content: [{ type: 'text', text: 'LOCAL_ASSIGNED_MCP' }] } : {};
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
    }
    res.writeHead(404).end();
  });
  const negativeShell = (agent, marker) => ({ name: 'bash', args: { command: 'printf ' + marker + ' > ' + JSON.stringify(resolve(agent.session.header.cwd, marker + '.txt')), description: 'Verify blocked native command has no file effect', workdir: agent.session.header.cwd } });
  const absent = async (agent, marker) => assert.equal(await readFile(resolve(agent.session.header.cwd, marker + '.txt'), 'utf8').catch(() => null), null, marker);
  const safeRead = agent => ({ name: 'read', args: { file_path: resolve(agent.session.header.cwd, 'seed.txt') }, marker: 'LOCAL_NATIVE_FILE' });
  const sequence = agent => {
    if (phase === 'guest') return [{ name: 'web_search', args: { queries: ['LOCAL_GUEST_QUERY'] } }, { name: 'web_fetch', args: { url: origin + '/page' } }];
    if (phase === 'group-mcp') return [safeRead(agent), { name: 'mcp__parity__echo', args: {}, marker: 'LOCAL_ASSIGNED_MCP' }];
    if (phase === 'denied') return [{ name: 'web_search', args: { queries: ['LOCAL_DENIED_QUERY'] } }, negativeShell(agent, 'LOCAL_DENIED_SHELL')];
    if (phase === 'native-never') return [{ name: 'mcp__parity__echo', args: {} }, negativeShell(agent, 'LOCAL_NEVER_MUST_NOT_RUN')];
    if (phase === 'approval-denied') return [negativeShell(agent, 'LOCAL_APPROVAL_MUST_NOT_RUN')];
    if (phase === 'memory-only') return [{ name: 'web_search', args: { queries: ['LOCAL_MEMORY_MUST_NOT_SEARCH'] } }, safeRead(agent), negativeShell(agent, 'LOCAL_MEMORY_MUST_NOT_RUN'), { name: 'mcp__parity__echo', args: {} }, { name: 'bot_memory_save', args: { content: 'The owner prefers fixture tea.' } }];
    if (phase === 'cancelled') return [negativeShell(agent, 'LOCAL_CANCEL_MUST_NOT_RUN')];
    return [{ name: 'web_search', args: { queries: ['LOCAL_PARITY_QUERY'] }, marker: 'LOCAL_NATIVE_WEB_SEARCH' }, { name: 'web_fetch', args: { url: origin + '/page' }, marker: 'LOCAL_NATIVE_WEB_FETCH' }, safeRead(agent), { name: 'bash', args: { command: 'printf LOCAL_NATIVE_SHELL', description: 'Print one local parity marker', workdir: agent.session.header.cwd }, marker: 'LOCAL_NATIVE_SHELL' }, { name: 'mcp__parity__echo', args: {}, marker: 'LOCAL_ASSIGNED_MCP' }];
  };
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Group tool parity mock' }]; }
    async *stream(options) {
      const agent = ctx.agents.get(options.sessionId); assert.ok(agent); agents.set(agent.id, agent);
      const key = phase + '/' + agent.id, count = steps.get(key) ?? 0; steps.set(key, count + 1);
      const catalog = (options.tools ?? []).map(tool => tool.name), plan = sequence(agent), step = plan[count];
      calls.push({ phase, sessionId: agent.id, step: count, tools: catalog, emitted: step?.name });
      await fetch(config.endpoint, { method: 'POST', body: JSON.stringify({ phase, sessionId: agent.id, step: count }) });
      if (phase === 'cancelled' && count === 0) { held = agent; started?.(); await new Promise(accept => { unblock = accept; }); }
      if (step) {
        if (['single', 'group', 'guest'].includes(phase)) assert.ok(catalog.includes(step.name), `${phase} schema missing ${step.name}`);
        const id = ToolCallId('parity-' + crypto.randomUUID()), args = JSON.stringify(step.args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      const text = phase === 'memory-only' ? 'MEMORY_NARRATIVE_MUST_NOT_PUBLISH' : 'LOCAL_PARITY_COMPLETE';
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  releases.push(ctx.on('tools/pre-execute', async (exec, next) => {
    if (!['approval-denied', 'native-never'].includes(phase) || exec.name !== 'bash') return next();
    const decision = await next(); if (decision.kind === 'deny' || decision.kind === 'cancel') return decision;
    return { kind: 'ask', reason: 'Local fixture exact tool approval rejection' };
  }, { prepend: true }));
  releases.push(ctx.on('approval/request', request => { const allow = ['single', 'group-mcp'].includes(phase) && request.toolName === 'dsh_bot_export_connector' && request.reason.includes(origin + '/mcp') && request.reason.endsWith(JSON.stringify({ name: 'mcp__parity__echo', arguments: {} })); approvals.push({ phase, sessionId: request.agent.id, name: request.toolName, reason: request.reason, outcome: allow ? 'allowed-once' : 'rejected' }); return allow ? 'allowed-once' : 'rejected'; }, { prepend: true }));
  const run = (async () => {
    await ctx.loader.await(); await ctx.dshBots.waitUntilReady(); assert.deepEqual(ctx.llm.listProviders(), []);
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    origin = 'http://127.0.0.1:' + server.address().port; releases.push(allowLoopbackFixturePort(server.address().port));
    const web = ctx.get('web'); assert.ok(web?.registerSearchProvider, 'Native web seam unavailable');
    releases.push(web.registerSearchProvider({ id: 'parity-local', available: () => true, search: async (request, signal) => { assert.equal(request.query.startsWith('LOCAL_'), true); return (await fetch(origin + '/search', { signal })).json(); } }));
    releases.push(web.registerFetchProvider({ id: 'parity-local', available: () => true, fetch: async (request, signal) => { assert.equal(request.url, origin + '/page'); const response = await fetch(request.url, { signal }); return { url: request.url, statusCode: response.status, body: { kind: 'text', content: await response.text() }, truncated: false }; } }));
    releases.push(ctx.llm.registerAdapter(['group-tool-parity'], new Adapter()));
    const groups = await wait(() => ctx.get('dshBotGroups'));
    const restored = await groups.list();
    if (restored.length) { for (const row of restored) { const view = await groups.view({ groupId: row.group.id, groupCreatedAt: row.group.createdAt }); assert.ok(view.turns.every(turn => !['accepted', 'running'].includes(turn.state))); } await delay(300); assert.equal(calls.length, 0); await save('cold-result', { status: 'PASS', modelRequests: 0, noReplay: true, restoredGroups: restored.length, settledTurns: true }); console.log('B4_WEB_READY'); return; }
    const bots = [];
    for (const id of ['parity-alpha', 'parity-beta', 'parity-deny', 'parity-guest']) {
      const bot = await ctx.dshBots.create({ id, name: id === 'parity-guest' ? 'Jarvis' : id, template: 'standard', model: { provider: 'group-tool-parity', model: 'fixture' }, memory: { enabled: true, injectLimit: 0 }, ...(id === 'parity-deny' ? { tools: { deny: ['web_search', 'bash'] } } : {}) }); bots.push({ botId: bot.id, botCreatedAt: bot.createdAt });
      await ctx.get('dshBotConnectors').saveDefinition({ id, label: 'Local parity', serverName: 'parity', transport: 'streamable-http', url: origin + '/mcp', enabled: true }, 0);
      await ctx.get('dshBotConnectors').saveAssignment({ id, bot: bots.at(-1), connectorId: id, enabled: true }, 0);
    }
    const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); releases.push(() => peer.dispose());
    const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: stop.signal });
    const make = async (name, members) => { const row = await groups.create({ operationId: crypto.randomUUID(), name, mode: 'mention', members, historyConfirmed: true }); await writeFile(resolve(row.cwd, 'seed.txt'), 'LOCAL_NATIVE_FILE'); ctx.permissionPresets.set(ctx.agents.get(row.rootSessionId).session, 'workspace-write'); return { groupId: row.id, groupCreatedAt: row.createdAt }; };
    const send = async (key, extra = {}) => { const before = await groups.view(key); return invoke('send', { group: key, input: { operationId: crypto.randomUUID(), text: 'Local fixture ' + phase, memberIds: [before.members[0].id], expectedMembershipRevision: before.group.membershipRevision, ...extra } }); };
    const finish = async (key, turn) => wait(async () => { const view = await groups.view(key); return view.turns.some(row => row.id === turn.id && !['accepted', 'running'].includes(row.state)) && view; });
    const checkSuccess = (agent, start = 0) => { const actual = results(agent).slice(start); assert.equal(actual.length, 5); for (const [i, step] of sequence(agent).entries()) { if (phase === 'group' && step.name === 'mcp__parity__echo') { assert.equal(actual[i].data.message.isError, true); assert.match(JSON.stringify(actual[i]), /Group copy audience changed|Data export not approved/); continue; } assert.equal(actual[i].data.message.isError, false, JSON.stringify(actual[i])); assert.ok(JSON.stringify(actual[i]).includes(step.marker), 'Missing actual output ' + step.name); } };
    phase = 'single'; const main = await ctx.dshBots.openConversation('parity-alpha'), agent = (await ctx.sessionController.resolveAgent(main.sessionId)).agent; assert.ok(agent); agents.set(agent.id, agent);
    await writeFile(resolve(agent.session.header.cwd, 'seed.txt'), 'LOCAL_NATIVE_FILE'); ctx.permissionPresets.set(agent.session, 'workspace-write');
    const promptReceipt = await ctx.sessionController.prompt({ sessionId: agent.id, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Single Bot control' }] }, stop.signal); assert.equal(promptReceipt.accepted, true, JSON.stringify(promptReceipt)); await wait(() => agent.session.snapshotEvents().some(event => event.type === 'turn/end')); await agent.whenIdle(); checkSuccess(agent); await save('single-events', agent.session.snapshotEvents());
    phase = 'group'; group = await make('Ordinary native parity', bots.slice(0, 2)); const groupTurn = await send(group), groupView = await finish(group, groupTurn); const groupCalls = calls.filter(row => row.phase === phase), child = agents.get(groupCalls[0].sessionId); checkSuccess(child); assert.equal(policyOf(child), 'ask'); await save('group-events', child.session.snapshotEvents()); const heldExport = groupView.deliveries.find(row => row.turnId === groupTurn.id); assert.equal(heldExport.reasonCode, 'export-approval-required'); const exportPreview = await invoke('reviewExport', { group, deliveryId: heldExport.id }); await invoke('decideExport', { group, deliveryId: heldExport.id, token: exportPreview.token, allow: false });
    const stale = await child.ctx.tools.execute({ agent: child, name: 'bash', arguments: { command: 'printf LOCAL_STALE_MUST_NOT_RUN', description: 'Expired reservation probe', workdir: child.session.header.cwd }, callId: ToolCallId(crypto.randomUUID()), signal: stop.signal }).catch(error => ({ isError: true, error: String(error) })); assert.ok(stale.isError, JSON.stringify(stale)); assert.ok(!JSON.stringify(stale).includes('"text":"LOCAL_STALE_MUST_NOT_RUN"'));
    phase = 'group-mcp'; const mcpStart = backends.length, mcpView = await finish(group, await send(group)), mcpChild = agents.get(calls.find(row => row.phase === phase).sessionId); assert.equal(results(mcpChild).length, 2); assert.ok(results(mcpChild).every(row => !row.data.message.isError), JSON.stringify(results(mcpChild))); assert.ok(backends.slice(mcpStart).some(row => row.body?.method === 'tools/call')); assert.ok(approvals.some(row => row.phase === 'group-mcp' && row.outcome === 'allowed-once')); assert.equal(policyOf(mcpChild), 'ask'); await save('group-mcp-events', mcpChild.session.snapshotEvents());
    phase = 'guest'; const guestView = await finish(group, await send(group, { memberIds: [], expectedGuest: bots[3], text: '问 Jarvis：请查询本地测试资料' })), guestChild = agents.get(calls.find(row => row.phase === phase).sessionId); assert.equal(results(guestChild).length, 2); assert.ok(results(guestChild).every(row => !row.data.message.isError), JSON.stringify(results(guestChild))); assert.ok(calls.filter(row => row.phase === 'guest').every(row => row.tools.includes('web_search') && row.tools.includes('web_fetch'))); assert.equal(guestView.deliveries.at(-1).state, 'completed'); assert.equal(policyOf(guestChild), 'ask'); await save('guest-events', guestChild.session.snapshotEvents());
    phase = 'denied'; const denyGroup = await make('Configured tool deny', [bots[2], bots[1]]), denyStart = backends.length, denyView = await finish(denyGroup, await send(denyGroup)), denyChild = agents.get(calls.find(row => row.phase === phase).sessionId); assert.ok(results(denyChild).every(row => row.data.message.isError)); assert.ok(calls.filter(row => row.phase === phase).every(row => !row.tools.includes('web_search') && !row.tools.includes('bash'))); assert.equal(backends.slice(denyStart).filter(row => row.path === '/search').length, 0); await absent(denyChild, 'LOCAL_DENIED_SHELL');
    phase = 'native-never'; const root = ctx.agents.get((await groups.view(group)).group.rootSessionId); root.ctx.get('approval').setPolicy(root, 'never'); const neverStart = backends.length, approvalsBeforeNever = approvals.length, neverView = await finish(group, await send(group)), neverChild = agents.get(calls.find(row => row.phase === phase).sessionId); assert.ok(results(neverChild).every(row => row.data.message.isError)); assert.equal(approvals.length, approvalsBeforeNever); assert.equal(backends.slice(neverStart).filter(row => row.body?.method === 'tools/call').length, 0); assert.equal(policyOf(neverChild), 'never'); await absent(neverChild, 'LOCAL_NEVER_MUST_NOT_RUN'); await save('never-events', neverChild.session.snapshotEvents()); root.ctx.get('approval').setPolicy(root, 'ask');
    phase = 'approval-denied'; const approvalView = await finish(group, await send(group)), approvalChild = agents.get(calls.find(row => row.phase === phase).sessionId); assert.equal(results(approvalChild)[0].data.message.isError, true); assert.equal(policyOf(approvalChild), 'ask'); assert.ok(approvals.some(row => row.phase === 'approval-denied' && row.name === 'bash' && row.outcome === 'rejected')); assert.ok(approvalChild.session.snapshotEvents().some(row => row.type === 'approval/decided' && row.data.outcome === 'rejected')); await save('approval-events', approvalChild.session.snapshotEvents()); await absent(approvalChild, 'LOCAL_APPROVAL_MUST_NOT_RUN');
    phase = 'memory-only'; const memoryStart = backends.length, memoryView = await finish(group, await send(group, { memoryStatusOnly: true })), memoryChild = agents.get(calls.find(row => row.phase === phase).sessionId); const memoryResults = results(memoryChild); assert.equal(memoryResults.length, 5); assert.ok(memoryResults.slice(0, 4).every(row => row.data.message.isError)); assert.equal(memoryResults[4].data.message.isError, false); assert.ok(calls.filter(row => row.phase === phase).every(row => !row.tools.includes('web_search') && !row.tools.includes('read') && !row.tools.includes('bash') && !row.tools.includes('mcp__parity__echo'))); assert.equal(backends.slice(memoryStart).filter(row => row.path === '/search' || row.body?.method === 'tools/call').length, 0); assert.ok(!JSON.stringify(memoryView.messages).includes('MEMORY_NARRATIVE_MUST_NOT_PUBLISH')); await absent(memoryChild, 'LOCAL_MEMORY_MUST_NOT_RUN'); const memoryTurn = memoryView.turns.find(row => row.memoryStatusOnly); await assert.rejects(groups.continueTurn(group, memoryTurn.id, memoryTurn.revision));
    phase = 'cancelled'; const startedPromise = new Promise(accept => { started = accept; }), cancellation = await send(group); await startedPromise; const current = (await groups.view(group)).turns.find(row => row.id === cancellation.id); await invoke('cancel', { group, turnId: current.id, expectedRevision: current.revision }); const inactiveStep = negativeShell(held, 'LOCAL_INACTIVE_MUST_NOT_RUN'); const inactiveDispatch = await held.ctx.tools.execute({ agent: held, name: inactiveStep.name, arguments: inactiveStep.args, callId: ToolCallId(crypto.randomUUID()), signal: stop.signal }).catch(error => ({ isError: true, error: String(error), causes: error.errors?.map(String) })); assert.ok(inactiveDispatch.isError, JSON.stringify(inactiveDispatch)); await absent(held, 'LOCAL_INACTIVE_MUST_NOT_RUN'); unblock(); const cancelledView = await finish(group, cancellation); assert.ok(results(held).every(row => row.data.message.isError)); await absent(held, 'LOCAL_CANCEL_MUST_NOT_RUN');
    const policies = Object.fromEntries([['single', agent], ['group', child], ['groupMcpInheritedAsk', mcpChild], ['guest', guestChild], ['rootNever', neverChild]].map(([name, value]) => [name, { sandbox: value.session.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode, approval: value.session.snapshotEvents().findLast(event => event.type === 'approval/policy')?.data.policy }]));
    await save('result', { status: 'PASS', policies, checks: ['single Bot native web/file/shell/MCP control', 'ordinary group native web/file/shell results and MCP schema with export guard', 'group assigned MCP transport after inherited root ask and exact approval', 'guest native web search and fetch', 'configured deny masks and dispatch rejects', 'native never inherits root and rejects without approval or transport', 'native ask user rejection blocks shell', 'file/shell reply remains held and owner can reject', 'expired and cancelled worker reservations reject fresh dispatch', 'memory-only denies native and MCP but saves memory', 'memory-only continuation refuses', 'cancelled turn never runs command'], groupView, mcpView, guestView, denyView, neverView, approvalView, memoryView, cancelledView, stale, inactiveDispatch, calls, approvals, backends, realModelRequests: 0 }); console.log('B4_WEB_READY');
  })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error.stack ?? error), calls, approvals, backends, agentEvents: Object.fromEntries([...agents].map(([id, agent]) => [id, agent.session.snapshotEvents()])), realModelRequests: 0 }); console.log('B4_WEB_FAILED'); });
  return async () => { unblock?.(); stop.abort(); await run; for (const release of releases.reverse()) await release(); server.closeAllConnections(); await new Promise(accept => server.close(accept)); };
}); }
