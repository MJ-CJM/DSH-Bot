import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'v066-upgrade-probe';
export const inject = ['loader', 'dshBots', 'llm', 'agents', 'sessions', 'sessionController', 'typertGateway'];
const RESULT = 'V066_RETAINED_NATIVE_RESULT';
const MAIN = 'V066_RETAINED_MAIN_QUESTION';
const ci = { repository: 'fixture/upgrade', branch: 'main', generation: 1 };
const sourceId = `ci:${createHash('sha256').update(JSON.stringify([ci.repository, ci.branch])).digest('hex')}`;
const modes = [['v066-primary', 'suggest'], ['v066-peer', 'off'], ['v066-auto', 'auto']];
const botKey = bot => ({ botId: bot.id, botCreatedAt: bot.createdAt });
const groupKey = group => ({ groupId: group.id, groupCreatedAt: group.createdAt });
const canonical = value => JSON.parse(JSON.stringify(value));
const committed = reply => { assert.equal(reply.kind, 'receipt', JSON.stringify(reply)); assert.equal(reply.receipt.status, 'committed'); };

class Adapter extends LlmAdapter {
  sessions = [];
  async listModels(provider) { return [{ provider, id: 'fixture', name: 'Synthetic upgrade history fixture' }]; }
  async *stream(options) {
    this.sessions.push(options.sessionId);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: RESULT };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: RESULT } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
function coreSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 2500 });
  try {
    db.exec('BEGIN');
    return canonical({
      identity: db.prepare('SELECT installation,store,schema_version FROM pb_meta WHERE singleton=1').get(),
      source: db.prepare('SELECT id,generation,checkpoint FROM pb_source WHERE id=?').get(sourceId),
      decisions: db.prepare(`SELECT d.id,d.value FROM decision d
        JOIN pb_ci_head h ON h.decision=d.id WHERE h.source=? ORDER BY d.id`).all(sourceId),
      responsibilities: db.prepare('SELECT id,payload FROM pb_responsibility ORDER BY id').all(),
      responsibilityHistory: db.prepare('SELECT id,revision,payload FROM pb_responsibility_history ORDER BY id,revision').all(),
      workCount: db.prepare('SELECT count(*) AS n FROM pb_work').get().n,
    });
  } finally { db.close(); }
}
function retainedCore(current, previous) {
  assert.ok(current.identity.schema_version >= previous.identity.schema_version);
  assert.deepEqual(current, { ...previous, identity: { ...previous.identity, schema_version: current.identity.schema_version } });
}

