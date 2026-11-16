import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { PATCHES, patchBotModeRenderer } from './patch.mjs';
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, '.dsh-dev/proactive-bot/host-runtime/package.json'));
const cli = createRequire(require.resolve('@deepseek-ai/dsh/package.json'));
const baseline = await readFile(cli.resolve('@deepseek-ai/dsh-client-ui-renderer/client'));
const patched = patchBotModeRenderer(baseline);
const body = patched.slice(patched.indexOf('function RootOutlet('), patched.indexOf('\n\t\t/**\n\t\t* Build the renderer', patched.indexOf('function RootOutlet(')));
function fixture() {
  let entry, entries = [], effects = [], subscriptions = 0, localeReads = 0;
  const ref = { current: false };
  const host = { entriesOfSlot: () => entry ? [entry] : [], entriesOf: () => entries,
    subscribe: () => { subscriptions++; return () => {}; }, getVersion: () => 1, locale: {} };
  const jsx = (type, props) => ({ type, props });
  class SlotAssemblyError extends Error {}
  const render = runInNewContext(`${body}\nRootOutlet;`, { useHost: () => host, react: {
    useRef: () => ref, useEffect: callback => { effects.push(callback); },
    useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => {}); snapshot(); },
  }, useLocaleRevision: () => { localeReads++; }, react_jsx_runtime: { jsx }, SlotAssemblyError,
  ANCHOR_STYLE: {}, SlotErrorBoundary: 'SlotErrorBoundary', RootEntry: 'RootEntry', EMPTY_SLOT_INJECT: {}, entryKeyOf: value => value.id });
  return { render: () => render({ ownerProps: {} }), commit: () => { for (const effect of effects.splice(0)) effect(); },
    registered: () => { entry = { id: `entry-${subscriptions}` }; entries = [entry]; },
    clear: () => { entry = undefined; entries = []; },
    broken: () => { entry = undefined; entries = [{ id: 'abdicated' }]; },
    reads: () => ({ subscriptions, localeReads }) };
}
test('pinned reversible patch leaves every unrelated upstream byte unchanged', () => {
  assert.throws(() => patchBotModeRenderer(Buffer.from('drift')), /Unexpected native Renderer baseline/);
  let reverse = patched;
  for (const [anchor, replacement] of [...PATCHES].reverse()) reverse = reverse.replace(replacement, anchor);
  assert.equal(reverse, baseline.toString().replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n'));
});
test('initial missing root still throws the native assembly error', () => {
  const f = fixture(); assert.throws(f.render, /before any 'root' registration/);
});
test('an uncommitted registration does not grant recovery', () => {
  const f = fixture(); f.registered(); f.render(); f.clear(); assert.throws(f.render, /boot order/);
});
test('committed valid root waits during repeated gaps and recovers through its original subscriptions', () => {
  const f = fixture(); f.registered(); assert.equal(f.render().props['data-slot'], 'root'); f.commit();
  for (let i = 0; i < 3; i++) {
    f.clear(); const waiting = f.render(); f.commit();
    assert.equal(waiting.props['data-slot-waiting'], 'root'); assert.equal(waiting.props['aria-busy'], true);
    f.registered(); assert.equal(f.render().props['data-slot'], 'root'); f.commit();
  }
  assert.deepEqual(f.reads(), { subscriptions: 7, localeReads: 7 });
});
test('registered-but-abdicated entries preserve the native crash face', () => {
  for (const committed of [false, true]) {
    const f = fixture(); if (committed) { f.registered(); f.render(); f.commit(); }
    f.broken(); assert.equal(f.render().props['data-slot-error'], 'root');
  }
});
test('a root that abdicates before commit cannot grant recovery, and remount history is isolated', () => {
  const f = fixture(); f.registered(); f.render(); f.broken(); f.commit(); f.clear(); assert.throws(f.render, /boot order/);
  const next = fixture(); assert.throws(next.render, /boot order/);
});
