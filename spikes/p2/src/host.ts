import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-subagent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { probeRules } from './rules.js';
import { acquireLock } from './lock.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 't11-report': { kind: 't11-report'; form: 'notice'; summary: string; sourceSessionId: SessionId } }
}

export const name = 't11-probes';
export const inject = ['loader', 'dshBots', 'sessionController', 'sessions', 'workspaceRegistry', 'agents', 'jobs', 'subagents'];
export interface Config { outputDir: string; phase: 'first' | 'cold'; baseURL: string; timeoutMs: number; timerMs: number }
export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().required(), phase: Schema.union(['first', 'cold']).default('first'),
  baseURL: Schema.string().required(), timeoutMs: Schema.number().min(1000).max(120000).default(45000),
  timerMs: Schema.number().min(5).max(1000).default(20),
});
interface Bots {
  ensureBotsWorkspace(): Promise<{ workspaceId: WorkspaceId; path: string }>;
  status(): Promise<{ id: string; presetId: string }[]>;
}
export function apply(ctx: Context, config: Config) {
  console.log('T11_ACTIVATED', config.phase);
  ctx.effect(() => {
    const abort = new AbortController();
    let started = false;
    const save = (name: string, value: unknown) => writeFile(resolve(config.outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
    const run = (async () => {
      await ctx.loader.await();
      started = true;
      if (abort.signal.aborted) return;
      assert.equal(new URL(config.baseURL).hostname, '127.0.0.1');
      const result: Record<string, unknown> = { phase: config.phase };
      async function check(label: string, work: () => Promise<unknown> | unknown) {
        try { result[label] = { status: 'PASS', evidence: await work() }; }
        catch (error) { result[label] = { status: 'FAIL', error: String(error), stack: error instanceof Error ? error.stack : undefined }; }
        await save(`${config.phase}.json`, result);
      }
      const deadline = <T>(work: Promise<T>) => {
        let timer: ReturnType<typeof setTimeout>;
        return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout')), config.timeoutMs); })])
          .finally(() => clearTimeout(timer));
      };
      const agentFor = async (id: SessionId) => {
        const resolved = await ctx.sessionController.resolveAgent(id);
        if ('error' in resolved) throw resolved.error;
        return resolved.agent;
      };
      const finish = async (agent: Agent) => {
        await deadline(agent.whenIdle());
        assert.equal(agent.status, 'idle');
        assert.equal(await ctx.sessions.flush(agent.session), true);
        await save(`${config.phase}-${agent.id}.json`, agent.session.snapshotEvents());
        return agent.session.snapshotEvents();
      };
      const linkedTurn = (agent: Agent, match: (message: ReturnType<typeof createUserMessage>) => boolean) => {
        const events = agent.session.snapshotEvents();
        const index = events.findIndex(event => event.type === 'user/message' && match(event.data));
        assert.ok(index >= 0, 'input committed to user/message');
        const start = events.slice(0, index).findLast(event => event.type === 'turn/start');
        assert.ok(start?.type === 'turn/start');
        const end = events.slice(index + 1).find(event => event.type === 'turn/end' && event.data.turn === start.data.turn);
        assert.ok(end?.type === 'turn/end');
        assert.equal(end.data.reason.kind, 'completed');
        assert.ok(events.slice(events.indexOf(start), events.indexOf(end)).some(event => event.type === 'step/start'), 'not an empty completed turn');
        return { input: events[index], start, end, status: agent.status };
      };
      const report = async (id: SessionId, sourceSessionId: SessionId, label: string) => {
        const agent = await agentFor(id);
        const before = agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length;
        const message = createUserMessage({ content: [{ type: 'text', text: `T11 ${label}: result from ${sourceSessionId}` }],
          source: { kind: 't11-report', form: 'notice', summary: label, sourceSessionId } });
        agent.followup(message);
        await finish(agent);
        const evidence = linkedTurn(agent, item => item.id === message.id);
        assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.id === message.id).length, 1);
        assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').length, before + 1);
        return { messageId: message.id, ...evidence };
      };
      await check('schedule-package-exports', probeRules);
      await check('host-lock', async () => {
        const path = resolve(config.outputDir, 'automation.lock');
        const owner = await acquireLock(path);
        assert.ok(owner);
        await ctx.effect(() => () => owner.release());
        assert.equal(await acquireLock(path), undefined);
        return owner.identity;
      });
      await check('timer-lifecycle', async () => {
        let ticks = 0; let lateCommits = 0; let lateSuppressed = 0; let cleanups = 0;
        for (let generation = 0; generation < 2; generation++) {
          let pending: Promise<void> = Promise.resolve();
          const fiber = ctx.plugin({ name: `t11-timer-${generation}`, apply(timerCtx: Context) {
            timerCtx.effect(() => {
              let active = true;
              const timer = setInterval(() => { if (active) ticks++; }, config.timerMs);
              pending = delay(config.timerMs * 4).then(() => { if (active) lateCommits++; else lateSuppressed++; });
              return async () => { active = false; clearInterval(timer); cleanups++; await pending; };
            });
          } });
          await delay(config.timerMs * 2);
          await fiber.dispose();
          const stopped = ticks;
          await delay(config.timerMs * 3);
          assert.equal(ticks, stopped);
        }
        assert.ok(ticks > 0); assert.equal(cleanups, 2); assert.equal(lateCommits, 0); assert.equal(lateSuppressed, 2);
        return { ticks, cleanups, lateCommits, lateSuppressed };
      });
      if (config.phase === 'cold') {
        const state = JSON.parse(await readFile(resolve(config.outputDir, 'state.json'), 'utf8')) as { origin: SessionId; target: SessionId; title: string };
        await check('cold-followup-once', async () => {
          assert.equal(ctx.agents.get(state.origin), undefined);
          const before = await ctx.sessionController.inspect(state.origin);
          assert.ok(before.events.some(e => e.type === 'turn/end'));
          const evidence = await report(state.origin, state.target, 'cold-report');
          return { absentBeforeResolve: true, ...evidence };
        });
        await check('title-persisted', async () => {
          const view = await ctx.sessionController.inspect(state.target);
          assert.ok(view.events.some(e => e.type === 'session/title' && e.data.title === state.title));
          return { title: state.title };
        });
      } else {
        let target: Agent | undefined; let origin: Agent | undefined;
        const bots = ctx.get('dshBots') as Bots;
        const statuses = await bots.status();
        const presetFor = (id: string) => { const status = statuses.find(row => row.id === id); assert.ok(status, `missing Bot ${id}`); return status.presetId; };
        await check('create-workspace-rename', async () => {
          const workspace = await bots.ensureBotsWorkspace();
          const presetId = presetFor('assistant');
          const created = await ctx.sessionController.create({ workspaceId: workspace.workspaceId, agentPreset: presetId });
          target = await agentFor(created.sessionId);
          const original = await ctx.sessionController.create({ workspaceId: workspace.workspaceId, agentPreset: presetFor('researcher') });
          origin = await agentFor(original.sessionId);
          const title = '[Routine] T11 · 2026-10-20 09:00 UTC';
          const renamed = await ctx.sessionController.rename({ sessionId: target.id, title });
          assert.equal(renamed.title, title);
          const inspection = await ctx.sessionController.inspect(target.id);
          assert.equal(inspection.meta.cwd, workspace.path);
          assert.equal(inspection.meta.agentPreset, presetId);
          const group = ctx.workspaceRegistry.get(workspace.workspaceId);
          assert.ok(group); assert.ok(group.sessionIds.includes(target.id)); assert.equal(group.title, 'Bots');
          await save('state.json', { origin: origin.id, target: target.id, title });
          return { created, workspace, presetId, renamed, group: { title: group.title, sessionIds: group.sessionIds } };
        });
        await check('request-turn-idle-jobs', async () => {
          assert.ok(target); assert.ok(origin);
          const targetId = target.id;
          const requestId = randomUUID() as SessionRequestId;
          const receipt = await ctx.sessionController.prompt({ sessionId: target.id, requestId, mode: 'queue', content: [{ type: 'text', text: 'T11 initial target' }] }, abort.signal);
          assert.equal(receipt.accepted, true);
          await finish(target);
          const linked = linkedTurn(target, item => item.source.kind === 'user' && 'rpcId' in item.source && item.source.rpcId === requestId);
          const repeat = await ctx.sessionController.prompt({ sessionId: target.id, requestId, mode: 'queue', content: [{ type: 'text', text: 'T11 initial target' }] }, abort.signal);
          await finish(target);
          assert.equal(target.session.snapshotEvents().filter(e => e.type === 'turn/end').length, 1);
          await ctx.effect(() => ctx.jobs.attachController('t11-observer'));
          let settle!: (value: JobOutcome) => void;
          let settleOther!: (value: JobOutcome) => void;
          const job = ctx.jobs.start({ owner: target.id, kind: 'bash', label: 't11 held job', run: () => ({ done: new Promise(resolve => { settle = resolve; }), cancel: () => settle({ status: 'killed' }) }) });
          const other = ctx.jobs.start({ kind: 'bash', label: 't11 unowned', run: () => ({ done: new Promise(resolve => { settleOther = resolve; }), cancel: () => settleOther({ status: 'killed' }) }) });
          await ctx.effect(() => () => { settle({ status: 'killed' }); settleOther({ status: 'killed' }); });
          const listed = ctx.jobs.list(target.id);
          assert.ok(listed.some(row => row.id === other));
          const owned = listed.filter(row => row.owner === targetId);
          assert.deepEqual(owned.map(row => row.id), [job]);
          assert.equal(owned[0]?.status, 'running');
          assert.equal(ctx.jobs.list(origin.id).some(row => row.id === job), false);
          // Await settlement before resolving the producer, suppressing native unsolicited job reports.
          const joined = ctx.jobs.wait(job, config.timeoutMs, target.id, abort.signal);
          settle({ status: 'completed', result: 'T11 job done' });
          assert.equal((await joined).status, 'completed');
          const unownedJoined = ctx.jobs.wait(other, config.timeoutMs, undefined, abort.signal);
          settleOther({ status: 'completed' }); await unownedJoined;
          await finish(target);
          assert.equal(ctx.jobs.list(target.id).filter(row => row.owner === targetId && ['running', 'stopping'].includes(row.status)).length, 0);
          return { requestId, receipt, repeat, linked, listed, ownerFilterRequired: true, terminal: ctx.jobs.get(job, target.id) };
        });
        await check('subagent-owner-query', async () => {
          assert.ok(target); assert.ok(origin);
          const activation = await ctx.subagents.startActivation({ provider: 'spawn', label: 'T11 delayed child', delivery: 'caller', signal: abort.signal,
            request: { parent: target, agentPreset: presetFor('researcher'), prompt: [{ type: 'text', text: 'T11 child' }], maxDepth: 1 } });
          await ctx.effect(() => () => activation.dispose());
          const children = await ctx.subagents.listChildren(target.id);
          const descendants = await ctx.subagents.listDescendants(target.id);
          assert.ok(children.some(child => child.id === activation.childId));
          assert.ok(descendants.some(row => row.kind === 'child' && row.id === activation.childId && row.activity === 'running'));
          assert.equal((await ctx.subagents.listChildren(origin.id)).length, 0);
          const child = ctx.agents.get(activation.childId);
          assert.ok(child); assert.equal(child.status, 'running');
          const joined = await deadline(ctx.subagents.waitForChildren(target));
          const outcome = await deadline(activation.result);
          assert.equal(outcome.stopReason, 'completed');
          await finish(target);
          const afterDescendants = await ctx.subagents.listDescendants(target.id);
          assert.equal(afterDescendants.some(row => row.kind === 'child' && row.activity === 'running'), false);
          assert.equal(target.inbox.nextTurn.length + target.inbox.nextStep.length, 0);
          return { afterDescendants, children, descendants, observedRunning: true, joined, outcome, after: await ctx.subagents.listChildren(target.id),
            childStatusAfter: ctx.agents.get(activation.childId)?.status };
        });
        await check('online-followup-once', async () => { assert.ok(target); assert.ok(origin); return report(origin.id, target.id, 'online-report'); });
      }
      const failed = Object.values(result).some(value => typeof value === 'object' && value !== null && 'status' in value && value.status === 'FAIL');
      console.log(failed ? 'T11_FAILED' : 'T11_DONE');
    })().catch(async error => { await save(`${config.phase}-fatal.json`, { error: String(error), stack: error instanceof Error ? error.stack : undefined }); console.log('T11_FAILED'); });
    return async () => { abort.abort(); if (started) await run; await save(`${config.phase}-disposed.json`, { disposed: true }); };
  });
}