export function apply(ctx, config) {
  ctx.effect(() => {
    const abort = new AbortController(), adapter = new Adapter();
    const signal = abort.signal;
    let phase = 'loader', peer, off;
    const timer = setTimeout(() => abort.abort(new Error(`Upgrade deadline: ${phase}`)), 60000);
    const save = (name, value) => writeFile(resolve(config.outputDir, `${config.phase}-${name}.json`), JSON.stringify(value, null, 2));
    const load = name => readFile(resolve(config.outputDir, `${name}.json`), 'utf8').then(JSON.parse);
    const mark = value => { phase = value; console.log(`V066_UPGRADE_PHASE ${value}`); };
    const wait = async check => { for (;;) {
      signal.throwIfAborted();
      const result = await check();
      if (result) return result;
      await delay(25, undefined, { signal });
    } };
    const run = (async () => {
      await ctx.loader.await();
      assert.deepEqual(ctx.llm.listProviders(), []);
      off = ctx.llm.registerAdapter(['dp-b6b'], adapter);
      peer = new Peer(ctx, { principal: { kind: 'owner' }, interactions: 'none' });
      const invoke = (method, input) => ctx.typertGateway.invoke({
        namespace: 'dshBot.proactive', method, args: { input }, peer, signal,
      });
      await ctx.dshBots.waitUntilReady();
      await wait(() => ctx.dshBots.mainSessions);
      const groups = await wait(() => ctx.get('dshBotGroups'));
      const connectors = await wait(() => ctx.get('dshBotConnectors'));
      const notices = await wait(() => ctx.get('dshBotNotifications'));
      const service = () => ctx.get('dshBotProactive');

      if (config.phase === 'old') {
        mark('seed-baseline-native-data');
        const first = await ctx.dshBots.create({
          id: 'v066-primary', name: 'V066 retained primary', template: 'minimal',
          avatarColor: 'indigo', avatarVariant: 'hat', persona: { prefix: 'Synthetic upgrade primary persona.' },
        });
        const second = await ctx.dshBots.create({ id: 'v066-peer', name: 'V066 retained peer', template: 'minimal',
          avatarColor: 'cyan', avatarVariant: 'spout' });
        if (config.baseline === 'local') await ctx.dshBots.create({ id: 'v066-auto', name: 'V066 legacy automatic Bot', template: 'minimal' });
        await ctx.dshBots.memoryFor(first.id).save({
          content: 'V066 retained pinned private preference.', kind: 'preference', tags: ['upgrade'], pinned: true,
        }, { by: 'user', at: Date.now() });
        const main = await ctx.dshBots.openConversation(first.id), agent = ctx.agents.get(main.sessionId);
        assert.ok(agent);
        const prompt = await ctx.sessionController.prompt({ sessionId: main.sessionId, requestId: 'v066-upgrade-main', mode: 'queue',
          content: [{ type: 'text', text: MAIN }] }, signal);
        assert.equal(prompt.accepted, true);
        await agent.whenIdle();
        assert.ok(await ctx.sessions.flush(agent.session));
        for (const mode of ['natural', 'mention']) {
          const group = await groups.create({ operationId: `v066-upgrade-${mode}`, name: `V066 retained ${mode}`, mode,
            members: [botKey(first), botKey(second)], historyConfirmed: true });
          const key = groupKey(group), view = await groups.view(key);
          const turn = await groups.send(key, { operationId: `v066-upgrade-history-${mode}`,
            text: `V066_RETAINED_GROUP_QUESTION_${mode}`, expectedMembershipRevision: group.membershipRevision,
            ...(mode === 'mention' ? { memberIds: [view.members[0].id] } : {}) });
          const settled = await wait(async () => (await groups.view(key)).turns.find(row => row.id === turn.id &&
            !['accepted', 'running'].includes(row.state)));
          assert.ok(['completed', 'idle'].includes(settled.state));
          assert.equal(adapter.sessions.includes(group.rootSessionId), false);
        }
        await connectors.saveDefinition({ id: 'v066-upgrade-connector', label: 'V066 disabled MCP', serverName: 'v066fixture',
          transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp', enabled: false }, 0);
        await notices.savePolicy({ id: 'v066-upgrade-policy', owner: botKey(first), channel: 'in-app', enabled: true,
          timezone: 'UTC', dailyLimit: 20, cooldownSec: 0, authorization: { mode: 'ask' } }, 0, false);
        await notices.record(botKey(first), { operationId: 'v066-upgrade-inbox', policyId: 'v066-upgrade-policy',
          text: 'V066 retained in-app notification.' }, { kind: 'tool', id: 'v066-upgrade-seed', sessionId: main.sessionId });
      }
      const seeded = adapter.sessions.length;
      if (config.phase === 'old' && config.baseline === 'local') {
        mark('seed-real-legacy-coordinator');
        const legacy = await wait(async () => {
          const current = service();
          return current && (await current.status()).state === 'ready' && current;
        });
        assert.equal((await legacy.status()).directRoute, undefined);
        committed(await legacy.observeCi(randomUUID(), ci, {
          complete: true, before: null, after: 'v066-upgrade-fixture-checkpoint',
          rows: modes.map(([, mode], index) => ({ repository: ci.repository, branch: ci.branch, job: mode, runId: String(index + 1),
            commit: 'c'.repeat(40), observedAt: new Date().toISOString(), attempt: 1, conclusion: 'failure' })),
        }));
        for (const [id, mode] of modes) {
          const bot = await ctx.dshBots.get(id), owner = botKey(bot);
          committed(await legacy.change(randomUUID(), { kind: 'responsibility-mutation', input: {
            kind: 'create', id: `upgrade-role-${mode}`, owner, draft: {
              name: `V066 retained ${mode} rule`, mode, source: { id: sourceId, ...ci },
              target: { bot: owner, botUpdatedAt: bot.updatedAt, provider: 'dp-b6b', model: 'fixture' },
              action: 'inspect-ci-result', conditions: { jobs: [mode] },
              acceptance: { goal: 'Explain the fixture failure', deliverables: ['Evidence'],
                checks: [{ id: 'check', title: 'Check source evidence', kind: 'both' }] },
              limits: { dailyRequests: 8, dailyTokens: 65536, taskTokens: 8192, taskAttempts: 2, taskWallTimeMs: 120000, concurrency: 1 },
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          } }));
        }
        const retained = coreSnapshot(config.corePath);
        assert.equal(retained.source.checkpoint, 'v066-upgrade-fixture-checkpoint');
        assert.equal(retained.decisions.length, 3);
        assert.equal(retained.responsibilities.length, 3);
        assert.equal(retained.workCount, 0);
        await save('core', retained);
      }
      if (config.phase === 'old' && config.baseline === 'public') {
        assert.equal(service(), undefined);
        assert.equal(existsSync(config.corePath), false);
      }

      mark('verify-retained-native-data');
      const bots = await ctx.dshBots.list();
      const main = await ctx.dshBots.openConversation('v066-primary');
      const mainAgent = ctx.agents.get(main.sessionId);
      assert.ok(mainAgent);
      const mainHistory = mainAgent.session.snapshotEvents()
        .filter(event => ['user/message', 'assistant/message'].includes(event.type))
        .map(event => ({ type: event.type, data: event.data }));
      const views = await Promise.all((await groups.list()).map(({ group }) => groups.view(groupKey(group))));
      const snapshot = canonical({
        bots: [...bots].sort((a, b) => a.id.localeCompare(b.id)), mainSessionId: main.sessionId, mainHistory,
        memories: await ctx.dshBots.memoryFor('v066-primary').list(),
        groups: views.sort((a, b) => a.group.id.localeCompare(b.group.id)),
        connectors: connectors.definitions(), policies: notices.policies(), inbox: notices.list(),
      });
      assert.ok(JSON.stringify(mainHistory).includes(MAIN));
      assert.ok(JSON.stringify(mainHistory).includes(RESULT));
      assert.equal(snapshot.bots.find(bot => bot.id === 'v066-primary').avatarVariant, 'hat');
      assert.ok(views.every(view => view.messages.some(message => message.text === RESULT)));
      assert.equal(snapshot.memories.length, 1);
      assert.equal(snapshot.connectors[0].enabled, false);
      assert.equal(snapshot.inbox[0].state, 'recorded');
      if (config.phase !== 'old') assert.deepEqual(snapshot, await load('old-state'));
      await save('state', snapshot);

      let scopes, matrix, preserved;
      const primary = { kind: 'bot', bot: botKey(bots.find(bot => bot.id === 'v066-primary')) };
      const peerSubject = { kind: 'bot', bot: botKey(bots.find(bot => bot.id === 'v066-peer')) };
      const group = { kind: 'group', group: groupKey(views[0].group) };
      const summary = subject => invoke('followUpSummary', subject);
      const ready = subject => wait(async () => { const state = await summary(subject); return state.state === 'ready' && state; });
      const policy = async (subject, action, state) => {
        committed(await invoke('followUpPolicy', { commandId: randomUUID(), subject, action,
          expectedRevision: state.state === 'ready' ? state.summary.policy.revision : null, expectedConfigEpoch: state.configEpoch }));
        return ready(subject);
      };
      if (config.phase === 'new') {
        mark('scope-matrix');
        matrix = [];
        if (config.baseline === 'local') {
          await ready(primary);
          const previous = await load('old-core');
          retainedCore(coreSnapshot(config.corePath), previous);
          for (const [id, mode] of modes) {
            const subject = { kind: 'bot', bot: botKey(bots.find(bot => bot.id === id)) };
            const initial = await ready(subject);
            assert.equal(initial.summary.policy.localEnabled, false);
            assert.equal(initial.summary.legacyCiActive, mode !== 'off');
            const on = await policy(subject, 'enable-local', initial);
            assert.equal(on.summary.policy.localEnabled, true);
            assert.equal(on.summary.legacyCiActive, mode !== 'off');
            const paused = await policy(subject, 'pause', on);
            assert.equal(paused.summary.policy.localEnabled, false);
            assert.equal(paused.summary.legacyCiActive, false);
            const resumed = await policy(subject, 'enable-local', paused);
            assert.equal(resumed.summary.legacyCiActive, false);
            await policy(subject, 'pause', resumed);
            matrix.push({ mode, initialLegacy: initial.summary.legacyCiActive, enabledLegacy: on.summary.legacyCiActive,
              pausedLegacy: paused.summary.legacyCiActive, resumedLegacy: resumed.summary.legacyCiActive });
          }
          const editor = ctx.get('configEditor');
          const entry = editor.entries().find(row => row.options.name === 'dsh-bot');
          assert.ok(entry);
          await editor.edit(entry, raw => ({ ...raw, proactiveEnabled: false }));
          retainedCore(coreSnapshot(config.corePath), previous);
        }
        const disabled = await summary(primary);
        assert.equal(disabled.state, 'disabled');
        assert.equal((await summary(peerSubject)).state, 'disabled');
        assert.equal((await summary(group)).state, 'disabled');
        const active = await policy(primary, 'enable-local', disabled);
        assert.equal(active.scopeOnly, true);
        assert.equal(active.summary.policy.localEnabled, true);
        assert.equal(active.summary.legacyCiActive, false);
        scopes = await Promise.all([primary, peerSubject, group].map(summary));
        assert.deepEqual(scopes.map(row => row.summary.policy.localEnabled), [true, false, false]);
        assert.ok(scopes.every(row => !row.summary.legacyCiActive));
        preserved = coreSnapshot(config.corePath);
        if (config.baseline === 'local') retainedCore(preserved, await load('old-core'));
        await save('core', preserved);
        await save('scopes', scopes);
      } else if (config.phase === 'reinstalled') {
        mark('verify-reinstalled-scope');
        await ready(primary);
        scopes = await Promise.all([primary, peerSubject, group].map(summary));
        assert.deepEqual(scopes, await load('new-scopes'));
        preserved = coreSnapshot(config.corePath);
        retainedCore(preserved, await load('new-core'));
      } else if (config.phase === 'unknown') {
        mark('reject-unknown-coordinator-schema');
        const current = await summary(primary);
        assert.equal(current.state, 'unavailable');
        const result = await invoke('followUpPolicy', { commandId: randomUUID(), subject: peerSubject, action: 'enable-local',
          expectedRevision: null, expectedConfigEpoch: current.configEpoch });
        assert.notEqual(result.kind, 'receipt');
        assert.equal((await summary(primary)).state, 'unavailable');
      }
      await delay(350, undefined, { signal });
      assert.equal(adapter.sessions.length, seeded, 'Read, migration, scope changes and reinstall must not start model work');
      if (config.phase !== 'old') assert.equal(seeded, 0);
      await save('result', { status: 'PASS', phase: config.phase, installedVersion: config.installedVersion,
        seedRequests: seeded, backgroundModelRequests: 0, realModelRequests: 0, matrix, coreIdentity: preserved?.identity,
        activeScopes: scopes?.map(row => row.summary.policy.localEnabled) });
      console.log('V066_UPGRADE_DONE');
    })().catch(async error => {
      await save('result', { status: 'FAIL', phase, error: String(error), stack: error.stack, adapterRequests: adapter.sessions.length, realModelRequests: 0 });
      console.log('V066_UPGRADE_FAILED');
    });
    return async () => { clearTimeout(timer); abort.abort(); await run; peer?.dispose(); off?.(); };
  });
}
