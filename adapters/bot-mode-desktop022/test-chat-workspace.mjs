import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import * as chatAdapter from './chat.mjs';
import * as workspaceAdapter from './workspace.mjs';

const baselineRoot = resolve(import.meta.dirname, '../../.dsh-dev/bot-mode-desktop022/baseline');
const chatBaseline = await readFile(resolve(baselineRoot, 'dsh-client-ui-chat/lib/client.js'));
const workspaceBaseline = await readFile(resolve(baselineRoot, 'dsh-client-ui-workspace/lib/client.js'));
const chat = chatAdapter.patchBotModeChat(chatBaseline);
const workspace = workspaceAdapter.patchBotModeWorkspace(workspaceBaseline);
const withoutMap = source => source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n');

// Extract and execute the actual transformed native methods, with public services as fixtures.
function closure(source, marker, prefix = '') {
  const offset = source.indexOf(marker);
  assert.ok(offset >= 0, `Missing native closure: ${marker}`);
  const start = offset + prefix.length;
  const begin = source.indexOf('{', offset);
  let depth = 0, quote, escaped = false;
  for (let i = begin; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced closure: ${marker}`);
}

for (const [name, adapter, baseline, patched] of [
  ['Chat', chatAdapter, chatBaseline, chat],
  ['Workspace', workspaceAdapter, workspaceBaseline, workspace],
]) {
  test(`${name}: exact native hash, unique anchors, complete byte reversibility and syntax`, () => {
    assert.equal(createHash('sha256').update(baseline).digest('hex'), adapter.BASELINE_SHA256);
    for (const [anchor, replacement] of adapter.PATCHES) {
      assert.equal(baseline.toString().split(anchor).length, 2);
      assert.equal(patched.split(replacement).length, 2);
    }
    let reversed = patched;
    for (const [anchor, replacement] of [...adapter.PATCHES].reverse()) reversed = reversed.replace(replacement, anchor);
    assert.equal(reversed, withoutMap(baseline.toString()));
    assert.doesNotThrow(() => new Script(patched));
    const patch = name === 'Chat' ? adapter.patchBotModeChat : adapter.patchBotModeWorkspace;
    assert.throws(() => patch(Buffer.concat([baseline, Buffer.from('\n')])), /Unexpected native/);
    assert.throws(() => patch(Buffer.from(patched)), /Unexpected native/);
    for (const [anchor] of adapter.PATCHES) {
      assert.throws(() => patch(Buffer.from(baseline.toString().replace(anchor, '/* missing anchor */'))), /Unexpected native/);
      assert.throws(() => patch(Buffer.from(`${baseline}${anchor}`)), /Unexpected native/);
    }
  });
}

function chatFixture() {
  let resolution = { status: 'pass' }, rows = [], handled = 0;
  const forked = [], opened = [], resolved = [], listeners = new Set();
  const policy = {
    modePresentation: {
      getSnapshot: () => rows,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    resolveCommandMode: (...args) => { resolved.push(args); return resolution; },
  };
  const ctx = {
    shortcuts: policy,
    sessions: { fork: request => { forked.push(request); return Promise.resolve('native-child'); } },
    uiWorkspace: { openSession: id => opened.push(id) },
    get: () => undefined,
  };
  const fork = runInNewContext(`(${closure(chat, 'forkAt:seq=>{', 'forkAt:')})`, {
    ctx, sessionId: 'exact-native-session', document: { activeElement: null },
    chat: { getSnapshot: () => ({ timeline: { turns: new Map() } }) },
  });
  return {
    policy, fork, forked, opened, resolved, listeners,
    setMode(active) { rows = active ? [{ id: 'session.fork', hidden: true }] : []; resolution = active ? { status: 'blocked' } : { status: 'pass' }; },
    setHandled() { resolution = { status: 'handled', run: () => handled++ }; },
    handled: () => handled,
  };
}

function renderFooter(source, fixture) {
  const start = source.indexOf('const TurnTailNodeView=');
  const end = source.indexOf('function record(value)', start);
  assert.ok(start >= 0 && end > start);
  const disposers = [];
  const jsx = (type, props) => ({ type, props });
  const globals = {
    react: { memo: fn => fn, useSyncExternalStore: (subscribe, snapshot) => { disposers.push(subscribe(() => {})); return snapshot(); } },
    react_jsx_runtime: { jsx, jsxs: jsx },
    MessageIconActions: 'MessageIconActions', TurnUsagePanel: 'TurnUsagePanel',
    TurnTailNodeView_module_css_default: { root: 'native-root', actions: 'native-actions' },
    assistantText: () => 'native assistant text', lastContent: () => undefined, hasAssistantReplyContent: () => true,
    testPolicy: fixture.policy,
  };
  const helper = source.includes('__dshBotUseBranchHidden')
    ? `${chatAdapter.PATCHES[0][1].slice('let react=require("react");'.length)}\n__dshBotChatShortcutPolicy=testPolicy;\n` : '';
  const component = runInNewContext(`${helper}${source.slice(start, end)}\nTurnTailNodeView;`, globals);
  const props = component({
    node: { location: { kind: 'turn', turn: 4 }, data: { turn: 4, seq: 77, branchUnavailable: false, tokenUsage: { input: 3 }, closing: { finalNode: { seq: 77, messageId: 'exact-message' }, time: 123, blocks: [] } } },
    openFile() {}, forkAt: fixture.fork,
    renderSlot: slot => slot === 'conversation.chat.assistant-actions' ? 'native feedback' : 'native tail',
    t: x => x, useAccess: () => true, useChat: select => select({ timeline: { turnOrder: [4] } }), usePerformanceUsage: () => 'detailed',
  }).props.children[1].props;
  return { props, dispose: () => disposers.forEach(off => { off(); }) };
}

test('Chat: only Branch hides; copy/time/usage/feedback remain native, subscription cleans up', () => {
  const f = chatFixture();
  const original = renderFooter(chatBaseline.toString(), f), off = renderFooter(chat, f);
  for (const key of Object.keys(original.props).filter(key => key !== 'onBranch')) {
    assert.equal(JSON.stringify(off.props[key]), JSON.stringify(original.props[key]));
  }
  assert.equal(typeof off.props.onBranch, 'function');
  assert.equal(f.listeners.size, 1); off.dispose(); assert.equal(f.listeners.size, 0);
  f.setMode(true);
  const active = renderFooter(chat, f);
  assert.equal(active.props.onBranch, undefined);
  assert.equal(active.props.text, 'native assistant text');
  assert.equal(active.props.time, 123);
  assert.equal(active.props.extraActions, 'native feedback');
  assert.equal(active.props.usageAction.type, 'TurnUsagePanel'); active.dispose();
  f.setMode(false);
  const restored = renderFooter(chat, f);
  assert.equal(typeof restored.props.onBranch, 'function'); restored.dispose();
  assert.equal(f.listeners.size, 0);
});

test('Chat: captured Branch callback re-resolves mode; pass forks exact native session/seq', async () => {
  const f = chatFixture(), footer = renderFooter(chat, f), captured = footer.props.onBranch;
  f.setMode(true); captured(); assert.equal(f.forked.length, 0);
  assert.equal(f.resolved[0][0], 'session.fork');
  assert.equal(f.resolved[0][1].source, 'action'); assert.equal(f.resolved[0][1].region, 'page');
  f.setMode(false); captured(); await Promise.resolve();
  assert.equal(f.forked.length, 1); assert.equal(f.forked[0].atSeq, 77);
  assert.equal(f.forked[0].sessionId, 'exact-native-session'); assert.equal(f.forked[0].increaseTitle, true);
  assert.deepEqual(f.opened, ['native-child']); footer.dispose();
});

test('Chat: handled mode runs once and never calls native fork', () => {
  const f = chatFixture(); f.setHandled(); f.fork(19);
  assert.equal(f.handled(), 1); assert.equal(f.forked.length, 0);
});

test('Chat: command policy capability guard and surface are tied to ctx.effect lifetime', () => {
  const helper = chatAdapter.PATCHES[0][1].slice('let react=require("react");'.length);
  const applyPrefix = chatAdapter.PATCHES[2][1];
  const disposers = [], surfaces = new Set();
  const policy = { modePresentation: {}, resolveCommandMode() {}, registerCommandModeSurface(id) { surfaces.add(id); return () => surfaces.delete(id); } };
  const ctx = { shortcuts: policy, effect: effect => disposers.push(effect()) };
  const probe = runInNewContext(`${helper}${applyPrefix}};({apply, current:()=>__dshBotChatShortcutPolicy});`, {});
  assert.throws(() => probe.apply({ shortcuts: {} }), /Chat command policy unavailable/);
  probe.apply(ctx); assert.equal(probe.current(), policy); assert.equal(surfaces.has('chat.branch'), true);
  disposers.pop()(); assert.equal(surfaces.size, 0); assert.equal(probe.current(), undefined);
});

const workspaceMethods = runInNewContext(`({${closure(workspace, 'createInWorkspace(workspace,options){')},${closure(workspace, 'async restoreBlank(workspaceId,sessionId){')}})`, { sessionCreateErrorOf: error => error });
function workspaceFixture({ blank = true, preset = 'original-custom', fresh = preset, error, archived = false } = {}) {
  const calls = [], refreshes = [];
  const summary = { blank, cwd: '/fixture', projectionValues: { agentPreset: preset } };
  const workspace = { workspaceId: 'native-workspace', path: '/fixture', sessionIds: ['native-blank'] };
  const self = {
    ...workspaceMethods,
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: archived ? ['native-blank'] : [] }) } },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['native-blank'], byId: { 'native-blank': summary } }) },
      async refreshProjections(id) { refreshes.push(id); if (error?.refresh) throw Error('projection unavailable'); summary.projectionValues.agentPreset = fresh; },
    },
    async createNamed(request) { calls.push({ ...request }); if (request.agentPreset && error?.preset) throw { rpcError: { code: error.preset } }; return request.sessionId ?? 'new-default'; },
  };
  return { self, workspace, calls, refreshes };
}

test('Workspace: implicit reuse refreshes exact projection and preserves recorded preset', async () => {
  const f = workspaceFixture({ preset: 'stale-hint', fresh: 'original-custom' });
  assert.equal(await f.self.createInWorkspace(f.workspace, {}), 'native-blank');
  assert.deepEqual(f.refreshes, ['native-blank']);
  assert.equal(f.calls[0].sessionId, 'native-blank'); assert.equal(f.calls[0].agentPreset, 'original-custom');
});

test('Workspace: native 0.2.2 explicit preset matching, no-blank and archived behavior survive', async () => {
  const different = workspaceFixture(); await different.self.createInWorkspace(different.workspace, { agentPreset: 'explicit-new' });
  assert.equal(different.calls[0].agentPreset, 'explicit-new'); assert.equal(different.calls[0].sessionId, undefined); assert.equal(different.refreshes.length, 0);
  const same = workspaceFixture(); await same.self.createInWorkspace(same.workspace, { agentPreset: 'original-custom' });
  assert.equal(same.calls[0].sessionId, 'native-blank'); assert.equal(same.refreshes.length, 0);
  for (const options of [{ blank: false }, { archived: true }]) {
    const f = workspaceFixture(options); assert.equal(await f.self.createInWorkspace(f.workspace, {}), 'new-default');
    assert.equal(f.calls[0].sessionId, undefined); assert.equal(f.refreshes.length, 0);
  }
});

test('Workspace: existing missing/invalid preset fallback remains native and precise', async () => {
  const missing = workspaceFixture({ fresh: null }); await missing.self.createInWorkspace(missing.workspace, {});
  assert.equal(missing.calls.length, 1); assert.equal(missing.calls[0].agentPreset, undefined);
  for (const code of ['agent-preset/not-found', 'agent-preset/invalid']) {
    const bad = workspaceFixture({ error: { preset: code } }); await bad.self.createInWorkspace(bad.workspace, {});
    assert.equal(bad.calls.length, 2); assert.equal(bad.calls[1].agentPreset, undefined);
  }
  const unavailable = workspaceFixture({ error: { refresh: true } });
  await assert.rejects(unavailable.self.createInWorkspace(unavailable.workspace, {})); assert.equal(unavailable.calls.length, 0);
  const denied = workspaceFixture({ error: { preset: 'permission/denied' } });
  await assert.rejects(denied.self.createInWorkspace(denied.workspace, {})); assert.equal(denied.calls.length, 1);
});

test('Workspace: capability surface disposer follows ctx.effect and unsupported host remains safe', () => {
  const prefix = workspaceAdapter.PATCHES[1][1], disposers = [], surfaces = new Set(), warnings = [];
  const apply = runInNewContext(`${prefix}};apply;`, { console: { warn: (...args) => warnings.push(args) } });
  const ctx = { shortcuts: { registerCommandModeSurface(id) { surfaces.add(id); return () => surfaces.delete(id); } }, effect: effect => disposers.push(effect()) };
  apply(ctx); assert.equal(surfaces.has('workspace.blank-preset'), true);
  disposers.pop()(); assert.equal(surfaces.size, 0);
  apply({ shortcuts: {}, effect: effect => effect() });
  apply({ shortcuts: { registerCommandModeSurface() { throw Error('unavailable'); } }, effect: effect => effect() });
  assert.equal(warnings.length, 1);
});

console.log(JSON.stringify({ baseline: { chat: chatAdapter.BASELINE_SHA256, workspace: workspaceAdapter.BASELINE_SHA256 }, transformed: { chat: createHash('sha256').update(chat).digest('hex'), workspace: createHash('sha256').update(workspace).digest('hex') } }));
