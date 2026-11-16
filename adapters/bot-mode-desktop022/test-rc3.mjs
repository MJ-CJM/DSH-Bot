import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import { openArchive, sha256 } from './archive.mjs';
import { VERSION, WORKSPACE_BASELINE_SHA256, patchWorkspace } from './rc3.mjs';
import { PATCHES } from './workspace.mjs';

const archivePath = process.env.DSH_BOT_RC3_ASAR ?? resolve(import.meta.dirname,
  '../../.dsh-dev/official-desktop-rc3/download/DeepSeek Harness.app/Contents/Resources/app.asar');
const archive = openArchive(await readFile(archivePath));
assert.equal(JSON.parse(archive.read('dsh/desktop-runtime.json')).release.version, VERSION);
const baseline = archive.read('dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js').toString();
const patched = patchWorkspace(baseline);

// Execute closures from the actual official bundle, rather than reimplementing
// its workspace logic. External services remain deliberately controlled fixtures.
function closure(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0 && source.indexOf(marker, start + marker.length) === -1, `Unique native closure: ${marker}`);
  const signatureEnd = source.indexOf('){', start);
  assert.ok(signatureEnd > start, `Missing native function body: ${marker}`);
  const begin = signatureEnd + 1;
  let depth = 0, quote, escaped = false;
  for (let i = begin; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
    } else if ('"\'`'.includes(char)) quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw Error(`Unbalanced native closure: ${marker}`);
}

function fixture(source, { preset = 'stale-bot', fresh = 'recorded-bot', blank = true, archived = false,
  owned = true, creationError, refreshError } = {}) {
  const requests = [], refreshes = [];
  const summary = { blank, cwd: '/fixture', projectionValues: { agentPreset: preset } };
  const workspace = { workspaceId: 'workspace', path: '/fixture', sessionIds: owned ? ['blank'] : [] };
  const methods = runInNewContext(`({${['createInWorkspace(workspace,options){', 'async createNamed(request){',
    'async restoreBlank(workspaceId,sessionId){'].map(marker => closure(source, marker)).join(',')}})`,
  { sessionCreateErrorOf: error => error, console: { warn() {} } });
  const self = { ...methods,
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: archived ? ['blank'] : [] }) } },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['blank'], byId: { blank: summary } }) },
      async refreshProjections(id) { refreshes.push(id); if (refreshError) throw refreshError; summary.projectionValues.agentPreset = fresh; },
      async create(request) {
        requests.push(JSON.parse(JSON.stringify(request)));
        if (request.agentPreset && creationError) throw { rpcError: { code: creationError } };
        return request.sessionId ?? 'new-session';
      },
    },
  };
  return { self, workspace, requests, refreshes };
}

test('rc.3 exact baseline, syntax and complete reversibility preserve all unrelated native code', () => {
  assert.equal(sha256(baseline), WORKSPACE_BASELINE_SHA256);
  let reversed = patched;
  for (const [anchor, replacement] of [...PATCHES].reverse()) {
    assert.equal(baseline.split(anchor).length, 2);
    assert.equal(reversed.split(replacement).length, 2);
    reversed = reversed.replace(replacement, anchor);
  }
  assert.equal(reversed, baseline.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n'));
  assert.doesNotThrow(() => new Script(patched));
});

test('rc.3 refuses baseline drift, altered anchors and repeated application', () => {
  for (const changed of [baseline + '\n', baseline.replace('workspace.picker', 'workspace.picker.drift'), patched,
    ...PATCHES.map(([anchor]) => baseline.replace(anchor, '/* removed anchor */'))]) {
    assert.throws(() => patchWorkspace(changed), /Unexpected official rc\.3 Workspace bytes/);
  }
});

test('actual rc.3 implicit reuse refreshes the recorded preset before native Session creation', async () => {
  const original = fixture(baseline), adapted = fixture(patched);
  assert.equal(await original.self.createInWorkspace(original.workspace, {}), 'blank');
  assert.equal(original.requests[0].agentPreset, undefined);
  assert.equal(original.refreshes.length, 0);
  assert.equal(await adapted.self.createInWorkspace(adapted.workspace, {}), 'blank');
  assert.deepEqual(adapted.refreshes, ['blank']);
  assert.deepEqual(adapted.requests, [{ workspaceId: 'workspace', sessionId: 'blank', agentPreset: 'recorded-bot' }]);
});

test('actual rc.3 explicit preset matching and unavailable blank paths retain native behavior', async () => {
  for (const [options, input] of [[{}, { agentPreset: 'stale-bot' }], [{}, { agentPreset: 'different-bot' }],
    [{ blank: false }, {}], [{ archived: true }, {}], [{ owned: false }, {}]]) {
    const original = fixture(baseline, options), adapted = fixture(patched, options);
    const before = await original.self.createInWorkspace(original.workspace, input);
    const after = await adapted.self.createInWorkspace(adapted.workspace, input);
    assert.equal(after, before); assert.deepEqual(adapted.requests, original.requests);
    assert.deepEqual(adapted.refreshes, original.refreshes);
  }
});

test('actual rc.3 preset fallback is precise and never hides projection or authorization errors', async () => {
  for (const creationError of ['agent-preset/not-found', 'agent-preset/invalid']) {
    const f = fixture(patched, { creationError });
    assert.equal(await f.self.createInWorkspace(f.workspace, {}), 'blank');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].agentPreset, 'recorded-bot');
    assert.deepEqual(f.requests[1], { workspaceId: 'workspace', sessionId: 'blank' });
  }
  const missing = fixture(patched, { fresh: null });
  await missing.self.createInWorkspace(missing.workspace, {});
  assert.equal(missing.requests.length, 1); assert.equal(missing.requests[0].agentPreset, undefined);
  const denied = fixture(patched, { creationError: 'permission/denied' });
  await assert.rejects(denied.self.createInWorkspace(denied.workspace, {})); assert.equal(denied.requests.length, 1);
  const refreshError = Error('projection unavailable'), unavailable = fixture(patched, { refreshError });
  await assert.rejects(unavailable.self.createInWorkspace(unavailable.workspace, {}), refreshError);
  assert.equal(unavailable.requests.length, 0);
});

