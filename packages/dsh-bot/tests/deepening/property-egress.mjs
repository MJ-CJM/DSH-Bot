import assert from 'node:assert/strict';
import { OnceGrants } from '../../lib/host/data-flow/grants.js';
import { EgressChecker } from '../../lib/host/data-flow/egress.js';
import { ManagedOutlets } from '../../lib/host/data-flow/outlets.js';
import { AutoShareQuota } from '../../lib/host/memory/quota.js';
import { createInput, accounting, alpha, beta, erase, replayEqual } from './property-runtime.mjs';

export function egressState(runtime, model) {
  const grants = new OnceGrants(runtime.kernel, 100, () => model.now);
  const checker = new EgressChecker(runtime.kernel, grants, b => model.births.get(b.botId) === b.botCreatedAt);
  return { grants, checker, flow: new ManagedOutlets(checker), quota: new AutoShareQuota(runtime.kernel, () => model.now) };
}
export function egressCommand(action, slot) {
  return { check: () => true, toString: () => `egress(${action},${slot})`, async run(model, real) {
    const runtime = real.runtime, state = real.state;
    const kernel = runtime.kernel;
    if (action === 0 || !model.source) {
      const id = await runtime.manage().create(createInput(runtime, 'SHARED_CONTROL', 'shared'));
      model.source = id;
      const version = kernel.snapshot.versions.get(id);
      model.session = `sequence-${model.steps}`;
      await state.flow.inherit(model.session, { readers: 'shared', originTrust: 'user_confirmed',
        sourceVersions: [version.versionId], restrictions: ['no-egress'], grants: [] });
    } else if (action === 1) {
      const external = slot % 2 === 0, target = external ? { kind: 'external', destination: 'synthetic:capture' } : { kind: 'bot', bot: beta };
      const envelope = state.flow.draft('message', alpha, model.session, `call-${model.steps}`, target, 'SYNTHETIC_BODY');
      const grant = external ? state.grants.issue(envelope.binding, envelope.content) : undefined;
      try { const id = await state.flow.admit(envelope, grant);
        model.pending.push({ id, external, at: model.now, session: model.session, tainted: model.tainted.has(model.session) }); }
      catch { assert.ok(model.births.get('alpha') !== 1 || model.births.get('beta') !== 2 || model.tainted.has(model.session)); }
    } else if (action === 2 && model.pending.length) {
      const row = model.pending.shift(), before = model.sent;
      const shouldSend = !row.expired && !row.cold && !row.tainted && !row.erased &&
        model.births.get('alpha') === 1 && model.births.get('beta') === 2 && (!row.external || model.now < row.at + 100);
      try {
        await state.flow.dispatch(row.id, () => { model.sent++; }); assert.equal(shouldSend, true);
      } catch (error) { if (model.sent !== before || shouldSend) throw error; }
      if (!shouldSend) assert.equal(model.sent, before);
      await assert.rejects(state.flow.dispatch(row.id, () => { throw new Error('Duplicate effect'); }));
    } else if (action === 3) {
      model.now += 101;
    } else if (action === 4) {
      await state.flow.close(); state.checker.close(); await runtime.reopen();
      real.state = egressState(runtime, model); await real.state.flow.recover();
      for (const row of model.pending) if (row.external) row.cold = true;
    } else if (action === 5) {
      model.births.set(slot % 2 ? 'alpha' : 'beta', 99);
    } else if (action === 6) {
      const quota = state.quota, owner = { botId: slot % 2 ? 'alpha' : 'beta', botCreatedAt: 1 };
      if (!kernel.snapshot.autoPolicy) await quota.configure({ enabled: true, botDaily: 2, domainDaily: 3, timeZone: 'UTC' });
      const previous = [...kernel.snapshot.quota.values()], same = previous.filter(c => c.botId === owner.botId).length;
      const op = accounting(runtime, owner), allowed = same < 2 && previous.length < 3;
      try { await quota.commit(op.opId, owner, kernel.policyRevision, () => op); assert.ok(allowed); }
      catch (error) { if (allowed) throw error; }
      assert.ok(kernel.snapshot.quota.size <= 3);
    } else if (action === 7) {
      await state.flow.inherit(model.session, { readers: [alpha], originTrust: 'candidate', sourceVersions: [],
        restrictions: ['secret'], grants: [] });
      model.tainted.add(model.session);
      for (const row of model.pending) if (row.session === model.session) row.tainted = true;
    } else if (action === 8 && model.source) {
      await erase(runtime, model.source); model.source = undefined;
      for (const row of model.pending) row.erased = true;
    } else if (action === 9 && model.pending.length) {
      const row = model.pending.shift(), controller = new AbortController(); controller.abort();
      await assert.rejects(state.flow.dispatch(row.id, () => { throw new Error('Cancelled side effect'); }, controller.signal));
    }
    model.steps++; if (model.steps % 20 === 0) replayEqual(runtime.kernel);
  } };
}
export const egressModel = () => ({ now: Date.UTC(2026, 9, 27), steps: 0, births: new Map([['alpha', 1], ['beta', 2]]),
  source: undefined, session: '', tainted: new Set(), pending: [], sent: 0 });
