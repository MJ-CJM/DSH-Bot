import { Peer } from '@deepseek-ai/dsh-client-connection';
// Test-only native Host consumer. Never included in the published bundle.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage, } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'b2b-release-fixture';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'agents', 'sessionController', 'sessions', 'approval', 'workspaceRegistry', 'typertGateway'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(), offs = [], approvals = [], calls = [];
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const control = (value) => fetch(`${config.mockUrl}/control`, { method: 'POST', body: JSON.stringify(value) });
    const wait = async (fn) => {
      const end = Date.now() + 60000;
      while (!abort.signal.aborted && Date.now() < end) { const v = await fn(); if (v) return v; await delay(20); }
      throw Error('Release Host deadline');
    };
    offs.push(ctx.on('approval/request', async (req) => {
      const outcome = req.reason?.includes('B2B_REJECT') ? 'rejected' : 'allowed-once';
      approvals.push({ tool: req.toolName, sessionId: req.agent.session.id, reason: req.reason, outcome });
      return outcome;
    }, { prepend: true }));
    const run = (async () => {
      await ctx.loader.await();
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const service = ctx.get('dshBotMessaging'); assert.ok(service, 'Default production messaging must be active');
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); offs.push(() => peer.dispose());
      const invoke = (input) => ctx.typertGateway.invoke({ namespace: 'dshBot.messaging', method: 'request', args: { input }, peer, signal: abort.signal });
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha', 'beta', 'gamma']) {
        await ctx.dshBots.create({ id, name: id === 'beta' ? 'Reviewer' : id, template: 'minimal',
          avatarVariant: id === 'beta' ? 'glasses' : 'classic', persona: { prefix: `B2B_PERSONA_${id}` } });
        await ctx.dshBots.memoryFor(id).save({ kind: 'fact', content: `B2B_PRIVATE_MEMORY_${id}`, tags: [], pinned: true });
      }
      if (first) {
        const connectors = ctx.get('dshBotConnectors');
        for (const id of ['alpha', 'beta']) {
          const bot = await ctx.dshBots.get(id);
          await connectors.saveDefinition({ id: `mcp-${id}`, label: `MCP ${id}`, serverName: 'same', transport: 'streamable-http', url: `${config.mockUrl}/mcp/${id}`, enabled: true }, 0);
          await connectors.saveAssignment({ id: `mcp-${id}`, bot: { botId: id, botCreatedAt: bot.createdAt }, connectorId: `mcp-${id}`, enabled: true }, 0);
        }
      }
      console.log('B2B_PROGRESS created');
      const mains = await Promise.all(['alpha', 'beta', 'gamma'].map((id) => ctx.dshBots.openConversation(id)));
      console.log('B2B_PROGRESS mains');
      const agents = await Promise.all(mains.map(async (m) => { const r = await ctx.sessionController.resolveAgent(m.sessionId); if ('error' in r) throw r.error; return r.agent; }));
      console.log('B2B_PROGRESS resolved');
      const [alpha, beta] = agents;
      const prompt = async (a, text) => {
        a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
        console.log(`B2B_PROGRESS prompt ${text}`);
        await Promise.race([a.whenIdle(), delay(20000).then(() => { throw Error(`whenIdle timeout ${text}`); })]); assert.equal(await ctx.sessions.flush(a.session), true);
      };
      const results = (a) => a.session.snapshotEvents().filter((e) => e.type === 'tool/result');
      for (const a of agents) offs.push(a.ctx.on('tools/result', (exec, result) => {
        calls.push({ owner: a.session.id, name: exec.name, arguments: exec.arguments, isError: result.isError,
          result: result.content, at: Date.now() });
      }));
      if (first) for (const a of agents) await prompt(a, 'B2B_INITIAL_TURN');
      const before = (await ctx.sessionController.list({}, abort.signal)).items;
      const mainIds = mains.map(m => m.sessionId).sort();
      // Native browser navigation may persist a provisional blank session.
      // Compare all business sessions, and independently require every main to be nonblank.
      assert.deepEqual(before.filter(s => !s.blank).map(s => s.sessionId).sort(), mainIds);
      assert.ok(mains.every(m => before.some(s => s.sessionId === m.sessionId && !s.blank)));
      const workspace = ctx.workspaceRegistry.list().find((w) => mains.every((m) => w.sessionIds.includes(m.sessionId)));
      assert.deepEqual(workspace.sessionIds.filter(id => before.some(s => s.sessionId === id && !s.blank)).sort(), mainIds);
      if (first) {
        const scenario = async (name, count) => {
          const old = service.store.rows().length, approvalCount = approvals.length;
          await control([{ route: name }]);
          await prompt(alpha, `B2B_ROOT_${name}`);
          await wait(() => service.store.rows().length === old + count && service.store.rows().slice(old).every((r) => r.processing === 'completed'));
          await Promise.all(agents.map((a) => a.whenIdle())); await service.settled();
          const rows = service.store.rows().filter((r) => r.envelope.ts >= 0).slice(old);
          assert.equal(rows.length, count); assert.ok(rows.every((r) => r.delivery === 'delivered' && r.nativeRef && r.outgoingRef));
          if (name !== 'notify') {
            assert.ok(alpha.session.snapshotEvents().some((e) => e.type === 'assistant/message' && JSON.stringify(e.data).includes(`B2B_TOLD_${name}`)));
            assert.ok(rows.filter((r) => r.envelope.mode === 'ask').every((r) => r.response === 'replied'));
          } else {
            assert.equal(rows[0].response, 'not-required');
            await assert.rejects(() => service.send(beta, { action: 'reply', replyTo: rows[0].envelope.id, content: 'INVALID_NOTIFY_REPLY' }, 'notify-attack'));
          }
          assert.equal(approvals.length - approvalCount, 1, 'Only the new root asks for approval');
          if (name === 'chain') {
            assert.deepEqual(rows.map((r) => r.envelope.hop), [1, 2, 3, 4]);
            assert.equal(new Set(rows.map((r) => r.envelope.threadId)).size, 1);
            assert.deepEqual(rows.map((r) => [r.envelope.from.botId, r.envelope.to.botId]), [['alpha','beta'],['beta','gamma'],['gamma','beta'],['beta','alpha']]);
          }
          if (name === 'loop') assert.ok(calls.some((c) => c.isError && c.arguments?.to === 'alpha'));
          await save(name, { status: 'PASS', rows, approvals: approvals.slice(approvalCount), calls: [...calls] });
        };
        await scenario('roundtrip', 2);
        await scenario('chain', 4);
        await scenario('loop', 2);
        await scenario('notify', 1);
        // Actual model request and native approval denial; no deliverable intent.
        await assert.rejects(() => service.send(agents[2], { action: 'reply', replyTo: service.store.rows()[0].envelope.id, content: 'WRONG_BOT_REPLY' }, 'wrong-bot-attack'));
        const rowCount = service.store.rows().length;
        await control([{ route: false, tool: 'bot_message', args: { action: 'send', to: 'beta', mode: 'notify', priority: 'interrupt', content: 'B2B_REJECT_INTERRUPT' } }]);
        await prompt(alpha, 'B2B_REJECT_APPROVAL');
        assert.equal(service.store.rows().length, rowCount);
        assert.ok(results(alpha).at(-1).data.message.isError);
        await save('denied', { status: 'PASS', rowCount, approvals });
        // A native tool not on the read allowlist: denied and approved on the recipient's real teammate turn.
        let effects = 0;
        offs.push(beta.ctx.tools.register(defineTool({ name: 'b2b_effect', description: 'Loopback-only unknown action', parameters: { text: { type: 'string', required: true } },
          output: { schema: { type: 'object', additionalProperties: true }, render: (_a,v) => [{ type: 'text', text: JSON.stringify(v) }] },
          async execute() { effects++; await fetch(`${config.mockUrl}/effect`, { method: 'POST', body: '{}' }); return { ok: true }; } })));
        for (const mode of ['unsafe-deny', 'unsafe-allow', 'mcp']) {
          await control([{ route: mode }]); await prompt(alpha, `B2B_ROOT_${mode}`);
          await wait(() => beta.session.snapshotEvents().some((e) => e.type === 'assistant/message' && JSON.stringify(e.data).includes(`B2B_DONE_${mode}`)));
          await Promise.all(agents.map((a) => a.whenIdle())); await service.settled();
        }
        assert.equal(effects, 1);
        assert.ok(calls.some((c) => c.owner === beta.session.id && c.name === 'mcp__same__echo' && !c.isError && JSON.stringify(c.result).includes('MCP_beta_ONLY')));
        assert.ok(!calls.some((c) => c.owner === alpha.session.id && c.name === 'mcp__same__echo')); 
        assert.ok(approvals.some((r) => r.tool === 'b2b_effect' && r.outcome === 'rejected'));
        assert.ok(approvals.some((r) => r.tool === 'b2b_effect' && r.outcome === 'allowed-once'));
        const overview = await invoke({ action: 'list', botId: 'alpha' });
        assert.equal(overview.enabled, true); assert.ok(overview.items.length > 0 && overview.items.length <= 20);
        assert.ok(overview.items.every(r => r.envelope.content === undefined));
        await assert.rejects(() => invoke({ action: 'list', botId: 'alpha', sessionId: beta.session.id }));
        const complete = service.store.rows()[0];
        await assert.rejects(() => invoke({ action: 'cancel', id: complete.envelope.id, revision: complete.revision }));
        await save('gateway', { status: 'PASS', overview, strictUnknownFields: true, claimedCancelDenied: true });
        await save('unknown-tools', { status: 'PASS', effects, approvals });
        await control([{ route: false, stall: true }]);
        beta.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'B2B_STALL_TARGET' }] }));
        await wait(async () => (await (await fetch(`${config.mockUrl}/stats`)).json()).at(-1)?.action.stall);
        const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'B2B_PRESERVED_NATIVE_HUMAN' }] });
        beta.send(human, 'next-turn', false);
        await control([{ route: false, tool: 'bot_message', args: { action: 'send', to: 'beta', mode: 'notify', priority: 'interrupt', content: 'B2B_APPROVED_INTERRUPT' } }]);
        await prompt(alpha, 'B2B_APPROVE_INTERRUPT');
        await beta.whenIdle(); await service.settled();
        const interrupted = service.store.rows().find((r) => r.envelope.content === 'B2B_APPROVED_INTERRUPT');
        await wait(() => service.store.get(interrupted.envelope.id)?.interrupt === 'stopped');
        assert.ok(beta.session.snapshotEvents().some((e) => e.type === 'user/message' && e.data.id === human.id));
        assert.ok((await (await fetch(`${config.mockUrl}/stats`)).json()).some((r) => r.action.stall && r.outcome === 'aborted'));
        await save('interrupt', { status: 'PASS', interrupted, humanPreserved: true });
        await control([{ route: false, tool: 'bot_message', args: { action: 'send', to: 'gamma', mode: 'notify', content: 'B2B_COLD_PENDING_NOTIFY' } }]);
        void agents[2].runMaintenance((signal) => new Promise((accept) => signal.addEventListener('abort', accept, { once: true })));
        await prompt(alpha, 'B2B_COLD_REQUEST'); await service.settled();
        const pending = service.store.rows().find((r) => r.envelope.content === 'B2B_COLD_PENDING_NOTIFY');
        assert.ok(pending && agents[2].inbox.nextTurn.some((m) => m.id === pending.nativeInput.id));
        assert.equal(await ctx.sessions.flush(agents[2].session), true);
        await control([{ route: false, tool: 'bot_message', args: { action: 'send', to: 'gamma', mode: 'notify', content: 'B2B_CANCEL_BY_USER' } }]);
        await prompt(alpha, 'B2B_USER_CANCEL_REQUEST'); await service.settled();
        const cancelRow = service.store.rows().find(r => r.envelope.content === 'B2B_CANCEL_BY_USER'); assert.ok(cancelRow);
        await invoke({ action: 'cancel', id: cancelRow.envelope.id, revision: cancelRow.revision });
        assert.equal(service.store.get(cancelRow.envelope.id).delivery, 'canceled');
        assert.ok(!agents[2].inbox.nextTurn.some(m => m.id === cancelRow.nativeInput.id));
        await save('remote-cancel', { status: 'PASS', row: service.store.get(cancelRow.envelope.id) });
        if (config.nativeBlankFixture) {
          // Test-only equivalent of browser provisional creation through the public API.
          const blank = await ctx.sessionController.create({ workspaceId: workspace.id, agentPreset: 'standard' });
          const resolved = await ctx.sessionController.resolveAgent(blank.sessionId);
          if ('error' in resolved) throw resolved.error;
          assert.equal(await ctx.sessions.flush(resolved.agent.session), true);
          const rows = (await ctx.sessionController.list({}, abort.signal)).items;
          assert.ok(rows.some(s => s.sessionId === blank.sessionId && s.blank));
          assert.equal(rows.length, 4);
          await save('provisional-blank', { status: 'PASS', sessionId: blank.sessionId, source: 'public API fixture; not browser evidence' });
        }
        await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify({ mains, rows: service.store.rows(), pending }));
      } else {
        const identity = JSON.parse(await readFile(resolve(config.outputDir, 'identity.json')));
        assert.deepEqual(mains, identity.mains);
        await wait(() => service.store.get(identity.pending.envelope.id)?.processing === 'completed');
        await Promise.all(agents.map((a) => a.whenIdle())); await service.settled();
        assert.equal(service.store.rows().length, identity.rows.length);
        for (const row of service.store.rows()) {
          const agent = agents.find((a) => a.session.id === row.envelope.toSessionId);
          assert.equal(agent.session.snapshotEvents().filter((e) => e.type === 'user/message' && e.data.id === row.nativeInput.id).length, row.delivery === 'canceled' ? 0 : 1);
        }
        await save('cold', { status: 'PASS', noReplays: true, rows: service.store.rows() });
        const old = service.store.rows().length;
        await service.close(); ctx.get('dshBotMessagingSafety').active = false;
        assert.equal(service.lifecycle().timers, 0);
        assert.ok(agents.every((a) => ctx.agents.get(a.session.id) === a));
        await save('lifecycle', { status: 'PASS', ...service.lifecycle(), records: old, nativeAgentsRetained: true });
      }
      const after = (await ctx.sessionController.list({}, abort.signal)).items;
      assert.deepEqual(after.filter(s => !s.blank).map(s => s.sessionId).sort(), mainIds);
      assert.deepEqual(workspace.sessionIds.filter(id => after.some(s => s.sessionId === id && !s.blank)).sort(), mainIds);
      await save('identity', { status: 'PASS', mains, rows: after, noAdditionalBusinessSessions: true, nativeBlankSessionIds: after.filter(s => s.blank).map(s => s.sessionId) });
      await save('result', { status: 'PASS', calls, approvals }); console.log('B2B_DONE');
    })().catch(async (e) => { await save('failure', { error: String(e), stack: e.stack }); console.log('B2B_FAILED'); });
    return async () => { abort.abort(); for (const off of offs.reverse()) off(); await run; };
  });
}