test('rc.3 public workspace.picker factory and directory-flow/create callbacks remain intact', async () => {
  for (const marker of ['function surfaceFlow(', 'function WorkspacePicker(', 'function WorkspacePickerFactory(']) {
    assert.equal(closure(patched, marker), closure(baseline, marker));
  }
  const registration = source => {
    const start = source.indexOf('ctx.slots.registerFactory({name:`workspace.picker`');
    assert.ok(start >= 0);
    const end = source.indexOf(',WorkspacePickerFactory)', start);
    assert.ok(end > start);
    return source.slice(start, end + ',WorkspacePickerFactory)'.length);
  };
  assert.equal(registration(patched), registration(baseline));
  const creates = [], registrations = [], slotCalls = [], directoryFlow = {};
  const globals = { react_jsx_runtime: { jsx: (type, props) => ({ type, props }) }, WorkspacePickFlow: 'native-flow',
    workspaces: { create: input => { creates.push(input); return Promise.resolve('workspace-created'); } },
    factoryFlowSource: directoryFlow, NS: 'native-workspace-locale',
    ctx: { slots: { registerFactory: (options, component) => registrations.push({ options, component }) } } };
  const pickerStart = patched.indexOf('const pickerInjected='), pickerEnd = patched.indexOf(';', pickerStart);
  runInNewContext(`${closure(patched, 'function surfaceFlow(')};${closure(patched, 'function WorkspacePickerFactory(')};
    ${patched.slice(pickerStart, pickerEnd + 1)}${registration(patched)};`, globals);
  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, 'workspace.picker'); assert.equal(options.scope, 'root');
  assert.equal(options.children['workspace.picker.directoryFlow'].kind, 'single');
  const injected = options.inject(); assert.equal(injected.hooks.directoryFlow, directoryFlow);
  const input = { path: '/new-workspace' };
  assert.equal(await injected.createWorkspace(input), 'workspace-created'); assert.equal(creates[0], input);
  const owner = {}, onPick = () => {}, onClose = () => {}, useWorkspaces = () => {};
  const rendered = component({ open: true, selectedId: 'workspace', onPick, onClose, useWorkspaces,
    renderSlot: (...args) => { slotCalls.push(args); return 'native-directory-flow'; } });
  assert.equal(rendered.type, 'native-flow'); assert.equal(rendered.props.selectedId, 'workspace');
  assert.equal(rendered.props.onPick, onPick); assert.equal(rendered.props.onClose, onClose);
  assert.equal(rendered.props.useWorkspaces, useWorkspaces);
  assert.equal(rendered.props.renderDirectoryFlow(owner), 'native-directory-flow');
  assert.equal(slotCalls[0][0], 'workspace.picker.directoryFlow'); assert.equal(slotCalls[0][1], owner);
});
