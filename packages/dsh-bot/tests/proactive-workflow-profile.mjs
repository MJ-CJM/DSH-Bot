import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LoopbackAdapter } from './deepening/loopback-adapter.mjs';
import { WorkspaceFixtureAdapter, runWorkspaceFixture } from './proactive-workspace-profile.mjs';
import { GroupRepairFixtureAdapter, runGroupRepairFixture } from './proactive-group-repair-profile.mjs';
import { runDeferredNoticesFixture } from './proactive-deferred-notices-profile.mjs';
import { runGovernanceFixture, runResponsibilityFixture } from './proactive-policy-profile.mjs';

export const name = 'proactive-workflow-fixture';
export const inject = ['loader', 'dshBots', 'llm', 'sessionController'];

class RepairFixtureAdapter extends LoopbackAdapter {
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      const text = JSON.stringify({ field: 'enabled', value: this.count > 1 });
      if (chunk.type === 'text-delta') yield { ...chunk, text };
      else if (chunk.type === 'block-end') yield { ...chunk, block: { type: 'text', text } };
      else yield chunk;
    }
  }
}

class CrashFixtureAdapter extends LoopbackAdapter {
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      if (chunk.type === 'finish') await delay(15000, undefined, { signal: options.signal });
      yield chunk;
    }
  }
}

class LateFollowUpFixtureAdapter extends RepairFixtureAdapter {
  constructor(endpoint, outputDir) {
    super(endpoint);
    this.releaseFile = join(outputDir, 'release-follow-up');
  }
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      if (this.count === 5 && chunk.type === 'finish') {
        const deadline = Date.now() + 10000;
        while (!(await readFile(this.releaseFile, 'utf8').catch(() => ''))) {
          assert.ok(Date.now() < deadline, 'follow-up release fixture timed out');
          await delay(50, undefined, { signal: options.signal });
        }
      }
      yield chunk;
    }
  }
}

class PartialGroupFixtureAdapter extends LoopbackAdapter {
  async *stream(options) {
    if (this.count === 3) this.mode = 'error';
    yield* super.stream(options);
  }
}

