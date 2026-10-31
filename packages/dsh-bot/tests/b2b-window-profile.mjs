// Test-only physical crash windows on the installed production transport.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'b2b-window-fixture';
export const inject = ['loader', 'dshBots', 'dshBotAutomation', 'sessionController', 'sessions', 'agents', 'approval'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let stopping = false;
    const offs = [];
    const run = (async () => {
      await ctx.loader.await();
      const wait = async (fn) => { const end = Date.now() + 45000; while (!stopping && Date.now() < end) { const v = await fn(); if (v) return v; await delay(20); } throw Error(`Window deadline ${config.window}`); };
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const service = ctx.get('dshBotMessaging'); assert.ok(service);
      const first = config.phase === 'first';
      if (first) for (const id of ['alpha', 'beta', 'gamma']) await ctx.dshBots.create({ id, name: id, template: 'minimal', persona: { prefix: `B2B_PERSONA_${id}` } });
      const mains = await Promise.all(['alpha', 'beta', 'gamma'].map((id) => ctx.dshBots.openConversation(id)));
      const agents = await Promise.all(mains.map(async (m) => { const r = await ctx.sessionController.resolveAgent(m.sessionId); if ('error' in r) throw r.error; return r.agent; }));
      const [alpha, beta] = agents;
      offs.push(ctx.on('approval/request', async () => 'allowed-once', { prepend: true }));
      const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
      const prompt = async (a, text) => { a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await a.whenIdle(); assert.equal(await ctx.sessions.flush(a.session), true); };
      const pause = () => new Promise(() => {});
      let marked = false;
      const mark = async (row, extra = {}) => {
        if (marked) return; marked = true;
        await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify({ mains, row, ...extra }));
        await save('window', { status: 'PASS', window: config.window, row, ...extra });
        console.log('B2B_DONE');
      };
      if (first) {
        for (const a of agents) await prompt(a, 'B2B_INITIAL_TURN');
        if (config.window === 'wake-only') {
          void beta.runMaintenance((signal) => new Promise((accept) => signal.addEventListener('abort', accept, { once: true })));
          const wake = createUserMessage({ source: { kind: 'dsh-bot-message-wake', form: 'notice', summary: 'Test stale wake', messageId: 'no-business', generation: 'old-generation', toSessionId: beta.session.id }, content: [{ type: 'text', text: 'B2B_WAKE_CONTROL_MUST_NOT_REACH_MODEL' }] });
          beta.followup(wake); assert.equal(await ctx.sessions.flush(beta.session), true); await mark(undefined, { wake }); return;
        }
        if (['outbox', 'reply-accepted'].includes(config.window)) {
          const accept = service.store.accept.bind(service.store);
          service.store.accept = async (value) => {
            const row = await accept(value);
            if (config.window === 'outbox' || row.envelope.mode === 'reply') { await mark(row); await pause(); }
            return row;
          };
        }
        if (['pending', 'send-flush', 'flush-false', 'canceled'].includes(config.window))
          void beta.runMaintenance((signal) => new Promise((accept) => signal.addEventListener('abort', accept, { once: true })));
        if (['send-flush', 'flush-false'].includes(config.window)) {
          let sent = false;
          const followup = beta.followup.bind(beta); beta.followup = (input) => { sent = true; return followup(input); };
          const flush = ctx.sessions.flush.bind(ctx.sessions);
          ctx.sessions.flush = async (session) => {
            if (sent && session.id === beta.session.id) {
              if (config.window === 'flush-false') return false;
              await mark(service.store.rows()[0]); await pause();
            }
            return flush(session);
          };
        }
        if (['flush-false', 'store-failure'].includes(config.window)) {
          const update = service.store.update.bind(service.store);
          service.store.update = async (...args) => {
            const row = await update(...args);
            if (row.delivery === 'unknown') { await mark(row, { injectedFailure: config.window }); await pause(); }
            return row;
          };
        }
        if (config.window === 'store-failure') {
          const table = service.store.domain.table('messages'), put = table.put.bind(table); let failed = false;
          table.put = async (id, row) => {
            if (!failed && row.delivery === 'delivering') { failed = true; throw Error('Injected message KvTable write rejection'); }
            return put(id, row);
          };
        }
        await fetch(`${config.mockUrl}/control`, { method: 'POST', body: JSON.stringify([{ route: config.window === 'claimed' ? 'window-claim' : ['reply-accepted', 'outbox'].includes(config.window) ? 'window-reply' : 'window-notify' }]) });
        void prompt(alpha, 'B2B_ROOT_CRASH_WINDOW');
        if (['outbox', 'send-flush', 'reply-accepted', 'flush-false', 'store-failure'].includes(config.window)) { await wait(() => marked); return; }
        const row = await wait(() => service.store.rows()[0]);
        if (config.window === 'claimed') {
          await wait(() => beta.session.snapshotEvents().some((e) => e.type === 'user/message' && e.data.id === row.nativeInput.id));
          assert.equal(await ctx.sessions.flush(beta.session), true); await mark(service.store.get(row.envelope.id));
        } else {
          await wait(() => service.store.get(row.envelope.id)?.delivery === 'delivered');
          await service.settled(); assert.ok(beta.inbox.nextTurn.some((m) => m.id === row.nativeInput.id));
          if (config.window === 'canceled') { assert.equal(beta.inbox.remove(row.nativeInput.id), true); assert.equal(await ctx.sessions.flush(beta.session), true); }
          await mark(service.store.get(row.envelope.id));
        }
      } else {
        const identity = JSON.parse(await readFile(resolve(config.outputDir, 'identity.json'))); assert.deepEqual(mains, identity.mains);
        if (config.window === 'wake-only') {
          beta.send(createUserMessage({ source: { ...identity.wake.source, generation: 'new-generation' }, content: identity.wake.content }), 'next-step', true);
          await beta.whenIdle(); assert.equal(await ctx.sessions.flush(beta.session), true);
          const stats = await (await fetch(`${config.mockUrl}/stats`)).json();
          assert.equal(stats.length, 3, 'Old and new wake controls cannot initiate a model request');
          assert.ok(!JSON.stringify(stats).includes('B2B_WAKE_CONTROL_MUST_NOT_REACH_MODEL'));
          await save('recovery', { status: 'PASS', staleWakeFiltered: true, noModelRequest: true });
        } else {
          const id = identity.row.envelope.id;
          await service.settled();
          await save('observed', { row: service.store.get(id), events: agents.flatMap(a => a.session.snapshotEvents()) });
          if (config.window === 'claimed') await wait(() => service.store.get(id)?.processing === 'unknown');
          else if (config.window === 'canceled') await wait(() => service.store.get(id)?.delivery === 'canceled');
          else await wait(() => service.store.get(id)?.processing === 'completed' || service.store.get(id)?.delivery === 'unknown');
          await service.settled(); await Promise.all(agents.map((a) => a.whenIdle()));
          const row = service.store.get(id); assert.ok(row); assert.equal(row.nativeInput.id, identity.row.nativeInput.id);
          const recipient = agents.find((a) => a.session.id === row.envelope.toSessionId);
          const count = recipient.session.snapshotEvents().filter((e) => e.type === 'user/message' && e.data.id === row.nativeInput.id).length;
          assert.ok(count <= 1);
          if (config.window === 'claimed') assert.equal(row.processing, 'unknown');
          if (config.window === 'canceled') assert.equal(count, 0);
          if (config.window === 'outbox') {
            assert.equal(row.response, 'replied');
            const reply = service.store.rows().find(r => r.envelope.replyTo === id); assert.ok(reply);
            assert.equal(reply.envelope.toSessionId, alpha.session.id);
          }
          if (config.window === 'reply-accepted') assert.equal(row.envelope.toSessionId, alpha.session.id);
          await save('recovery', { status: 'PASS', window: config.window, nativeOccurrences: count, row, noBusinessReplay: true });
        }
        await service.close(); await save('lifecycle', service.lifecycle());
        console.log('B2B_DONE');
      }
    })().catch(async (e) => { await writeFile(resolve(config.outputDir, `${config.phase}-failure.json`), JSON.stringify({ error: String(e), stack: e.stack })); console.log('B2B_FAILED'); });
    return async () => { stopping = true; for (const off of offs) off(); await run; };
  });
}
