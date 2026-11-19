import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
export const name = 'group-export-fixture';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'typertGateway', 'sessionPersistence'];
export function apply(ctx, config) {
  ctx.effect(() => {
    const controller = new AbortController(), releases = [], calls = new Map();
    let phase = 'startup', readPrivate = true, longReply = false;
    class Adapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Local export fixture' }]; }
      async *stream(options) {
        const count = calls.get(options.sessionId) ?? 0; calls.set(options.sessionId, count + 1);
        if (!count && readPrivate) {
          const id = ToolCallId('private-read');
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id, name: 'bot_memory_list', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bot_memory_list', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        const text = (longReply ? 'A long collaboration lesson for the group.\n'.repeat(55) : '') +
          'PRIVATE_REVIEW_REPLY: collaboration lesson. <img src="https://example.invalid/leak">';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const wait = async check => { for (let n = 0; n < 1000; n++) { const v = await check(); if (v) return v; await delay(30); } throw Error('Timed out: '+phase); };
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      releases.push(ctx.llm.registerAdapter(['dp-export'], new Adapter()));
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' }); releases.push(() => peer.dispose());
      const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'dshBot.groups', method, args, peer, signal: controller.signal });
      const existing = await groups.list();
      if (existing.length) {
        const views = await Promise.all(existing.map(row => groups.view({ groupId: row.group.id, groupCreatedAt: row.group.createdAt })));
        assert.ok(views.some(v => v.deliveries.some(d => d.reasonCode === 'export-approval-required')));
        assert.ok(views.some(v => v.group.exportApprovals?.length));
        assert.equal(calls.size, 0);
        await writeFile(resolve(config.outputDir, 'cold-result.json'), JSON.stringify({ status: 'PASS', autoReplay: false, modelRequests: 0 }));
        console.log('B4_WEB_READY'); return;
      }
      const keys = [];
      for (const id of ['export-alpha', 'export-beta', 'export-gamma', 'export-delta', 'export-epsilon', 'export-zeta']) {
        const bot = await ctx.dshBots.create({ id, name: id, template: 'minimal', model: { provider: 'dp-export', model: 'fixture' } });
        keys.push({ botId: id, botCreatedAt: bot.createdAt });
        await ctx.dshBots.memoryFor(id).save({ content: 'PRIVATE_SOURCE_'+id });
      }
      const make = async (name, count = 2) => {
        phase = name;
        const g = await groups.create({ operationId: crypto.randomUUID(), name, mode: 'natural', onDemand: false, members: keys.slice(0, count), historyConfirmed: true });
        const key = { groupId: g.id, groupCreatedAt: g.createdAt };
        const turn = await invoke('send', { group: key, input: { operationId: crypto.randomUUID(), text: 'Review collaboration lessons', expectedMembershipRevision: g.membershipRevision } });
        const v = await wait(async () => { const v = await groups.view(key); return v.turns.find(t => t.id === turn.id && !['accepted','running'].includes(t.state)) && v; });
        const ds = v.deliveries.filter(d => d.turnId === turn.id);
        assert.equal(ds.length, count); assert.ok(ds.every(d => d.reasonCode === 'export-approval-required' && d.exportFlowId));
        assert.ok(!v.messages.some(m => m.text.includes('PRIVATE_REVIEW_REPLY')));
        for (const d of ds) {
          const handle = await ctx.sessionPersistence.open(d.childSessionId, 'read', { signal: controller.signal });
          try { const snapshot = await handle.read(); assert.equal(snapshot.events.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed'); } finally { await handle.close(); }
        }
        return { g, key, ds };
      };
      const a = await make('Export approval verification');
      const settingsBefore = await invoke('getExportApprovalSettings', { group: a.key });
      assert.deepEqual(settingsBefore.readers.map(row => row.bot), keys.slice(0, 2));
      assert.deepEqual(settingsBefore.eligibleBots, keys.slice(0, 2));
      assert.equal(settingsBefore.canEnable, true);
      const settingArgs = { group: a.key, bot: a.ds[0].bot, expectedRevision: settingsBefore.groupRevision,
        expectedMembershipRevision: settingsBefore.membershipRevision };
      const settingsEnabled = await invoke('setExportApproval', { ...settingArgs, enabled: true });
      const stillHeld = await groups.view(a.key);
      assert.ok(stillHeld.deliveries.filter(d => d.turnId === a.ds[0].turnId).every(d => d.reasonCode === 'export-approval-required'));
      assert.equal(stillHeld.messages.filter(m => m.text.includes('PRIVATE_REVIEW_REPLY')).length, 0);
      assert.deepEqual((await invoke('getExportApprovalSettings', { group: a.key })).enabledBots, [a.ds[0].bot]);
      await assert.rejects(invoke('setExportApproval', { ...settingArgs, enabled: false }), error => error.code === 'dsh-bot/conflict');
      await invoke('setExportApproval', { ...settingArgs, enabled: false, expectedRevision: settingsEnabled.revision });
      assert.deepEqual((await invoke('getExportApprovalSettings', { group: a.key })).enabledBots, []);
      const preview = await invoke('reviewExport', { group: a.key, deliveryId: a.ds[0].id });
      assert.ok(preview.content.includes('PRIVATE_REVIEW_REPLY')); assert.equal(preview.recipients.length, 2);
      const count = [...calls.values()].reduce((a,b) => a+b, 0);
      await assert.rejects(invoke('decideExport', { group: a.key, deliveryId: a.ds[0].id, token: '0'.repeat(64), allow: true }));
      await invoke('decideExport', { group: a.key, deliveryId: a.ds[0].id, token: preview.token, allow: 'always' });
      await assert.rejects(invoke('decideExport', { group: a.key, deliveryId: a.ds[0].id, token: preview.token, allow: true }));
      const reject = await invoke('reviewExport', { group: a.key, deliveryId: a.ds[1].id });
      await invoke('decideExport', { group: a.key, deliveryId: a.ds[1].id, token: reject.token, allow: false });
      const done = await groups.view(a.key);
      assert.equal(done.messages.filter(m => m.text.includes('PRIVATE_REVIEW_REPLY')).length, 1);
      assert.equal(done.deliveries.find(d => d.id === a.ds[1].id).reasonCode, 'export-rejected');
      assert.ok(['completed', 'idle'].includes(done.turns.find(t => t.id === a.ds[0].turnId).state));
      assert.equal([...calls.values()].reduce((a,b) => a+b, 0), count);
      assert.ok([...ctx.dshBots.memoryKernel.snapshot.versions.values()].every(v => v.scope === 'private' && v.labels.readers.length === 1));
      // Reproduce the old root taint, then continue from independently verified published copies.
      const flows = ctx.dshBots.memoryOutlets;
      const approved = [...flows.kernel.domain.table('flows').entries()].map(([, row]) => row).find(row => row.state === 'delivered' && row.envelope?.binding.invocation === `${a.ds[0].childSessionId}/${a.ds[0].id}:result`);
      await flows.inherit(a.g.rootSessionId, approved.envelope.label);
      const sendNext = async () => {
        const current = (await groups.view(a.key)).group;
        const turn = await invoke('send', { group: a.key, input: { operationId: crypto.randomUUID(), text: 'Continue with the published collaboration summary', expectedMembershipRevision: current.membershipRevision } });
        return wait(async () => { const v = await groups.view(a.key); return v.turns.find(t => t.id === turn.id && !['accepted','running'].includes(t.state)) && v.deliveries.filter(d => d.turnId === turn.id); });
      };
      phase = 'persistent approval and continuation';
      const beforeRename = (await groups.view(a.key)).group;
      const renamed = await groups.edit(a.key, { expectedRevision: beforeRename.revision, expectedMembershipRevision: beforeRename.membershipRevision,
        name: 'Export approval renamed', mode: beforeRename.mode, members: keys.slice(0, 2).reverse(), historyConfirmed: true });
      assert.equal(renamed.membershipRevision, beforeRename.membershipRevision);
      const next = await sendNext();
      const approvedBot = a.ds[0].bot.botId;
      assert.equal(next.find(d => d.bot.botId === approvedBot).state, 'completed');
      const heldNext = next.find(d => d.bot.botId !== approvedBot);
      assert.equal(heldNext.reasonCode, 'export-approval-required');
      const nextPreview = await invoke('reviewExport', { group: a.key, deliveryId: heldNext.id });
      await invoke('decideExport', { group: a.key, deliveryId: heldNext.id, token: nextPreview.token, allow: true });
      readPrivate = false;
      const ordinary = await sendNext();
      assert.ok(ordinary.every(d => d.state === 'completed'), JSON.stringify(ordinary));
      await invoke('revokeExport', { group: a.key, bot: a.ds[0].bot });
      assert.equal((await groups.view(a.key)).group.exportApprovals.length, 0);
      readPrivate = true;
      const afterRevoke = await sendNext();
      assert.ok(afterRevoke.every(d => d.reasonCode === 'export-approval-required'));
      assert.ok([...ctx.dshBots.memoryKernel.snapshot.versions.values()].every(v => v.scope === 'private' && v.labels.readers.length === 1));
      const changed = await make('Export changed audience');
      const stale = await invoke('reviewExport', { group: changed.key, deliveryId: changed.ds[0].id });
      const latest = (await groups.view(changed.key)).group;
      await groups.edit(changed.key, { expectedRevision: latest.revision, expectedMembershipRevision: latest.membershipRevision,
        name: latest.name, mode: latest.mode, members: [keys[0], keys[2]], historyConfirmed: true });
      await assert.rejects(invoke('decideExport', { group: changed.key, deliveryId: changed.ds[0].id, token: stale.token, allow: true }));
      await invoke('discardExport', { group: changed.key, deliveryId: changed.ds[0].id, expectedRevision: changed.ds[0].revision });
      assert.equal((await groups.view(changed.key)).deliveries.find(d => d.id === changed.ds[0].id).reasonCode, 'export-rejected');
      assert.equal(flows.get(changed.ds[0].exportFlowId).envelope, undefined);
      phase = 'confirmed delivery with preference failure';
      const preference = await make('Export preference fault');
      const prefPreview = await invoke('reviewExport', { group: preference.key, deliveryId: preference.ds[0].id });
      const originalPutGroup = groups.state.putGroup;
      groups.state.putGroup = async value => {
        if (value.id === preference.g.id && value.exportApprovals?.length) throw Error('isolated preference write failure');
        return originalPutGroup.call(groups.state, value);
      };
      try {
        await assert.rejects(invoke('decideExport', { group: preference.key, deliveryId: preference.ds[0].id, token: prefPreview.token, allow: 'always' }),
          error => error.code === 'dsh-bot/group-export-preference-failed');
      } finally { groups.state.putGroup = originalPutGroup; }
      const afterFailure = await groups.view(preference.key);
      assert.equal(afterFailure.deliveries.find(d => d.id === preference.ds[0].id).state, 'completed');
      assert.equal(afterFailure.messages.filter(m => m.text.includes('PRIVATE_REVIEW_REPLY')).length, 1);
      assert.equal(afterFailure.group.exportApprovals?.length ?? 0, 0);
      const coldPreview = await invoke('reviewExport', { group: a.key, deliveryId: afterRevoke[0].id });
      await invoke('decideExport', { group: a.key, deliveryId: afterRevoke[0].id, token: coldPreview.token, allow: 'always' });
      const ui = await make('Export review browser');
      // Synthetic old-version receipt: no envelope was ever admitted or sent.
      await ctx.dshBots.memoryOutlets.kernel.domain.table('flows').delete(ui.ds[0].exportFlowId);
      await groups.state.putDelivery({ ...ui.ds[0], state: 'unknown', reasonCode: 'native-failure', exportFlowId: undefined, stopReason: undefined });
      // The browser must recover this legacy receipt on its first review click.
      // A failed intermediate send must not hide this worker's final review control.
      await groups.state.putDelivery({ ...ui.ds[0], id: `group-message:${'a'.repeat(64)}`, ordinal: 2,
        state: 'unknown', reasonCode: 'message-dispatch-unknown', exportFlowId: undefined });
      const multi = [];
      for (const count of [3, 6]) {
        const name = `Batch approval ${count}`;
        longReply = count === 3;
        const group = await make(name, count);
        multi.push({ name, key: group.key, deliveries: group.ds.map(d => d.id) });
      }
      await writeFile(resolve(config.outputDir, 'result.json'), JSON.stringify({ status: 'PASS', realModelRequests: 0,
        fixtureRequests: [...calls.values()].reduce((a,b) => a+b, 0), checks: ['private read -> completed -> held', 'owner preview', 'exact once', 'reject', 'changed audience', 'discard expired', 'preference failure preserves confirmed delivery', 'no model replay', 'private memory unchanged', 'always approval scoped to Bot and group', 'rename/reorder preserves approval', 'continued chat after poisoned root', 'published copies without new approval', 'revocation requires next approval'], ui: { key: ui.key, sessionId: ui.g.rootSessionId, deliveries: ui.ds.map(d => d.id) }, multi }, null, 2));
      console.log('B4_WEB_READY');
    })().catch(async error => { await writeFile(resolve(config.outputDir, 'fixture-error.json'), JSON.stringify({ phase, error: String(error.stack ?? error) })); console.error('B4_WEB_FAILED', String(error)); });
    return async () => { controller.abort(); for (const off of releases.reverse()) await off(); await run; };
  });
}