class HeldPolicyFixtureAdapter extends LoopbackAdapter {
  constructor(endpoint, repair) {super(endpoint);this.repair=repair;this.hold=false;}
  async *stream(options) {
    for await (const chunk of super.stream(options)) {
      if(chunk.type==='finish')while(this.hold)await delay(50,undefined,{signal:options.signal});
      const text=JSON.stringify({field:'enabled',value:this.count>1});
      if(this.repair&&chunk.type==='text-delta')yield {...chunk,text};
      else if(this.repair&&chunk.type==='block-end')yield {...chunk,block:{type:'text',text}};
      else yield chunk;
    }
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const adapter = config.suite === 'proactive-group-workspace' ? new GroupRepairFixtureAdapter(config.endpoint) : ['proactive-governance','proactive-responsibilities'].includes(config.suite) ? new HeldPolicyFixtureAdapter(config.endpoint,config.suite==='proactive-governance') : config.suite === 'proactive-workspace' ? new WorkspaceFixtureAdapter(config.endpoint) : config.suite === 'proactive-crash'
      ? new CrashFixtureAdapter(config.endpoint)
      : config.suite === 'proactive-group-follow-up-late' ? new LateFollowUpFixtureAdapter(config.endpoint, config.outputDir)
      : ['proactive-repair', 'proactive-group', 'proactive-group-artifact'].includes(config.suite) || config.suite.startsWith('proactive-group-follow-up') ? new RepairFixtureAdapter(config.endpoint)
        : config.suite === 'proactive-group-failure' ? new PartialGroupFixtureAdapter(config.endpoint)
          : new LoopbackAdapter(config.endpoint);
    assert.equal(ctx.llm.listProviders().length, 0);
    const release = ctx.llm.registerAdapter(['dp-loopback'], adapter);
    const signal = new AbortController();
    let releasePort;
    const run = (async () => {
      await ctx.loader.await();
      await ctx.dshBots.waitUntilReady();
      const deadline = Date.now() + 20000;
      while ((await ctx.get('dshBotProactive')?.status())?.state !== 'ready') {
        assert.ok(Date.now() < deadline, 'coordinator readiness');
        await delay(50, undefined, { signal: signal.signal });
      }
      const service = ctx.get('dshBotProactive');
      const bot = (await ctx.dshBots.list()).find(row => row.id === 'fixture-ci') ??
        await ctx.dshBots.create({ id: 'fixture-ci', name: 'Fixture CI', template: 'minimal' });
      while (!ctx.get('dshBotNotifications')) {
        assert.ok(Date.now() < deadline, 'notifications readiness');
        await delay(50, undefined, { signal: signal.signal });
      }
      const notices = ctx.get('dshBotNotifications');
      if (notices && !notices.policies().some(policy => policy.id === 'workflow-notice')) {
        await notices.savePolicy({
          id: 'workflow-notice', owner: { botId: bot.id, botCreatedAt: bot.createdAt },
          channel: 'in-app', enabled: true, timezone: 'UTC', dailyLimit: 5, cooldownSec: 0, authorization: { mode: 'ask' },
        }, 0, true);
      }
      if (config.suite.startsWith('proactive-notice')) {
        const describe = async ref => {
          assert.equal(ref, 'fixture-target');
          const label = await readFile(join(config.outputDir, 'notice-target.txt'), 'utf8').catch(() => 'Fixture target');
          return { targetDigest: 'fixture-target-v1', label };
        };
        releasePort = notices.attachPort({
          describe,
          async send({ signal, targetRef, targetDigest, text, attemptId }) {
            signal.throwIfAborted();
            assert.equal((await describe(targetRef)).targetDigest, targetDigest);
            await appendFile(join(config.outputDir, 'notice-transports.ndjson'), `${JSON.stringify({ targetRef, text, attemptId })}\n`);
            return config.suite === 'proactive-notice-unknown'
              ? { state: 'unknown' } : { state: 'accepted', platformMessageId: 'fixture-receipt' };
          },
        }, ctx);
        if (!notices.policies().some(policy => policy.id === 'workflow-external')) {
          await notices.savePolicy({
            id: 'workflow-external', owner: { botId: bot.id, botCreatedAt: bot.createdAt },
            channel: 'im', enabled: true, timezone: 'UTC', targetRef: 'fixture-target',
            dailyLimit: 5, cooldownSec: 0, authorization: { mode: 'ask' },
          }, 0, true);
        }
      }
      let groups, groupKey;
      if (config.suite.startsWith('proactive-group')) {
        groups = ctx.get('dshBotGroups');
        while (!groups) {
          assert.ok(Date.now() < deadline, 'group readiness');
          await delay(50, undefined, { signal: signal.signal });
          groups = ctx.get('dshBotGroups');
        }
        const reviewer = (await ctx.dshBots.list()).find(row => row.id === 'fixture-reviewer') ??
          await ctx.dshBots.create({ id: 'fixture-reviewer', name: 'Fixture Reviewer', template: 'minimal' });
        const existing = (await groups.list()).find(row => ['Fixture reviewers', 'Updated reviewers'].includes(row.group.name))?.group;
        const group = existing ?? await groups.create({
          operationId: 'proactive-workflow-reviewers', name: 'Fixture reviewers', mode: 'natural', historyConfirmed: true,
          members: [{ botId: bot.id, botCreatedAt: bot.createdAt }, { botId: reviewer.id, botCreatedAt: reviewer.createdAt }],
        });
        groupKey = { groupId: group.id, groupCreatedAt: group.createdAt };
      }
      const scope = { repository: 'fixture/demo', branch: 'main', generation: 1 };
      if (config.suite !== "proactive-repair" && !(await service.ciCheckpoint(scope))) {
        const now = new Date().toISOString();
        const ingested = await service.observeCi(randomUUID(), scope, {
          complete: true, before: null, after: 'workflow-v1',
          rows: ['accept-case', 'observe-case', 'dismiss-case'].map((job, i) => ({
            repository: scope.repository, branch: scope.branch, job, runId: String(i + 1), commit: 'b'.repeat(40),
            observedAt: now, attempt: 1, conclusion: 'failure',
          })),
        });
        assert.equal(ingested.kind, 'receipt');
      }
      if (['proactive-workspace','proactive-group-workspace'].includes(config.suite)) {
        const result = await (config.suite==='proactive-group-workspace'?runGroupRepairFixture:runWorkspaceFixture)(ctx, service, bot, adapter, config, signal.signal);
        await writeFile(join(config.outputDir, 'workspace-result.json'), JSON.stringify(result,null,2));
        console.log('B4_WEB_READY');
        return;
      }
      if (config.suite === 'proactive-deferred-notices') {
        console.log('B4_WEB_READY');
        await runDeferredNoticesFixture(ctx, service, bot, adapter, config, signal.signal);
        return;
      }
      if (['proactive-governance','proactive-responsibilities'].includes(config.suite)) {
        console.log('B4_WEB_READY');
        await (config.suite==='proactive-governance'?runGovernanceFixture:runResponsibilityFixture)(ctx,service,bot,adapter,config,signal.signal);
        return;
      }
      await writeFile(join(config.outputDir, 'workflow-ready.json'), JSON.stringify({ id: bot.id, pid: process.pid }));
      console.log('B4_WEB_READY');
      while (!signal.signal.aborted) {
        const work = await service.workList();
        const checked = [];
        for (const row of work) {
          if (!row.evidence || !row.sessionId) continue;
          const result = await ctx.sessionController.inspect(row.sessionId);
          const user = result.events.find(event => event.type === 'user/message' && event.data.id === row.evidence.inputId);
          assert.equal(user?.data.source.kind, 'dsh-bot-proactive-ci');
          assert.equal(user?.data.source.assignmentId, row.assignmentId);
          const assistant = result.events.find(event => event.type === 'assistant/message' && event.data.message.id === row.evidence.assistantId);
          assert.ok(assistant);
          checked.push(row);
        }
        let groupResult, groupFollowUpResult;
        if (groups && groupKey) {
          const change = join(config.outputDir, 'replace-reviewer');
          const replace = await readFile(change, 'utf8').catch(() => '');
          if (replace) {
            const view = await groups.view(groupKey);
            const next = (await ctx.dshBots.list()).find(row => row.id === 'replacement-reviewer') ??
              await ctx.dshBots.create({ id: 'replacement-reviewer', name: 'Replacement Reviewer', template: 'minimal' });
            await groups.edit(groupKey, {
              expectedRevision: view.group.revision, expectedMembershipRevision: view.group.membershipRevision,
              name: 'Updated reviewers', mode: view.group.mode, historyConfirmed: true,
              members: [{ botId: bot.id, botCreatedAt: bot.createdAt }, { botId: next.id, botCreatedAt: next.createdAt }],
            });
            await unlink(change);
            await writeFile(join(config.outputDir, 'reviewer-replaced'), 'ready');
          }
          const view = await groups.view(groupKey);
          const readTurn = async turn => {
            if (!turn) return;
            const deliveries = view.deliveries.filter(row => row.turnId === turn.id);
            const childSources = [];
            for (const delivery of deliveries) {
              if (delivery.state !== 'completed' || !delivery.childSessionId) continue;
              const child = await ctx.sessionController.inspect(delivery.childSessionId);
              const input = child.events.find(event => event.type === 'user/message' && event.data.id === delivery.childMessageId);
              assert.equal(input?.data.source.kind, 'dsh-bot-group-proactive');
              assert.equal(input.data.source.ticketId, turn.proactive.ticketId);
              assert.equal(input.data.source.assignmentId, turn.proactive.assignmentId);
              assert.equal(child.meta.parentSession, view.group.rootSessionId);
              if (turn.proactive.followUp) {
                assert.equal(input.data.source.factId, turn.proactive.followUp.factId);
                assert.equal(input.data.source.predecessorTurnId, turn.proactive.followUp.predecessorTurnId);
                assert.deepEqual(child.events.filter(event => event.type === 'user/message' &&
                  event.data.source.kind !== 'runtime-context').map(event => event.data.id), [delivery.childMessageId]);
              }
              childSources.push(input.data.source.kind);
            }
            return { turn, deliveries, childSources, rootSessionId: view.group.rootSessionId };
          };
          groupResult = await readTurn(view.turns.find(row => row.proactive && !row.proactive.followUp));
          groupFollowUpResult = await readTurn(view.turns.find(row => row.proactive?.followUp));
        }
        const ciCheckpoint = ['proactive-repair', 'proactive-group-artifact'].includes(config.suite) || config.suite.startsWith('proactive-group-follow-up')
          ? await service.ciCheckpoint(scope) : undefined;
        await writeFile(join(config.outputDir, 'workflow-evidence.json'), JSON.stringify({ calls: adapter.count, checked, work, status: await service.status(), groupResult, groupFollowUpResult, ciCheckpoint, notices: notices?.list().map(row => ({ operationId: row.operationId, kind: row.source.kind })) }));
        await delay(150, undefined, { signal: signal.signal });
      }
    })().catch(async error => {
      if (signal.signal.aborted) return;
      await writeFile(join(config.outputDir, 'workflow-error.txt'), String(error.stack ?? error));
      console.error('B4_WEB_FAILED');
    });
    return async () => { signal.abort(); await run; releasePort?.(); release(); };
  });
}
