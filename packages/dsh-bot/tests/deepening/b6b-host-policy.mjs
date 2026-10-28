import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pairs } from './b6b-cases.ts';
import { prepareAutomaticShare } from '../../lib/host/memory/auto-share.js';
import { MemoryLineage } from '../../lib/host/data-flow/lineage.js';

/** Actual Host kernel, synthetic capture callbacks. Never label this native transport or human approval evidence. */
export async function hostPolicyPairs(registry, keys) {
  const flow = registry.memoryOutlets, kernel = registry.memoryKernel;
  const sharedId = await registry.manageMemory(memory => memory.create({ botId: 'alpha', scope: 'shared', kind: 'user_fact',
    content: 'B6B_SHARED_FIXTURE', valid: { from: null, to: null, basis: 'unknown' }, expectedRevision: kernel.seq }));
  const privateId = (await registry.memoryFor('alpha').save({ content: 'PRIVATE_CANARY_B6B' })).id;
  const results = [];
  for (const pair of pairs) {
    const session = `synthetic-policy-${pair.id}`, source = pair.attack === 'private' ? privateId : sharedId;
    const sharedVersion = kernel.snapshot.versions.get(sharedId), sourceVersion = kernel.snapshot.versions.get(source);
    assert.ok(sharedVersion && sourceVersion);
    const lineage = new MemoryLineage(kernel), clean = `${session}-clean`;
    await flow.inherit(clean, await lineage.record(clean, [sharedVersion.versionId]));
    await flow.inherit(session, await lineage.record(session, [sourceVersion.versionId]));
    const target = ['connector', 'notify-send'].includes(pair.outlet) ? { kind: 'external', destination: 'synthetic:capture' }
      : pair.outlet === 'auto-share' ? { kind: 'shared' } : { kind: 'bot', bot: keys.beta };
    const control = flow.draft(pair.outlet, keys.alpha, clean, pair.id, target, 'CONTROL'), sent = [];
    if (pair.outlet !== 'auto-share') {
      // Test-only exact grant: verifies accounting and route binding, not a native user authorization.
      const grant = target.kind === 'external' ? flow.checker.grants.issue(control.binding, control.content) : undefined;
      await flow.dispatch(await flow.admit(control, grant), e => sent.push(e.content));
      assert.deepEqual(sent, ['CONTROL']);
    } else assert.throws(() => prepareAutomaticShare({}, {}));
    let attack = flow.draft(pair.outlet, keys.alpha, session, pair.id, target, 'PRIVATE_CANARY_B6B');
    if (pair.attack === 'secret') attack.label.restrictions.push('secret');
    if (pair.attack === 'epoch') attack.binding.epoch++;
    if (pair.attack === 'birth') attack.binding.bot.botCreatedAt++;
    if (pair.attack === 'unknown') attack.binding.sourceVersions = [randomUUID()];
    let blocked = false;
    try {
      if (pair.outlet === 'auto-share') prepareAutomaticShare(attack, {});
      else if (pair.attack === 'payload') {
        const grant = flow.checker.grants.issue(attack.binding, attack.content);
        attack = { ...attack, content: `${attack.content}_MUTATED` }; await flow.admit(attack, grant);
      } else await flow.admit(attack);
    } catch { blocked = true; }
    assert.equal(blocked, true, pair.id);
    results.push({ ...pair, attack: 'PASS', control: pair.controlExpectation === 'delivered' ? 'HOST_CORE_PASS' : 'FAIL(capability)' });
  }
  return { status: 'FAIL (capability/native-transport)', evidenceLevel: 'HOST_CORE_SYNTHETIC_CAPTURE', policyPairs: results,
    nativeTransportMatrix: 'FAIL (NOT_RUN): captured callbacks are not native outlet transport', realModelRequests: 0 };
}
