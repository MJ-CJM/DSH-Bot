import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { startMcpFixture } from '../../../spikes/p34/lib/mcp-fixture.js';
export const name = 'p34-product-probes';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'dshBotP34', 'dshBotConnectors', 'dshBotNotifications', 'agents', 'tools', 'sessionController', 'sessions', 'agentPresets', 'typertGateway', 'credentials'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false; const closers = []; const abort = new AbortController();
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
    const wait = async fn => { const until = Date.now() + 60000; while (!stopping && Date.now() < until) { const r = await fn(); if (r) return r; await delay(20); } throw new Error('P34 runtime deadline'); };
    const run = (async () => {
      await ctx.loader.await(); await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha','beta']) await ctx.dshBots.create({ id, name: id, template: 'minimal', memory: { enabled: false, injectLimit: 20 } });
      const bots = await ctx.dshBots.list(); const keys = Object.fromEntries(bots.map(b => [b.id, { botId: b.id, botCreatedAt: b.createdAt }]));
      const fixtures = await Promise.all(['alpha','beta'].map(async id => { const f = await startMcpFixture(id); f.authorize(process.env[`P34_${id.toUpperCase()}_TOKEN`]); closers.push(() => f.close()); return f; }));
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); closers.push(() => peer.dispose());
      const invoke = (namespace, method, args = {}) => ctx.typertGateway.invoke({ namespace, method, args, peer, signal: abort.signal });
      const credentialInfo = await invoke('credentials', 'describe', { refs: ['P34_ALPHA_TOKEN'] });
      assert.equal(credentialInfo.P34_ALPHA_TOKEN.configured, true); assert.ok(!('value' in credentialInfo.P34_ALPHA_TOKEN));
      const original = await invoke('dshBot.connectors', 'catalog');
      for (let i = 0; i < 2; i++) {
        const id = ['alpha', 'beta'][i];
        await invoke('dshBot.connectors', 'saveDefinition', { input: { id, label: id, transport: 'streamable-http', serverName: 'github', url: fixtures[i].url, enabled: true,
          credentialBindings: [{ destination: 'header', key: 'Authorization', credentialRef: `P34_${id.toUpperCase()}_TOKEN`, format: 'bearer' }] }, expectedRevision: original.definitions.find(d => d.id === id)?.revision ?? 0 });
        if (first) await invoke('dshBot.connectors', 'saveAssignment', { input: { id, bot: keys[id], connectorId: id, enabled: true }, expectedRevision: 0 });
      }
      if (first) await invoke('dshBot.notifications', 'savePolicy', { input: { id: 'local-alpha', owner: keys.alpha, channel: 'in-app', enabled: true,
        timezone: 'America/Los_Angeles', dailyLimit: 0, cooldownSec: 60, authorization: { mode: 'ask' } }, expectedRevision: 0, confirmed: false });
      const mains = await Promise.all(['alpha', 'beta'].map(id => ctx.dshBots.openConversation(id)));
      if (!first) { await invoke('dshBot.connectors', 'applyIdle', { bot: keys.alpha }); await invoke('dshBot.connectors', 'applyIdle', { bot: keys.beta }); }
      await save('connection-snapshot', ctx.dshBotConnectors.runtime());
      const [alpha, beta] = mains.map(m => ctx.agents.get(m.sessionId)); assert.ok(alpha && beta);
      const names = agent => ctx.tools.schemas(agent).filter(t => t.name.startsWith('mcp__')).map(t => t.name);
      assert.deepEqual(names(alpha), ['mcp__github__alpha']); assert.deepEqual(names(beta), ['mcp__github__beta']);
      assert.ok(ctx.tools.schemas(alpha).some(t => t.name === 'bot_notify'));
      const ids = mains.map(m => m.sessionId);
      if (first) {
        const accepted = await ctx.sessionController.prompt({ sessionId: alpha.session.id, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'P34_PRODUCT_LOCAL_NOTIFICATION: explicitly call bot_notify for local-alpha with the synthetic report.' }] }, abort.signal);
        assert.equal(accepted.accepted, true);
        await wait(() => alpha.status !== 'idle');
        const def = (await ctx.dshBotP34.catalog()).definitions.find(d => d.id === 'alpha');
        const { revision, createdAt, updatedAt, schemaVersion, ...input } = def;
        await invoke('dshBot.connectors', 'saveDefinition', { input: { ...input, label: 'alpha updated' }, expectedRevision: revision });
        const busy = await invoke('dshBot.connectors', 'applyIdle', { bot: keys.alpha });
        assert.equal(busy[0].state, 'pending'); assert.equal(busy[0].reasonCode, 'busy');
        await alpha.whenIdle();
        await wait(() => ctx.dshBotConnectors.runtime().some(r => r.sessionId === alpha.session.id && r.state === 'ready' && r.appliedRevision === r.desiredRevision));
        await wait(() => ctx.dshBotNotifications.list().some(r => r.text === 'P34_PRODUCT_REPORT' && r.state === 'recorded'));
        assert.equal(await ctx.sessions.flush(alpha.session), true);
        // Public native guard denies immediately while an actual maintenance task owns idle.
        let release; const held = alpha.runMaintenance(() => new Promise(accept => { release = accept; }));
        await invoke('dshBot.connectors', 'saveAssignment', { input: { id: 'alpha', bot: keys.alpha, connectorId: 'alpha', enabled: false }, expectedRevision: 1 });
        const denied = await ctx.tools.execute({ agent: alpha, name: 'mcp__github__alpha', callId: ToolCallId(randomUUID()), arguments: {}, signal: abort.signal });
        assert.equal(denied.isError, true); release(); await held;
        await invoke('dshBot.connectors', 'saveAssignment', { input: { id: 'alpha', bot: keys.alpha, connectorId: 'alpha', enabled: true }, expectedRevision: 2 });
        await invoke('dshBot.connectors', 'applyIdle', { bot: keys.alpha });
        assert.deepEqual((await Promise.all(['alpha','beta'].map(id => ctx.dshBots.openConversation(id)))).map(m => m.sessionId), ids);
        let externalCalls = 0;
        const detachPort = ctx.dshBotNotifications.attachPort({ async describe() { return { targetDigest: 'synthetic-fixed-target', label: 'Fake platform' }; }, async send() { externalCalls++; return { state: 'accepted' }; } }, ctx);
        closers.push(detachPort);
        const externalPolicy = await invoke('dshBot.notifications', 'savePolicy', { input: { id: 'external-alpha', owner: keys.alpha, channel: 'im', targetRef: 'synthetic-target', enabled: true,
          timezone: 'UTC', dailyLimit: 0, cooldownSec: 0, authorization: { mode: 'ask' } }, expectedRevision: 0, confirmed: false });
        const nativeMessage = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'P34_NATIVE_INBOX_STAYS' }] });
        alpha.inbox.append('next-turn', nativeMessage);
        const nativeBefore = alpha.inbox.nextTurn.map(m => m.id);
        const suppressed = await ctx.dshBotNotifications.record(keys.alpha, { operationId: 'external-suppressed', policyId: 'external-alpha', text: 'P34_SUPPRESSED_EXTERNAL' }, { kind: 'tool', id: 'fake-adapter-check', sessionId: alpha.session.id });
        assert.equal((await ctx.dshBotNotifications.deliver(suppressed.id, externalPolicy.scopeDigest)).state, 'suppressed');
        assert.equal(externalCalls, 0); assert.deepEqual(alpha.inbox.nextTurn.map(m => m.id), nativeBefore);
        assert.equal(await ctx.sessions.flush(alpha.session), true);
        assert.equal(alpha.inbox.remove(nativeMessage.id), true); assert.equal(await ctx.sessions.flush(alpha.session), true);
        await save('inbox-isolation', { status: 'PASS', externalCalls, pendingNativeMessagePreserved: true, flush: true });
        detachPort();
        await save('identity', { ids });
      } else {
        const { readFile } = await import('node:fs/promises'); const identity = JSON.parse(await readFile(resolve(config.outputDir, 'first-identity.json')));
        assert.deepEqual(ids, identity.ids); assert.ok(ctx.dshBotNotifications.list().some(r => r.text === 'P34_PRODUCT_REPORT'));
      }
      const docs = await Promise.all((await ctx.dshBots.status()).map(b => ctx.agentPresets.readDocument(b.presetId)));
      const dto = await invoke('dshBot.connectors', 'catalog');
      const surfaces = JSON.stringify({ docs, dto, credentialInfo });
      for (const id of ['ALPHA','BETA']) assert.ok(!surfaces.includes(process.env[`P34_${id}_TOKEN`]));
      await assert.rejects(() => invoke('dshBot.connectors', 'saveDefinition', { input: { id: 'bad', label: 'bad', transport: 'streamable-http', serverName: 'bad', url: 'https://user:password@host/mcp' }, expectedRevision: 0 }));
      await save('result', { status: 'PASS', sessionIds: ids, runtime: dto.runtime, notifications: dto.notifications, noSecretInDocumentsOrDto: true, desktopSupported: dto.desktopSupported, imSupported: dto.imSupported });
      console.log('P34_PRODUCT_DONE');
    })().catch(async error => { await save('fatal', { error: String(error), stack: error.stack }); console.log('P34_PRODUCT_FAILED'); });
    return async () => { stopping = true; abort.abort(); await run; for (const close of closers.reverse()) await close(); await save('disposed', { disposed: true }); };
  });
}
