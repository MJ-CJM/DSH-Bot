import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage as nativeUserMessage } from '@deepseek-ai/dsh-llm';
const createUserMessage = (content, source) => nativeUserMessage({ content, source });
import { Peer } from '@deepseek-ai/dsh-client-connection';
export const name = 'b2b-spike';
export const inject = [
  'loader',
  'dshBots',
  'dshBotAutomation',
  'sessionController',
  'sessions',
  'sessionPersistence',
  'typertGateway',
];
export function apply(ctx, config) {
  ctx.effect(() => {
    let peer;
    const offs = [];
    const controller = new AbortController();
    const save = (name, data) =>
      writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(data, null, 2));
    const wait = async (fn) => {
      const end = Date.now() + 45000;
      while (Date.now() < end && !controller.signal.aborted) {
        const v = await fn();
        if (v) return v;
        await delay(20);
      }
      throw Error('Probe timeout');
    };
    const control = (actions) =>
      fetch(`${config.mockUrl}/control`, {
        method: 'POST',
        body: JSON.stringify(actions),
      });
    const run = (async () => {
      await ctx.loader.await();
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      if (config.phase === 'first')
        for (const id of ['alpha', 'beta'])
          await ctx.dshBots.create({
            id,
            name: id,
            template: 'minimal',
            persona: { prefix: `B2B_PERSONA_${id}`, complete: true },
            memory: { enabled: false, injectLimit: 20 },
          });
      const a = await ctx.dshBots.openConversation('alpha'),
        b = await ctx.dshBots.openConversation('beta');
      const alpha = (await ctx.sessionController.resolveAgent(a.sessionId)).agent,
        beta = (await ctx.sessionController.resolveAgent(b.sessionId)).agent;
      assert.ok(alpha && beta);
      peer = new Peer(ctx, {
        principal: { kind: 'owner' },
        interactions: 'none',
      });
      if (config.phase === 'first') {
        const source = {
          kind: 'dsh-bot-message',
          form: 'relay',
          messageId: 'spike-message',
          threadId: 'spike-thread',
          from: { botId: 'alpha', botCreatedAt: 1 },
          to: { botId: 'beta', botCreatedAt: 1 },
          hop: 1,
          mode: 'ask',
          priority: 'normal',
          displaySnapshots: { from: 'alpha', to: 'beta' },
        };
        const input = createUserMessage([{ type: 'text', text: 'B2B_PENDING_BODY' }], source);
        beta.send(input, 'next-turn', false);
        assert.equal(beta.status, 'idle');
        assert.equal(beta.inbox.nextTurn.length, 1);
        assert.equal(await ctx.sessions.flush(beta.session), true);
        const handle = await ctx.sessionPersistence.open(b.sessionId, 'read');
        let events;
        try {
          events = (await handle.read()).events;
        } finally {
          await handle.close();
        }
        assert.deepEqual(
          events
            .find((e) => e.type === 'agent/inbox/spliced' && e.data.inserted.some((m) => m.id === input.id))
            .data.inserted.find((m) => m.id === input.id).source,
          source,
        );
        const page = await ctx.typertGateway.invoke({
          namespace: 'session',
          method: 'page',
          args: {
            request: {
              address: { kind: 'session', sessionId: b.sessionId },
              throughSeq: Number(beta.session.seq) - 1,
            },
          },
          peer,
          signal: controller.signal,
        });
        assert.ok(JSON.stringify(page).includes('spike-message'), 'source survives native Gateway page');
        await writeFile(resolve(config.outputDir, 'seed.json'), JSON.stringify({ a, b, input }));
        await save('pending', {
          status: 'PASS',
          inputId: input.id,
          pending: beta.inbox.nextTurn.length,
          sourcePersistence: true,
          sourceGateway: true,
        });
      } else {
        const seed = JSON.parse(await readFile(resolve(config.outputDir, 'seed.json')));
        assert.equal(b.sessionId, seed.b.sessionId);
        assert.equal(beta.status, 'idle');
        assert.equal(beta.inbox.nextTurn[0].id, seed.input.id);
        const token = createUserMessage([{ type: 'text', text: 'B2B_CONTROL_MUST_NOT_REACH_MODEL' }], {
          kind: 'dsh-bot-message-wake',
          form: 'notice',
          summary: 'resume',
        });
        offs.push(
          beta.ctx.on('agent/pre-step', async (_p, next) => {
            const d = await next();
            return d.kind === 'enter' ? { ...d, messages: d.messages.filter((m) => m.id !== token.id) } : d;
          }),
        );
        let directory = 'DIRECTORY_v1 {{literal}}';
        offs.push(beta.ctx.systemPrompt.suppressRuntimeContext());
        offs.push(
          beta.ctx.systemPrompt.context({
            name: 'b2b-spike-directory',
            order: 9000,
            required: true,
            interpolate: false,
            text: () => directory,
          }),
        );
        beta.send(token, 'next-step', true);
        await beta.whenIdle();
        assert.equal(await ctx.sessions.flush(beta.session), true);
        assert.equal(
          beta.session
            .snapshotEvents()
            .filter((e) => e.type === 'user/message' && e.data.id === seed.input.id).length,
          1,
        );
        let stats = await (await fetch(`${config.mockUrl}/stats`)).json();
        const wire = JSON.stringify(stats.at(-1).body);
        assert.ok(wire.includes('B2B_PENDING_BODY'));
        assert.ok(!wire.includes('B2B_CONTROL_MUST_NOT_REACH_MODEL'));
        assert.ok(wire.includes('DIRECTORY_v1 {{literal}}'));
        directory = 'DIRECTORY_v2';
        await control([{ stall: true }]);
        alpha.followup(
          createUserMessage([{ type: 'text', text: 'B2B_STALL' }], {
            kind: 'user',
          }),
        );
        await wait(async () => {
          const r = await (await fetch(`${config.mockUrl}/stats`)).json();
          return r.at(-1)?.action.stall;
        });
        const human = createUserMessage([{ type: 'text', text: 'B2B_HUMAN_PRESERVED' }], { kind: 'user' });
        alpha.send(human, 'next-turn', false);
        alpha.cancel({ kind: 'hook', reason: 'b2b-spike-interrupt' }, { keepInbox: true });
        alpha.followup(
          createUserMessage([{ type: 'text', text: 'B2B_PRIORITY' }], {
            kind: 'dsh-bot-message',
            form: 'relay',
          }),
        );
        await alpha.whenIdle();
        assert.equal(await ctx.sessions.flush(alpha.session), true);
        stats = await (await fetch(`${config.mockUrl}/stats`)).json();
        assert.ok(stats.some((r) => r.action.stall && r.outcome === 'aborted'));
        assert.ok(
          alpha.session.snapshotEvents().some((e) => e.type === 'user/message' && e.data.id === human.id),
        );
        assert.ok(
          alpha.session
            .snapshotEvents()
            .some((e) => e.type === 'turn/end' && JSON.stringify(e.data).includes('hook')),
        );
        beta.followup(
          createUserMessage([{ type: 'text', text: 'B2B_DIRECTORY_REFRESH' }], {
            kind: 'user',
          }),
        );
        await beta.whenIdle();
        stats = await (await fetch(`${config.mockUrl}/stats`)).json();
        assert.ok(JSON.stringify(stats.at(-1).body).includes('DIRECTORY_v2'));
        const ptc = Boolean(beta.ctx.tools.get('run_code', beta));
        await save('gates', {
          pendingWake: 'PASS',
          bodyCount: 1,
          cancelRequest: 'PASS',
          humanInboxPreserved: 'PASS',
          requiredCompleteContext: 'PASS',
          directoryRefresh: 'PASS',
          ptc: ptc ? 'present-unverified' : 'unavailable',
          ptcPolicy:
            'FAIL: propagation not established; disable bot_message in run_code and require native approval for run_code on teammate turns',
          exclusiveClient: 'NOT_RUN: separate client probe',
        });
      }
      await save('result', { status: 'PASS' });
      console.log('B2B_DONE');
    })().catch(async (error) => {
      await save('failure', { error: String(error), stack: error.stack });
      console.log('B2B_FAILED');
    });
    return async () => {
      controller.abort();
      await run;
      for (const off of offs.reverse()) off();
      await peer?.dispose();
      await save('disposed', { status: 'PASS' });
    };
  });
}
