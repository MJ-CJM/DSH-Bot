import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Messaging, messagingDomain } from '../lib/host/messaging/service.js';
import { MessageStore } from '../lib/host/messaging/store.js';
import { MessagingConfig } from '../lib/host/messaging/config.js';
import { messageEvidence } from '../lib/host/messaging/evidence.js';
export const name = 'b2b-host-probe';
export const inject = [
  'loader',
  'dshBots',
  'dshBotAutomation',
  'sessionController',
  'sessions',
  'sessionPersistence',
  'agents',
  'storageDomain',
  'workspaceRegistry',
];
export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(),
      offs = [];
    let messaging;
    const save = (name, data) =>
      writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(data, null, 2));
    const wait = async (fn) => {
      const end = Date.now() + 50000;
      while (Date.now() < end && !abort.signal.aborted) {
        const v = await fn();
        if (v) return v;
        await delay(20);
      }
      throw Error('Host probe timeout');
    };
    const run = (async () => {
      await ctx.loader.await();
      await wait(async () => (await ctx.dshBotAutomation.status()).state === 'ready');
      const first = config.phase === 'first';
      if (first)
        for (const id of ['alpha', 'beta', 'gamma'])
          await ctx.dshBots.create({
            id,
            name: id,
            template: 'minimal',
            persona: { prefix: `B2B_PERSONA_${id}` },
            memory: { enabled: true, injectLimit: 20 },
          });
      if (first)
        for (const id of ['alpha', 'beta'])
          await ctx.dshBots.memoryFor(id).save({
            kind: 'fact',
            content: `B2B_PRIVATE_MEMORY_${id}`,
            tags: [],
            pinned: true,
          });
      const mains = await Promise.all(
        ['alpha', 'beta', 'gamma'].map((id) => ctx.dshBots.openConversation(id)),
      );
      const agents = await Promise.all(
        mains.map(async (m) => {
          const r = await ctx.sessionController.resolveAgent(m.sessionId);
          if ('error' in r) throw r.error;
          return r.agent;
        }),
      );
      const [alpha, beta] = agents;
      if (first) {
        for (const a of agents) {
          a.followup(
            createUserMessage({
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'B2B_INITIAL_TURN' }],
            }),
          );
          await a.whenIdle();
          assert.equal(await ctx.sessions.flush(a.session), true);
        }
      }
      const before = (await ctx.sessionController.list({}, abort.signal)).items;
      assert.equal(before.length, 3);
      assert.ok(before.every((s) => s.blank === false));
      const workspace = ctx.workspaceRegistry
        .list()
        .find((w) => mains.every((m) => w.sessionIds.includes(m.sessionId)));
      assert.ok(workspace);
      assert.deepEqual([...workspace.sessionIds].sort(), mains.map((m) => m.sessionId).sort());
      const domain = await ctx.storageDomain.open(messagingDomain);
      const store = new MessageStore(domain, MessagingConfig({ messagingEnabled: true }));
      messaging = new Messaging(
        ctx,
        ctx.dshBots,
        store,
        {
          async approve() {
            return 'b2b-fixture-approved-synthetic-transport-only';
          },
        },
        { coldWake: true, interrupt: true, processing: true },
      );
      await messaging.start();
      if (first) {
        const calls = [];
        for (const a of [alpha, beta])
          offs.push(
            a.ctx.tools.register(
              defineTool({
                name: 'bot_message',
                description:
                  'Loopback-only B03 transport probe; B04 owns production approvals and source guard.',
                parameters: {
                  action: { type: 'string', required: true },
                  to: { type: 'string' },
                  content: { type: 'string', required: true },
                  mode: { type: 'string' },
                  replyTo: { type: 'string' },
                },
                output: {
                  schema: { type: 'object', additionalProperties: true },
                  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
                },
                async execute(args, exec) {
                  const turn = a.session.snapshotEvents().findLast((e) => e.type === 'step/start')?.seq;
                  const accepted = await messaging.send(
                    a,
                    args,
                    JSON.stringify([turn, exec.rootCallId, exec.callId]),
                  );
                  calls.push({
                    owner: a.session.id,
                    accepted,
                    at: Date.now(),
                    targetCompleted: beta.session
                      .snapshotEvents()
                      .some(
                        (e) =>
                          e.type === 'assistant/message' && JSON.stringify(e.data).includes('B2B_B_REPLIED'),
                      ),
                  });
                  return accepted;
                },
              }),
            ),
          );
        await fetch(`${config.mockUrl}/control`, {
          method: 'POST',
          body: JSON.stringify([{ route: true }]),
        });
        alpha.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'B2B_ROOT_REQUEST Please ask beta.' }],
          }),
        );
        await wait(() =>
          alpha.session
            .snapshotEvents()
            .some(
              (e) => e.type === 'assistant/message' && JSON.stringify(e.data).includes('B2B_A_TOLD_USER'),
            ),
        );
        await Promise.all(agents.map((a) => a.whenIdle()));
        await messaging.settled();
        const rows = store.rows();
        assert.equal(rows.length, 2);
        const ask = rows.find((r) => r.envelope.mode === 'ask'),
          reply = rows.find((r) => r.envelope.mode === 'reply');
        assert.ok(ask && reply);
        assert.equal(ask.response, 'replied');
        assert.equal(reply.envelope.replyTo, ask.envelope.id);
        assert.equal(reply.envelope.toSessionId, alpha.session.id);
        assert.ok(calls[0].targetCompleted === false);
        for (const row of rows) {
          assert.equal(row.delivery, 'delivered');
          assert.equal(row.processing, 'completed');
          assert.ok(row.nativeRef && row.outgoingRef);
          const handle = await ctx.sessionPersistence.open(row.envelope.toSessionId, 'read');
          let ev;
          try {
            ev = (await handle.read()).events;
          } finally {
            await handle.close();
          }
          const evidence = messageEvidence(row, ev);
          assert.equal(evidence.ended, true);
          assert.equal(
            ev.filter((e) => e.type === 'user/message' && e.data.id === row.nativeInput.id).length,
            1,
          );
        }
        const countBefore = store.rows().length;
        await assert.rejects(() =>
          messaging.send(
            alpha,
            {
              action: 'send',
              to: 'beta',
              content: 'forbidden new root',
              mode: 'ask',
            },
            'new-root-after-reply',
          ),
        );
        assert.equal(store.rows().length, countBefore);
        await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify({ mains, rows }));
        await save('roundtrip', {
          status: 'PASS',
          calls,
          rows,
          queuedBeforePeerFinished: true,
          realAssistantToldUser: true,
        });
      } else {
        const identity = JSON.parse(await readFile(resolve(config.outputDir, 'identity.json')));
        assert.deepEqual(mains, identity.mains);
        await messaging.settled();
        await wait(() =>
          beta.session
            .snapshotEvents()
            .some((e) => e.type === 'user/message' && e.data.id === identity.pending.nativeInput.id),
        );
        await beta.whenIdle();
        await messaging.settled();
        const rows = store.rows();
        assert.equal(rows.length, identity.rows.length + 1);
        assert.deepEqual(
          rows.filter((r) => r.envelope.id !== identity.pending.envelope.id).map((r) => r.nativeInput.id),
          identity.rows.map((r) => r.nativeInput.id),
        );
        assert.ok(rows.every((r) => r.delivery === 'delivered' && r.processing === 'completed'));
        assert.equal(
          beta.session
            .snapshotEvents()
            .filter((e) => e.type === 'user/message' && e.data.id === identity.pending.nativeInput.id).length,
          1,
        );
        await save('recovery', {
          status: 'PASS',
          noReplayedMessages: true,
          durablePendingAwakenedOnce: true,
          rows,
        });
      }
      if (first) {
        await fetch(`${config.mockUrl}/control`, {
          method: 'POST',
          body: JSON.stringify([{ route: false, stall: true }]),
        });
        beta.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'B2B_STALL_TARGET' }],
          }),
        );
        await wait(async () => {
          const stats = await (await fetch(`${config.mockUrl}/stats`)).json();
          return stats.at(-1)?.action.stall;
        });
        const human = createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'B2B_PRESERVED_NATIVE_HUMAN' }],
        });
        beta.send(human, 'next-turn', false);
        alpha.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'B2B_HUMAN_AUTHORIZES_INTERRUPT_FIXTURE' }],
          }),
        );
        await alpha.whenIdle();
        const interrupt = await messaging.send(
          alpha,
          {
            action: 'send',
            to: 'beta',
            content: 'B2B_INTERRUPT_NOTIFY',
            mode: 'notify',
            priority: 'interrupt',
          },
          'actual-interrupt',
        );
        await beta.whenIdle();
        await messaging.settled();
        await wait(() => store.get(interrupt.messageId)?.interrupt === 'stopped');
        assert.ok(
          beta.session.snapshotEvents().some((e) => e.type === 'user/message' && e.data.id === human.id),
        );
        const stats = await (await fetch(`${config.mockUrl}/stats`)).json();
        assert.ok(stats.some((r) => r.action.stall && r.outcome === 'aborted'));
        await save('interrupt', {
          status: 'PASS',
          record: store.get(interrupt.messageId),
          humanPreserved: true,
          mockRequestObservedAbort: true,
        });
        await writeFile(
          resolve(config.outputDir, 'identity.json'),
          JSON.stringify({ mains, rows: store.rows() }),
        );
      }
      const after = (await ctx.sessionController.list({}, abort.signal)).items;
      assert.deepEqual(after.map((s) => s.sessionId).sort(), before.map((s) => s.sessionId).sort());
      assert.deepEqual([...workspace.sessionIds].sort(), mains.map((m) => m.sessionId).sort());
      await messaging.close();
      assert.deepEqual(messaging.lifecycle(), {
        phase: 'closed',
        tasks: 0,
        timers: 0,
        wakes: 0,
        targets: 0,
        ownedAgentHandles: 0,
      });
      assert.ok(agents.every((a) => ctx.agents.get(a.session.id) === a));
      await save('lifecycle', {
        status: 'PASS',
        ...messaging.lifecycle(),
        nativeAgentsRetained: true,
        noAdditionalSessions: true,
      });
      if (first) {
        const nextDomain = await ctx.storageDomain.open(messagingDomain);
        const nextStore = new MessageStore(nextDomain, MessagingConfig({ messagingEnabled: true }));
        messaging = new Messaging(
          ctx,
          ctx.dshBots,
          nextStore,
          {
            async approve() {
              return 'b2b-fixture-approved-cold-notify';
            },
          },
          { coldWake: true, interrupt: true, processing: true },
        );
        await messaging.start();
        await messaging.settled();
        alpha.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'B2B_INDEPENDENT_HUMAN_REQUEST' }],
          }),
        );
        await alpha.whenIdle();
        // Own native maintenance keeps the new input pending without a model request. The runner SIGKILLs only this Host.
        void beta.runMaintenance(
          (signal) =>
            new Promise((accept) => signal.addEventListener('abort', () => accept(), { once: true })),
        );
        const pendingReceipt = await messaging.send(
          alpha,
          {
            action: 'send',
            to: 'beta',
            content: 'B2B_COLD_PENDING_NOTIFY',
            mode: 'notify',
          },
          'cold-notify',
        );
        await messaging.settled();
        const pending = nextStore.get(pendingReceipt.messageId);
        assert.ok(pending && beta.inbox.nextTurn.some((m) => m.id === pending.nativeInput.id));
        assert.equal(await ctx.sessions.flush(beta.session), true);
        const identity = JSON.parse(await readFile(resolve(config.outputDir, 'identity.json')));
        await writeFile(resolve(config.outputDir, 'identity.json'), JSON.stringify({ ...identity, pending }));
        await save('pending-before-kill', { status: 'PASS', pending });
      }
      await save('result', { status: 'PASS' });
      console.log('B2B_DONE');
    })().catch(async (error) => {
      await save('failure', { error: String(error), stack: error.stack });
      console.log('B2B_FAILED');
    });
    return async () => {
      abort.abort();
      await run;
      for (const off of offs.reverse()) off();
      await messaging?.close();
      await save('disposed', { status: 'PASS' });
    };
  });
}
