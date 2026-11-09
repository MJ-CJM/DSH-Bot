import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';

export const name = 'proactive-execution-boundaries-fixture';
export const inject = ['loader', 'dshBots', 'llm', 'subprocess'];

class FixtureAdapter extends LoopbackAdapter {
  async *stream(options) {
    assert.equal(options.tools?.length ?? 0, 0);
    const text = JSON.stringify({ field: 'enabled', value: true });
    for await (const chunk of super.stream(options)) {
      if (chunk.type === 'text-delta') yield { ...chunk, text };
      else if (chunk.type === 'block-end') yield { ...chunk, block: { type: 'text', text } };
      else yield chunk;
    }
  }
}

async function waitFor(predicate) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error('Execution boundary fixture timed out');
}

async function exercise(ctx, adapter) {
  await ctx.loader.await();
  await ctx.dshBots.waitUntilReady();
  const service = await waitFor(async () => {
    const candidate = ctx.get('dshBotProactive');
    return (await candidate?.status())?.state === 'ready' && candidate;
  });
  const bot = await ctx.dshBots.create({ id: 'fixture-ci', name: 'Fixture CI', template: 'minimal' });
  const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
  const groups = await waitFor(() => ctx.get('dshBotGroups'));
  const implementer = await ctx.dshBots.create({ id: 'fixture-implementer', name: 'Fixture Implementer', template: 'minimal' });
  const group = await groups.create({ operationId: 'workspace-boundary-group', name: 'Fixture repair group',
    mode: 'natural', historyConfirmed: true,
    members: [owner, { botId: implementer.id, botCreatedAt: implementer.createdAt }] });
  const groupKey = { groupId: group.id, groupCreatedAt: group.createdAt };
  const groupView = await groups.view(groupKey);
  const member = record => {
    const matched = groupView.members.find(row => row.bot.botId === record.id);
    assert.ok(matched?.enabled);
    return { memberId: matched.id, bot: matched.bot, botUpdatedAt: record.updatedAt };
  };
  const groupRepair = { group: groupKey, rootSessionId: group.rootSessionId,
    membershipRevision: group.membershipRevision, supervisor: member(bot), implementer: member(implementer), maxCalls: 3 };
  const status = await service.status();
  assert.equal(status.capabilities.directExecution, true);
  assert.deepEqual(status.workspaceOffers, []);
  assert.deepEqual(status.groupRepairOffers, []);
  assert.ok(!status.actionScopes.some(scope => scope.action === 'repair-workspace'));
  const target = { ...status.directRoute, bot: owner, botUpdatedAt: bot.updatedAt };
  const fixtureOffer = status.repairOffers.find(offer => offer.executor === 'native');
  assert.ok(fixtureOffer);
  const repair = { fixtureId: fixtureOffer.fixtureId, specDigest: fixtureOffer.specDigest, executor: 'native' };
  const installed = join(process.env.DSH_HOME, 'profiles/b4-browser/node_modules/dsh-bot/lib/host/proactive');
  const { createWorkspaceRepairOffer } = await import(join(installed, 'workspace-repair.js'));
  const { CoordinatorClient } = await import(join(installed, 'coordinator-client.js'));
  const request = CoordinatorClient.prototype.request;
  const settings = ctx.dshBots.config;
  const subprocess = ctx.subprocess;
  const spawn = subprocess.spawn;
  const read = service.read;
  const verify = service.verifyDispatch;
  const spawns = [];
  subprocess.spawn = spec => {
    if (/[/\\](workspace|repair)-artifacts[/\\]/.test(spec.cwd ?? ''))
      spawns.push(spec.cwd);
    return spawn.call(subprocess, spec);
  };
  const receipt = reply => {
    assert.equal(reply.kind, 'receipt', JSON.stringify(reply));
    assert.equal(reply.receipt.status, 'committed');
  };
  const scope = { repository: 'fixture/demo', branch: 'main', generation: 1 };
  let runId = 0;
  const observe = async (job, before, generation) => {
    const checkpoint = `end-${job}`;
    receipt(await service.observeCi(randomUUID(), { ...scope, generation }, {
      complete: true, before, after: checkpoint,
      rows: [{ repository: scope.repository, branch: scope.branch, job, runId: String(++runId),
        commit: 'b'.repeat(40), observedAt: new Date().toISOString(), attempt: 1, conclusion: 'failure' }],
    }));
    const decision = (await service.suggestions()).find(row => row.title.includes(job));
    assert.ok(decision, job);
    return { decision, checkpoint };
  };
  const acceptInput = decision => ({
    decisionId: decision.id, expectedRevision: decision.revision, sourceId: decision.sourceId,
    policyVersion: decision.policyVersion, approved: true, target,
  });
  try {
    const { decision: workspaceDecision, checkpoint } = await observe('workspace-boundary', null, 1);
    const command = settings.proactiveCommandExecutor;
    assert.ok(command);
    const offers = await Promise.all(['native', 'command'].map(executor =>
      createWorkspaceRepairOffer(settings.proactiveWorkspaceRepair, executor, command)));
    for (const { workspaceId, specDigest, baselineDigest, executor } of offers) {
      const reply = await service.accept(randomUUID(), {
        ...acceptInput(workspaceDecision),
        workspaceRepair: { workspaceId, specDigest, baselineDigest, executor },
      });
      assert.deepEqual(reply, { kind: 'rejected', code: 'forbidden' });
    }
    const { workspaceId, specDigest, baselineDigest } = offers[0];
    assert.deepEqual(await service.accept(randomUUID(), {
      ...acceptInput(workspaceDecision), groupRepair,
      workspaceRepair: { workspaceId, specDigest, baselineDigest, executor: 'native' },
    }), { kind: 'rejected', code: 'forbidden' });
    const policy = { kind: 'create', id: 'legacy-workspace-auto', owner, draft: {
      name: 'Legacy workspace rule', mode: 'auto', source: { ...scope, id: workspaceDecision.sourceId },
      target, action: 'repair-workspace', actionScopeDigest: offers[0].specDigest,
      conditions: { jobs: ['workspace-auto-boundary'] },
      acceptance: { goal: 'Run the workspace verifier', deliverables: ['Verified artifact'],
        checks: [{ id: 'verify', title: 'Run verifier', kind: 'both' }] },
      limits: { dailyRequests: 8, dailyTokens: 65536, taskTokens: 8192, taskAttempts: 2, taskWallTimeMs: 120000, concurrency: 1 },
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    } };
    // Seed an old rule below the current Host admission checks to exercise the scheduler's recheck.
    receipt(await service.change(randomUUID(), { kind: 'responsibility-mutation', input: policy }));
    const automatic = await observe('workspace-auto-boundary', checkpoint, 1);
    const candidates = await read.call(service, { kind: 'auto-candidates' });
    assert.ok(candidates.rows.some(row => row.responsibility.id === policy.id));
    await delay(1200);
    assert.equal((await service.workList()).length, 0);
    assert.equal(adapter.count, 0);
    assert.equal(spawns.length, 0);

    const { decision: control } = await observe('control', automatic.checkpoint, 1);
    receipt(await service.accept(randomUUID(), { ...acceptInput(control), repair }));
    await service.execution.idle();
    const controlWork = (await service.workList()).find(row => row.decisionId === control.id);
    assert.equal(controlWork?.state, 'delivered');
    assert.equal(controlWork.repairEvidence.baseline.exitCode, 1);
    assert.equal(controlWork.repairEvidence.verification.exitCode, 0);
    assert.equal(spawns.length, 2);
    assert.equal(adapter.count, 1);
    receipt(await service.revokeCi(randomUUID(), scope));

    const boundaries = [];
    for (const [i, stage] of ['claim', 'prepare', 'spawn', 'verification', 'bot-revision'].entries()) {
      const generation = i + 2;
      const { decision } = await observe(stage, null, generation);
      const before = spawns.length;
      let checks = 0, revoked = false, botUpdated = false, cancelling;
      const revoke = async () => {
        assert.equal(revoked, false);
        receipt(await service.revokeCi(randomUUID(), { ...scope, generation }));
        revoked = true;
      };
      service.read = async function (input) {
        const result = await read.call(this, input);
        if (stage === 'claim' && input.kind === 'work-assignment' &&
            result.work?.decisionId === decision.id && result.work?.state === 'claimed')
          await revoke();
        return result;
      };
      service.verifyDispatch = async function (work, options) {
        if (work.decisionId !== decision.id) return verify.call(this, work, options);
        checks++;
        if (stage === 'prepare' && checks === 1) await revoke();
        await verify.call(this, work, options);
        if (stage === 'spawn' && checks === 2) {
          const wrongRevision = await read.call(this, {
            kind: 'dispatch-permitted', assignmentId: work.assignmentId, dispatchRevision: options.dispatchRevision + 1,
          });
          assert.equal(wrongRevision.permitted, false);
          await revoke();
        }
        if (stage === 'verification' && !cancelling && await access(join(process.env.DSH_HOME,
          'dsh-bot-proactive', 'repair-artifacts', work.assignmentId, 'after.json')).then(() => true, () => false)) {
          // The cancel call waits for the active run. Observe its durable fence
          // while the verifier remains held at the final admission boundary.
          cancelling = service.cancel(randomUUID(), { ticketId: work.ticketId, expectedRevision: options.dispatchRevision });
          await waitFor(async () => {
            const current = await read.call(this, { kind: 'work-assignment', assignmentId: work.assignmentId });
            return current.work?.state === 'unknown';
          });
        }
      };
      if (stage === 'bot-revision') {
        CoordinatorClient.prototype.request = async function (input) {
          const reply = await request.call(this, input);
          if (input.kind === 'dispatch-permitted' && input.dispatchRevision !== undefined && checks === 2 && !botUpdated) {
            assert.equal(reply.permitted, true);
            await ctx.dshBots.update(bot.id, { description: 'Committed after the coordinator permission snapshot' });
            botUpdated = true;
          }
          return reply;
        };
      }
      receipt(await service.accept(randomUUID(), { ...acceptInput(decision), repair }));
      await service.execution.idle();
      if (cancelling) receipt(await cancelling);
      service.read = read;
      service.verifyDispatch = verify;
      const row = (await service.workList()).find(item => item.decisionId === decision.id);
      assert.equal(row?.state, stage === 'verification' ? 'unknown' : 'denied', stage);
      assert.equal(revoked, ['claim', 'prepare', 'spawn'].includes(stage));
      assert.equal(botUpdated, stage === 'bot-revision');
      assert.equal(spawns.length - before, stage === 'verification' ? 1 : 0, stage);
      if (stage === 'verification')
        assert.equal(await service.execution.cancelAndDrain(row.ticketId, row.assignmentId), true);
      boundaries.push({ stage, checks, spawned: spawns.length - before, state: row.state });
    }
    assert.equal(adapter.count, 2);
    const workspaceSpawns = spawns.filter(cwd => cwd.includes('workspace-artifacts')).length;
    assert.equal(workspaceSpawns, 0);
    return { workspaceSpawns, manualRoutesBlocked: ['native', 'command', 'group'], autoCandidateBlocked: true, control: { baseline: 1, verification: 0 },
      boundaries, modelRequests: adapter.count };
  } finally {
    CoordinatorClient.prototype.request = request;
    service.read = read;
    service.verifyDispatch = verify;
    subprocess.spawn = spawn;
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const adapter = new FixtureAdapter(config.endpoint);
    assert.equal(ctx.llm.listProviders().length, 0);
    const release = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    void exercise(ctx, adapter).then(async result => {
      await writeFile(join(config.outputDir, 'execution-boundaries.json'), JSON.stringify(result, null, 2));
      console.log('B4_WEB_READY');
    }).catch(async error => {
      await writeFile(join(config.outputDir, 'fixture-error.txt'), String(error.stack ?? error));
      console.error('B4_WEB_FAILED', error);
    });
    return release;
  });
}
