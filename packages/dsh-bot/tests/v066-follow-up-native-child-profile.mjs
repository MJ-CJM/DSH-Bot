import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { ReloadAdapter } from './v066-reload-profile.mjs';

export const inject = ['loader', 'llm', 'typertGateway', 'agentPresets', 'subagents', 'sessionController', 'sessionPersistence', 'sessions'];
const botId = 'native-child-owner';
const presetId = 'v066-native-child';
const route = { provider: 'dp-loopback', model: 'fixture' };
const nativeError = 'Synthetic native background task failure';

class ChildAdapter extends ReloadAdapter {
  controls = new Map();
  calls = [];
  async *stream(options) {
    const id = options.sessionId;
    const control = this.controls.get(id);
    this.calls.push(id);
    assert.ok(control, 'A model request reached an Agent outside the explicitly started children');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    control.release = release;
    options.signal?.addEventListener('abort', release, { once: true });
    try {
      if (!options.signal?.aborted) await gate;
      options.signal?.throwIfAborted();
      if (control.outcome === 'failed') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: nativeError, code: 'INVALID_REQUEST', status: 400 } } };
      } else yield* super.stream(options);
    } finally { options.signal?.removeEventListener('abort', release); }
  }
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const stop = new AbortController(), { signal } = stop;
    const adapter = new ChildAdapter(), releases = [];
    const stateFile = join(config.outputDir, 'product-native-child-warm.json');
    let peer;
    const save = (file, value) => writeFile(join(config.outputDir, file), JSON.stringify(value, null, 2));
    const wait = async check => {
      for (let i = 0; i < 300; i++) {
        const value = await check();
        if (value) return value;
        await delay(50, undefined, { signal });
      }
      throw new Error('Native child fixture timed out');
    };
    const native = async id => {
      const reader = await ctx.sessionPersistence.open(id, 'read', { signal });
      try {
        const page = await reader.read(Number(reader.inheritedEventCount), 128, { signal });
        assert.ok(page.events.length < 128);
        return { header: reader.header, events: page.events };
      } finally { await reader.close(); }
    };
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      releases.push(ctx.llm.registerAdapter([route.provider], adapter));
      releases.push(await ctx.agentPresets.register({ id: presetId, name: 'Native child fixture', plugins: [] }));
      const registry = ctx.get('dshBots');
      await registry.waitUntilReady();
      const service = () => ctx.get('dshBotProactive');
      await wait(service);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input) => ctx.typertGateway.invoke({ namespace: 'dshBot.proactive', method, args: { input }, peer, signal });
      const saved = await readFile(stateFile, 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!saved) await registry.create({ id: botId, name: 'Native child owner', template: 'minimal' });
      const owner = await registry.get(botId);
      const subject = { kind: 'bot', bot: { botId: owner.id, botCreatedAt: owner.createdAt } };
      const { sessionId } = await registry.openConversation(botId);
      const page = async () => (await invoke('followUpPage', { subject })).rows;
      const cardFor = async id => (await page()).find(row => row.origin.kind === 'native-subagent' && row.origin.childSessionId === id);
      const summary = () => invoke('followUpSummary', subject);
      if (saved) {
        assert.equal(sessionId, saved.sessionId);
        await wait(async () => (await summary()).state === 'ready');
        await delay(1100, undefined, { signal });
        assert.deepEqual(await page(), saved.cards);
        assert.equal(adapter.calls.length, 0);
        for (const child of saved.children) {
          const events = (await native(child.id)).events;
          assert.equal(events.filter(event => event.type === 'turn/end').length, 1);
        }
        await save('product-native-child-cold.json', { sessionId, cards: saved.cards.length, duplicateCards: 0, modelRequests: 0, realModelRequests: 0 });
      } else {
        const disabled = await summary();
        assert.equal(disabled.state, 'disabled');
        const receipt = await invoke('followUpPolicy', { commandId: randomUUID(), subject, action: 'enable-local',
          expectedRevision: null, expectedConfigEpoch: disabled.configEpoch });
        assert.equal(receipt.kind, 'receipt', JSON.stringify(receipt));
        const { agent: parent } = await ctx.sessionController.resolveAgent(sessionId);
        assert.ok(parent);
        const children = [];
        for (const outcome of ['failed', 'completed', 'cancelled']) {
          const id = randomUUID(), control = { outcome };
          adapter.controls.set(id, control);
          const label = `Native background child ${outcome}`;
          const handle = await ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', childId: id, label, signal,
            request: { parent, agentPreset: presetId, agentOptions: route, prompt: [{ type: 'text', text: `Synthetic ${outcome} native task` }], maxDepth: 1 } });
          try {
            await wait(() => control.release);
            const tracking = await wait(async () => {
              const card = await cardFor(id);
              return card?.condition.kind === 'tracking' && card;
            });
            assert.equal(tracking.title, label);
            if (outcome === 'cancelled') ctx.subagents.interrupt(id, { kind: 'ancestor', agent: parent });
            else control.release();
            await handle.result;
          } finally { control.release?.(); await handle.dispose(); }
          const { header, events } = await native(id);
          assert.equal(header.parentSession, sessionId);
          assert.equal(header.origin, 'subagent');
          const end = events.findLast(event => event.type === 'turn/end');
          assert.equal(end?.data.reason.kind, { failed: 'error', completed: 'completed', cancelled: 'aborted' }[outcome]);
          const condition = outcome === 'failed' ? { kind: 'failed', reason: end.data.reason.error.message }
            : { kind: 'closed', reason: outcome === 'completed' ? 'resolved' : 'cancelled' };
          if (outcome === 'failed') assert.ok(condition.reason.includes(nativeError));
          const card = await wait(async () => {
            const current = await cardFor(id);
            return current?.condition.kind === condition.kind && current;
          });
          assert.deepEqual(card.subject, subject);
          assert.deepEqual(card.origin, { kind: 'native-subagent', sessionId, childSessionId: id, turn: end.data.turn });
          assert.deepEqual(card.condition, condition);
          children.push({ id, outcome, cardId: card.id, end: end.data.reason.kind });
        }
        assert.equal(await ctx.sessions.flush(parent.session), true);
        await delay(1100, undefined, { signal });
        const cards = await page();
        assert.equal(cards.length, 3);
        assert.deepEqual(adapter.calls, children.map(child => child.id));
        assert.deepEqual(await service().workList(), []);
        await save('product-native-child-warm.json', { sessionId, children, cards, explicitModelRequests: adapter.calls.length,
          additionalModelRequests: 0, realModelRequests: 0 });
      }
      console.log('B4_WEB_READY');
    })().catch(async error => {
      if (signal.aborted) return;
      await save('product-native-child-error.json', { message: String(error), stack: error.stack, calls: adapter.calls });
      console.error('B4_WEB_FAILED', error);
    });
    return async () => {
      stop.abort();
      for (const control of adapter.controls.values()) control.release?.();
      await run; await peer?.dispose(); for (const release of releases.reverse()) release();
    };
  });
}
