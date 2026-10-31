import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';
export const name = 'groups-workspace-probe';
export const inject = ['loader', 'llm', 'agents', 'agentPresets', 'sessions', 'sessionController', 'workspaceRegistry', 'typertGateway', 'fileUploads'];
const ROOT_PRESET = 'dsh-bot-group-root';
class Adapter extends LlmAdapter {
  ctx; calls = []; expectFile = false;
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic workspace group fixture' }]; }
  async *stream(options) {
    const agent = this.ctx.agents.get(options.sessionId); assert.ok(agent);
    assert.notEqual(agent.session.header.agentPreset, ROOT_PRESET, 'Group root invoked the model');
    assert.ok(agent.session.header.parentSession);
    if (this.expectFile) assert.ok(JSON.stringify(options).includes('workspace-input.txt'));
    this.calls.push({ sessionId: agent.id, parent: agent.session.header.parentSession, preset: agent.session.header.agentPreset });
    const text = `WORKSPACE_GROUP_REPLY_${this.calls.length}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const lifetime = new AbortController(), adapter = new Adapter(); adapter.ctx = ctx;
    let phase = 'loader', productFork, temporaryPreset, peer; const releases = [];
    const save = (name, value) => writeFile(resolve(config.outputDir, `${name}.json`), JSON.stringify(value, null, 2));
    const mark = async value => { phase = value; console.log(`GROUP_WORKSPACE_PHASE ${value}`); await save('progress', { phase }); };
    const wait = async check => { for (;;) { lifetime.signal.throwIfAborted(); const value = await check(); if (value) return value; await delay(20, undefined, { signal: lifetime.signal }); } };
    const timer = setTimeout(() => lifetime.abort(new Error(`Workspace group timeout: ${phase}`)), 60000);
    const run = (async () => {
      await mark('loader'); await ctx.loader.await(); assert.equal(ctx.get('dshBots'), undefined);
      assert.deepEqual(ctx.llm.listProviders(), []); releases.push(ctx.llm.registerAdapter(['dp-b6b'], adapter));
      // Representative native time/skills middleware installed before the root preset.
      // A non-prepended root guard would have its empty decision refilled and call the model.
      let rootContextHooks = 0;
      releases.push(ctx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next();
        if (agent.session.header.agentPreset !== ROOT_PRESET || decision.kind === 'reject') return decision;
        rootContextHooks++;
        return { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'dsh-bot-fixture-context' }, content: [{ type: 'text', text: 'Synthetic native context injection' }] })] };
      }));
      const product = await import(pathToFileURL(resolve(config.installedRoot, 'lib/index.js')).href);
      const productConfig = { dataDir: resolve(config.outputDir, 'bots'), seedExamples: false, messagingEnabled: true };
      const activate = async () => {
        productFork = ctx.plugin(product, productConfig); await productFork.await();
        const registry = await wait(() => ctx.get('dshBots')); await registry.waitUntilReady();
        const groups = await wait(() => ctx.get('dshBotGroups')); await wait(() => registry.mainSessions);
        return { registry, groups };
      };
      await mark('first-activation'); let { registry, groups } = await activate();
      const bots = [];
      for (const id of ['alpha', 'beta']) bots.push(await registry.create({ id, name: id, template: 'minimal', model: { provider: 'dp-b6b', model: 'fixture' } }));
      const members = bots.map(bot => ({ botId: bot.id, botCreatedAt: bot.createdAt }));
      const group = await groups.create({ operationId: 'workspace-new', name: 'Native workspace group', mode: 'natural', members, historyConfirmed: true });
      const legacyCwd = resolve(config.outputDir, 'legacy-cwd'); await mkdir(legacyCwd);
      const legacy = await groups.create({ operationId: 'workspace-legacy', name: 'Legacy cwd group', mode: 'mention', members, cwd: legacyCwd, historyConfirmed: true });
      const key = g => ({ groupId: g.id, groupCreatedAt: g.createdAt });
      const assertSetup = async g => {
        const root = ctx.agents.get(g.rootSessionId), events = root.session.snapshotEvents();
        assert.equal((await ctx.sessionController.list({})).items.find(row => row.sessionId === g.rootSessionId)?.blank, false);
        assert.equal(events.filter(e => e.type === 'turn/start').length, 1);
        assert.ok(events.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'));
        assert.equal(events.filter(e => e.type === 'user/message').length, 0, 'Setup fabricated a human input');
        assert.equal(events.filter(e => e.type === 'step/start' || e.type === 'request/header').length, 0);
      };
      await assertSetup(group); await assertSetup(legacy); assert.equal(adapter.calls.length, 0); assert.ok(rootContextHooks >= 2);

      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, args = {}) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: lifetime.signal });
      await mark('native-open-and-concurrent-send');
      const beforeRoot = ctx.agents.get(group.rootSessionId);
      const [opened, again, turn] = await Promise.all([
        invoke('open', { group: key(group) }), invoke('open', { group: key(group) }),
        invoke('send', { group: key(group), input: { operationId: 'workspace-first', text: 'First workspace group question', expectedMembershipRevision: 1 } }),
      ]);
      assert.deepEqual(opened, again); assert.equal(opened.sessionId, group.rootSessionId);
      assert.equal(beforeRoot.session.snapshotEvents().filter(e => e.type === 'turn/start').length, 1, 'Open repeated native setup');
      const botsWorkspace = await registry.ensureBotsWorkspace(); assert.equal(group.cwd, botsWorkspace.path); assert.equal(opened.workspaceId, botsWorkspace.workspaceId);
      assert.ok(ctx.workspaceRegistry.get(opened.workspaceId).sessionIds.includes(group.rootSessionId));
      const resolved = await ctx.sessionController.resolveAgent(opened.sessionId); assert.equal(resolved.agent, beforeRoot);
      await wait(async () => (await groups.view(key(group))).turns.find(t => t.id === turn.id)?.state === 'completed');
      const firstView = await groups.view(key(group)); assert.equal(firstView.messages.length, 3);
      const legacyOpened = await invoke('open', { group: key(legacy) }); assert.equal(ctx.workspaceRegistry.get(legacyOpened.workspaceId).path, legacyCwd);
      await assert.rejects(() => invoke('open', { group: key(group), workspaceId: 'forged' }));
      await save('first-open', { group, legacy, opened, legacyOpened, firstView });
      await mark('dispose-first-owner'); await productFork.dispose(); productFork = undefined;
      assert.equal(ctx.agents.get(group.rootSessionId), undefined); assert.equal(ctx.agents.get(legacy.rootSessionId), undefined);
      // Public preset registration lets Controller restore before the next product generation exists.
      temporaryPreset = await ctx.agentPresets.register({ id: ROOT_PRESET, name: ROOT_PRESET,
        plugins: [{ id: 'group-root-guard', name: 'dsh-bot/group-root-guard' }] });
      const controller = (await ctx.sessionController.resolveAgent(group.rootSessionId)).agent,
        legacyController = (await ctx.sessionController.resolveAgent(legacy.rootSessionId)).agent;
      assert.ok(controller); assert.ok(legacyController);
      await temporaryPreset(); temporaryPreset = undefined;
      await mark('controller-first-reload'); ({ registry, groups } = await activate());
      assert.equal(groups.lifecycle().ownedRoots, 0);
      assert.equal(ctx.agents.get(group.rootSessionId), controller);
      const reopened = await invoke('open', { group: key(group) }); assert.deepEqual(reopened, opened);
      const legacyReopened = await invoke('open', { group: key(legacy) }); assert.deepEqual(legacyReopened, legacyOpened);
      assert.equal((await groups.view(key(legacy))).group.cwd, legacyCwd);
      assert.deepEqual((await groups.view(key(group))).messages, firstView.messages);
      await mark('borrowed-root-file-send');
      adapter.expectFile = true;
      const file = await ctx.fileUploads.upload(controller, { data: Buffer.from('Workspace group native file').toString('base64'), name: 'workspace-input.txt' }, lifetime.signal);
      const next = await invoke('send', { group: key(group), input: { operationId: 'workspace-borrowed', text: '', fileReceiptIds: [file.receiptId], expectedMembershipRevision: 1 } });
      await wait(async () => (await groups.view(key(group))).turns.find(t => t.id === next.id)?.state === 'completed');
      const finalView = await groups.view(key(group));
      assert.equal(finalView.messages.find(m => m.id === next.inputMessageId).attachments[0].attachment.attachmentId, file.file.attachmentId);
      await mark('archive-borrowed'); const currentLegacy = (await groups.view(key(legacy))).group;
      await groups.archive(key(legacy), currentLegacy.revision); assert.equal(ctx.agents.get(legacy.rootSessionId), legacyController);
      await mark('unload-keeps-controller-root'); await productFork.dispose(); productFork = undefined;
      assert.equal(ctx.agents.get(group.rootSessionId), controller); assert.equal(ctx.agents.get(legacy.rootSessionId), legacyController);
      adapter.expectFile = false; const before = adapter.calls.length;
      for (const root of [controller, legacyController]) {
        assert.equal((await ctx.sessionController.prompt({ sessionId: root.id, requestId: `must-block-${root.id}`, mode: 'queue', content: [{ type: 'text', text: 'DO_NOT_ROUTE_NATIVE_ROOT_INPUT' }] }, lifetime.signal)).accepted, true);
        await root.whenIdle(); assert.equal(root.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason.kind, 'blocked');
      }
      assert.equal(adapter.calls.length, before); assert.equal(controller.session.snapshotEvents().some(e => e.type === 'assistant/message'), false);
      await save('final-view', finalView); await save('adapter', { count: adapter.calls.length, calls: adapter.calls, rootRequests: 0, realModelRequests: 0 });
      await save('result', { status: 'PASS', newRootInBotsWorkspace: true, emptyRootNativeNonblank: true, setupFabricatedUsers: 0, outerNativeContextSuppressed: true, legacyCwdAndWorkspaceRetained: true, repeatedOpenSameIds: true,
        concurrentOpenSendCompleted: true, controllerFirstBorrowed: true, borrowedFileSendCompleted: true, archivedBorrowedNotDisposed: true,
        unloadBorrowedNotDisposed: true, unloadedNativeRootPromptBlocked: true, rootModelRequests: 0, syntheticModelRequests: adapter.calls.length, realModelRequests: 0 });
      console.log('GROUP_WORKSPACE_DONE');
    })().catch(async error => { await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, calls: adapter.calls, realModelRequests: 0 }); console.log('GROUP_WORKSPACE_FAILED'); });
    return async () => { clearTimeout(timer); lifetime.abort(); await run; await peer?.dispose(); await productFork?.dispose(); await temporaryPreset?.(); for (const release of releases.reverse()) release(); };
  });
}
