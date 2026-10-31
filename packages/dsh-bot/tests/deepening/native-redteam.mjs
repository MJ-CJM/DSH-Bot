import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryLineage } from '../../lib/host/data-flow/lineage.js';
import { prepareAutomaticShare } from '../../lib/host/memory/auto-share.js';
import { pairs } from './b6b-cases.ts';
import { nativeRoute } from './native-redteam-routes.mjs';

/** Fault injection wraps the actual admission/transport callbacks; it never substitutes a transport. */
export async function nativeTransportPairs(ctx, adapter, config, signal) {
  const registry = ctx.dshBots, flow = registry.memoryOutlets, results = [];
  for (const pair of pairs) for (const variant of ['control', 'attack']) {
    signal.throwIfAborted();
    const id = `${pair.id}-${variant}`, file = resolve(config.outputDir, 'receipts', `${id}.json`);
    if (pair.outlet === 'auto-share') {
      assert.throws(() => prepareAutomaticShare({ trusted: true }, {}));
      const receipt = { ...pair, id, variant, status: variant === 'attack' ? 'PASS' : 'FAIL(capability)',
        nativeTransportCalls: 0, reason: 'R5: no trustworthy public human ingress', realModelRequests: 0 };
      results.push(receipt); await writeFile(file, JSON.stringify(receipt, null, 2), { flag: 'wx' }); continue;
    }
    const ids = {}, agents = {}, keys = {};
    for (const suffix of ['a', 'b', 'c']) {
      ids[suffix] = `${pair.id.toLowerCase()}-${variant === 'control' ? 'c' : 'x'}-${suffix}`;
      const bot = await registry.create({ id: ids[suffix], name: ids[suffix], template: 'minimal',
        model: { provider: 'dp-b6b', model: 'fixture' }, persona: { prefix: 'Synthetic B7 redteam.' } });
      keys[suffix] = { botId: bot.id, botCreatedAt: bot.createdAt };
      const main = await registry.openConversation(bot.id), resolved = await ctx.sessionController.resolveAgent(main.sessionId);
      assert.ok(resolved.agent); agents[suffix] = resolved.agent;
    }
    const privateId = (await registry.memoryFor(ids.c).save({ content: `B7_FOREIGN_PRIVATE_${id}` })).id;
    let entered = 0, sent = 0, rejected = 0, routeError;
    const tracked = new Set(), admit = flow.admit.bind(flow), dispatch = flow.dispatch.bind(flow);
    flow.admit = async (original, permission, requestSignal) => {
      if (original.outlet !== pair.outlet) return admit(original, permission, requestSignal);
      entered++; let envelope = structuredClone(original), grant = permission;
      if (variant === 'attack') {
        if (pair.attack === 'private') {
          const session = envelope.binding.invocation.split('/')[0], version = registry.memoryKernel.snapshot.versions.get(privateId);
          const label = await new MemoryLineage(registry.memoryKernel).record(session, [version.versionId]);
          await flow.inherit(session, label);
          const call = envelope.binding.invocation.slice(session.length + 1);
          envelope = flow.draft(pair.outlet, envelope.binding.bot, session, call, envelope.binding.target, envelope.content);
          grant = undefined;
        } else if (pair.attack === 'secret') envelope.label.restrictions.push('secret');
        else if (pair.attack === 'epoch') envelope.binding.epoch++;
        else if (pair.attack === 'birth') envelope.binding.bot.botCreatedAt++;
        else if (pair.attack === 'unknown') envelope.binding.sourceVersions.push(randomUUID());
        else if (pair.attack === 'payload') {
          // Exact Host-only grant is a fault fixture, never evidence of human consent or trusted ingress.
          grant = flow.checker.grants.issue(envelope.binding, envelope.content); envelope.content += 'B7_MUTATED_AFTER_GRANT';
        }
      }
      try { const token = await admit(envelope, grant, requestSignal); tracked.add(token); return token; }
      catch (error) { rejected++; throw error; }
    };
    flow.dispatch = (token, transport, requestSignal) => dispatch(token, (envelope, currentSignal) => {
      if (tracked.has(token)) sent++;
      return transport(envelope, currentSignal);
    }, requestSignal);
    let route;
    try {
      route = await nativeRoute(ctx, registry, adapter, pair, ids, keys, agents, config.outputDir, signal);
    } catch (error) { routeError = String(error); }
    try {
      // Delegate result settlement is asynchronous. Wait for this precise boundary or the run deadline.
      while ((!entered || !sent && !rejected) && pair.outlet === 'delegate-result') await delay(20, undefined, { signal });
      if (variant === 'control') assert.ok(entered > 0 && sent > 0 && !routeError, `${id}: ${routeError ?? 'native outlet not reached'}`);
      else assert.ok(entered > 0 && rejected > 0 && sent === 0, `${id}: attack did not stop at the actual outlet`);
      if (variant === 'control') for (const token of tracked) assert.equal(flow.get(token).state, 'delivered');
      const receipt = { ...pair, id, variant, status: 'PASS', evidenceLevel: 'CLI_HOST_NATIVE_TRANSPORT / synthetic faults',
        selectedOutletEntries: entered, nativeTransportCalls: sent, rejected, route, routeError,
        exactGrantFixture: variant === 'attack' && pair.attack === 'payload', realModelRequests: 0 };
      results.push(receipt); await writeFile(file, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    } catch (error) {
      const receipt = { ...pair, id, variant, status: 'FAIL', error: String(error), routeError, entered, sent, rejected };
      results.push(receipt); await writeFile(file, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    } finally { flow.admit = admit; flow.dispatch = dispatch; }
    console.log(`DP_B6B_PHASE redteam-${id}`);
  }
  return { status: 'FAIL (capability)', evidenceLevel: 'CLI_HOST_NATIVE_TRANSPORT', results,
    nativeTransportMatrix: results.filter(r => r.outlet !== 'auto-share').every(r => r.status === 'PASS') ? 'PASS' : 'FAIL',
    attacks: results.filter(r => r.variant === 'attack').length, controls: results.filter(r => r.variant === 'control').length,
    automaticLegalPaths: 'FAIL(capability)', realModelRequests: 0 };
}
