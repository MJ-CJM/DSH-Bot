import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export async function nativeRoute(ctx, registry, adapter, row, ids, keys, agents, outputDir, signal) {
  const until = async check => {
    while (!await check()) { signal.throwIfAborted(); await delay(20, undefined, { signal }); }
  };
  const prompt = async tool => {
    adapter.plans.set(agents.a.session.id, [tool]);
    const accepted = await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: agents.a.session.id,
      mode: 'queue', content: [{ type: 'text', text: 'Synthetic native outlet matrix task.' }] }, signal);
    assert.equal(accepted.accepted, true); await agents.a.whenIdle();
  };
  if (row.outlet === 'message') {
    await prompt({ name: 'bot_message', arguments: { action: 'send', to: ids.b, mode: 'notify', content: 'B7_NATIVE_MESSAGE' } });
    await ctx.dshBotMessaging.settled(); await agents.b.whenIdle();
    return { transport: 'native Agent.followup + JSONL flush' };
  }
  if (row.outlet.startsWith('group-')) {
    const group = await ctx.dshBotGroups.create({ operationId: randomUUID(), name: row.id,
      members: [keys.a, keys.b], mode: 'round-robin', historyConfirmed: true });
    const key = { groupId: group.id, groupCreatedAt: group.createdAt };
    const turn = await ctx.dshBotGroups.send(key, { operationId: randomUUID(), text: 'B7_NATIVE_GROUP',
      round: true, expectedMembershipRevision: group.membershipRevision });
    await until(async () => (await ctx.dshBotGroups.view(key)).turns.some(t => t.id === turn.id &&
      ['completed', 'partial', 'cancelled', 'recovery_needed'].includes(t.state)));
    return { transport: 'native group child activation + persistent group result' };
  }
  if (row.outlet.startsWith('delegate-')) {
    await prompt({ name: 'bot_delegate', arguments: { targetBotId: ids.b, task: 'B7_NATIVE_DELEGATE' } });
    // The matrix observer waits for the exact selected outlet, not an unrelated child completion.
    return { transport: 'native subagents.startActivation(delivery=caller) + checked followup' };
  }
  if (row.outlet.startsWith('notify-')) {
    const policyId = `${row.id}-local`;
    await ctx.dshBotNotifications.savePolicy({ id: policyId, owner: keys.a, channel: 'in-app', enabled: true,
      timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, true);
    await prompt({ name: 'bot_notify', arguments: { policyId, text: 'B7_NATIVE_NOTIFICATION' } });
    return { transport: 'production in-app notification record/display', systemNotifications: 0, imSends: 0 };
  }
  if (row.outlet === 'mcp-copy') {
    await registry.memoryFor(ids.a).save({ content: 'B7_NATIVE_MCP_RECORD' });
    const graph = ctx.dshBotReferenceMemory;
    const preview = await graph.request({ action: 'preview', bot: keys.a });
    await graph.request({ action: 'stage', bot: keys.a, copyId: preview.copy.id });
    await graph.request({ action: 'commit', bot: keys.a, copyId: preview.copy.id, confirmed: true });
    const read = await graph.request({ action: 'tool', bot: keys.a, call: { tool: 'read_graph', arguments: {} } });
    assert.ok(JSON.stringify(read.graph).includes('B7_NATIVE_MCP_RECORD'));
    return { transport: 'published server-memory / native MCP stdio / actual read_graph' };
  }
  if (row.outlet === 'connector') {
    const service = ctx.get('dshBotConnectors'); assert.ok(service);
    const connectorId = `${row.id}-stdio`;
    await service.saveDefinition({ id: connectorId, label: connectorId, transport: 'stdio', serverName: 'stdio', enabled: true,
      command: process.execPath, args: [resolve('spikes/p34/src/stdio-fixture.ts'), resolve(outputDir, `${connectorId}-pid.json`)],
      credentialBindings: [] }, 0);
    await service.saveAssignment({ id: `${row.id}-assignment`, bot: keys.a, connectorId, enabled: true }, 0);
    await service.applyIdle(keys.a);
    assert.ok(service.runtime().some(r => r.sessionId === agents.a.session.id && r.state === 'ready'));
    await prompt({ name: 'mcp__stdio__stdio', arguments: {} });
    return { transport: 'native MCP connector stdio / real tools.execute', externalServers: 0 };
  }
  throw new Error(`Unknown native route: ${row.outlet}`);
}
