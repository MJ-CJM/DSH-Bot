import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { patchShortcuts, SHORTCUTS_BASELINE_SHA256 } from './shortcuts.mjs';
import { createHash } from 'node:crypto';

const baselinePath = resolve(import.meta.dirname, '../../.dsh-dev/bot-mode-desktop022/baseline/dsh-client-shortcuts/lib/client.js');
const baseline = await readFile(baselinePath, 'utf8');
const patched = patchShortcuts(baseline);
const plain = value => JSON.parse(JSON.stringify(value));
const snapshot = initial => {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, set(next) { value = next; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
};
class EventSurface {
  listeners = new Map();
  addEventListener(type, listener, capture = false) { this.listeners.set(`${type}:${capture}`, [...this.listeners.get(`${type}:${capture}`) ?? [], listener]); }
  removeEventListener(type, listener, capture = false) { this.listeners.set(`${type}:${capture}`, (this.listeners.get(`${type}:${capture}`) ?? []).filter(row => row !== listener)); }
  emit(type, event) { for (const capture of [true, false]) for (const listener of this.listeners.get(`${type}:${capture}`) ?? []) listener(event); }
  count() { return [...this.listeners.values()].reduce((sum, rows) => sum + rows.length, 0); }
}
class Element {
  constructor(region = 'page') { this.region = region; this.dataset = {}; }
  closest(selector) { return selector === '.xterm' ? this.region === 'terminal' ? this : null : this.region === 'editable' ? this : null; }
  matches() { return false; }
  querySelector() { return null; }
}
function load(source = patched) {
  let api, compositionDisposed = 0, observersDisposed = 0;
  const document = new EventSurface();
  Object.assign(document, { documentElement: { dataset: {} }, activeElement: new Element('editable'), querySelectorAll: () => [] });
  const window = new EventSurface();
  const storage = new Map();
  Object.assign(window, { document, setTimeout, clearTimeout, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    __ModuleLoader__: { load({ factory }) { api = factory(id => {
      if (id === '@deepseek-ai/cordis') return { Service: class { constructor(ctx) { this.ctx = ctx; } } };
      if (id === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: snapshot };
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { modalSelector: '[role=dialog]', observeComposition: () => ({ guards: event => event.isComposing, dispose: () => compositionDisposed++ }) };
      throw new Error(`Unexpected external ${id}`);
    }); } } });
  // Test-only exposure of lexical classes; production patch retains the original export.
  const instrumented = source.replace('module.exports=ShortcutsService;return module.exports', 'module.exports={Service:ShortcutsService,Registry:ShortcutRegistry,installKeyboard,installNativeKeyboard};return module.exports');
  runInNewContext(instrumented, { window, document, navigator: { platform: 'MacIntel' }, Element, console, crypto: globalThis.crypto,
    MutationObserver: class { observe() {} takeRecords() { return []; } disconnect() { observersDisposed++; } } });
  return { ...api, window, document, storage, disposed: () => ({ compositionDisposed, observersDisposed }) };
}
const context = { region: 'editable', modal: null, target: null };
const gesture = (code, overrides = {}) => ({ code, alt: true, meta: true, shift: false, control: false, repeat: false, composing: false, defaultPrevented: false, ...overrides });
const command = (id, code, run, runtime = 'web', platform = 'macos') => ({ id, label: () => id, aliases: [],
  defaults: { [`${runtime}:${platform}`]: { code, modifiers: platform === 'macos' ? ['alt', 'meta'] : ['control', 'shift'] } }, regions: ['page', 'editable'], modals: [], resolve: () => ({ status: 'handled', run }) });
function fixture(runtime = 'web', platform = 'macos') {
  const { Registry } = load(); const registry = new Registry(runtime, platform), calls = []; const disposers = new Map();
  for (const [id, code] of [['session.new', 'KeyN'], ['session.archive', 'KeyA'], ['session.fork', 'KeyF']]) disposers.set(id, registry.register(command(id, code, () => calls.push(id), runtime, platform)));
  const off = registry.registerCommandMode({ id: 'bot', priority: 100, commands: {
    'session.new': { label: () => 'Choose Bot', resolve: () => ({ status: 'handled', run: () => calls.push('bot-new') }) },
    'session.archive': { resolve: () => ({ status: 'handled', run: () => calls.push('bot-archive') }) },
    'session.fork': { hidden: true, resolve: () => ({ status: 'blocked', reason: 'bot-mode' }) },
  } });
  return { registry, calls, off, disposers };
}

test('actual 0.2.2 baseline hash guard rejects drift and double patch; native input modules remain byte identical', () => {
  assert.equal(createHash('sha256').update(baseline).digest('hex'), SHORTCUTS_BASELINE_SHA256);
  assert.throws(() => patchShortcuts(`${baseline}\n`), /Unsupported/);
  assert.throws(() => patchShortcuts(patched), /Unsupported/);
  assert.throws(() => patchShortcuts(null), /Unsupported/);
  assert.equal(baseline.slice(0, baseline.indexOf('var ShortcutRegistry=')), patched.slice(0, patched.indexOf('var ShortcutRegistry=')));
  const nativeModules = text => text.slice(text.indexOf('function detectEnvironment'), text.indexOf('var ShortcutsService='));
  assert.equal(nativeModules(patched), nativeModules(baseline));
});

test('keyboard/menu routing, hidden fork, public presentation and preference definitions', () => {
  const { registry, calls } = fixture(); let consumed = 0;
  const definitions = plain(registry.definitions()), config = plain(registry.config.getSnapshot());
  for (const code of ['KeyN', 'KeyA', 'KeyF']) registry.dispatch(gesture(code), context, () => consumed++);
  for (const id of ['session.new', 'session.archive', 'session.fork']) registry.invoke(id, context);
  assert.deepEqual(calls, ['bot-new', 'bot-archive', 'bot-new', 'bot-archive']); assert.equal(consumed, 3);
  assert.equal(registry.catalog.getSnapshot().some(row => row.id === 'session.fork'), false);
  assert.equal(registry.catalog.getSnapshot().find(row => row.id === 'session.new').label, 'Choose Bot');
  assert.equal(registry.modePresentation.getSnapshot().find(row => row.id === 'session.fork').hidden, true);
  assert.deepEqual(plain(registry.definitions()), definitions); assert.deepEqual(plain(registry.config.getSnapshot()), config);
});

test('priority/pass chain, immutable input, atomic rejection, and locale label refresh', () => {
  const { registry, calls } = fixture();
  assert.throws(() => registry.registerCommandMode({ id: 'conflict', priority: 100, commands: { 'session.new': { resolve: () => ({ status: 'pass' }) } } }), /Conflicting/);
  assert.throws(() => registry.registerCommandMode({ id: 'bot', priority: 200, commands: {} }), /Duplicate/);
  assert.throws(() => registry.registerCommandMode({ id: 'bad', priority: NaN, commands: {} }), /Invalid/);
  assert.throws(() => registry.registerCommandMode({ id: 'bad', priority: 1, commands: { x: { hidden: 'yes', resolve() {} } } }), /Invalid/);
  let label = 'Higher';
  const input = { id: 'higher', priority: 200, commands: { 'session.new': { label: () => label, resolve: () => ({ status: 'pass' }) } } };
  const off = registry.registerCommandMode(input); input.commands['session.new'].resolve = () => ({ status: 'blocked', reason: 'mutated' });
  registry.dispatch(gesture('KeyN'), context, () => {}); assert.deepEqual(calls, ['bot-new']);
  assert.equal(registry.catalog.getSnapshot()[0].label, 'Higher'); label = '更高'; registry.refreshLabels(); assert.equal(registry.catalog.getSnapshot()[0].label, '更高');
  assert.throws(() => registry.registerCommandMode({ id: 'throws', priority: 300, commands: { 'session.new': { label: () => { throw new Error('label'); }, resolve: () => ({ status: 'pass' }) } } }), /label/);
  assert.equal(registry.catalog.getSnapshot()[0].label, '更高');
  off(); off(); assert.equal(registry.catalog.getSnapshot()[0].label, 'Choose Bot');
});

test('disposal retains newly edited preferences and live registrations, without resurrecting commands', () => {
  const { registry, calls, off, disposers } = fixture(); const initial = registry.config.getSnapshot();
  registry.configure({ ...initial, revision: 'updated', sequence: initial.sequence + 1, document: { schemaVersion: 1, profiles: { 'web:macos': { 'session.archive': { code: 'KeyB', modifiers: ['alt', 'meta'] } } } } });
  // Simulate owning plugin disposal while the mode is active.
  disposers.get('session.new')();
  off(); off(); assert.equal(registry.dispatch(gesture('KeyN'), context, () => {}).status, 'pass');
  registry.register(command('session.new', 'KeyN', () => calls.push('replacement')));
  registry.dispatch(gesture('KeyN'), context, () => {}); registry.dispatch(gesture('KeyA'), context, () => {}); registry.dispatch(gesture('KeyB'), context, () => {});
  assert.deepEqual(calls, ['replacement', 'session.archive']); assert.equal(registry.config.getSnapshot().revision, 'updated');
});

test('native arbitration differential: IME, consumed input, repeats, modal, region, conflict and desktop priority', () => {
  for (const [runtime, platform] of [['web', 'macos'], ['desktop', 'macos'], ['desktop', 'windows'], ['desktop', 'linux']]) {
    const before = new (load(baseline).Registry)(runtime, platform), after = new (load().Registry)(runtime, platform);
    const trace = [[], []]; const registries = [before, after];
    registries.forEach((registry, i) => { registry.register(command('session.new', 'KeyN', () => trace[i].push('run'), runtime, platform)); });
    for (const override of [{}, { composing: true }, { defaultPrevented: true }, { repeat: true }]) for (const region of ['page', 'editable', 'terminal']) for (const modal of [null, 'other']) {
      const actual = registries.map((registry, i) => plain(registry.dispatch(gesture('KeyN', { ...(platform === 'macos' ? {} : { control: true, shift: true, alt: false, meta: false }), ...override }), { ...context, region, modal }, () => trace[i].push('consume'))));
      assert.deepEqual(actual[1], actual[0]); assert.deepEqual(trace[1], trace[0]);
    }
    // Active mode still obeys every native guard before resolution.
    let resolved = 0; after.registerCommandMode({ id: 'mode', priority: 1, commands: { 'session.new': { resolve: () => { resolved++; return { status: 'blocked', reason: 'mode' }; } } } });
    for (const override of [{ composing: true }, { defaultPrevented: true }]) assert.equal(after.dispatch(gesture('KeyN', { ...(platform === 'macos' ? {} : { control: true, shift: true, alt: false, meta: false }), ...override }), context, () => {}).status, 'pass');
    assert.equal(resolved, 0);
    const modalResult = after.dispatch(gesture('KeyN', platform === 'macos' ? {} : { control: true, shift: true, alt: false, meta: false }), { ...context, modal: 'other' }, () => {});
    assert.equal(modalResult.reason, runtime === 'desktop' && ['macos', 'windows'].includes(platform) ? 'mode' : 'modal');
  }
  const { registry } = fixture(); const current = registry.config.getSnapshot();
  registry.configure({ ...current, revision: 'conflict', document: { schemaVersion: 1, profiles: { 'web:macos': { 'session.new': { code: 'KeyN', modifiers: ['alt', 'meta'] }, 'session.fork': { code: 'KeyN', modifiers: ['alt', 'meta'] } } } } });
  assert.equal(registry.dispatch(gesture('KeyN'), context, () => {}).reason, 'conflict');
});

test('mode-only actions and separate windows preserve their own policy', () => {
  const { Registry } = load(); const left = new Registry('web', 'macos'), right = new Registry('web', 'macos');
  const off = left.registerCommandMode({ id: 'action', priority: 1, commands: { 'session.fork': { hidden: true, resolve: () => ({ status: 'blocked', reason: 'mode' }) } } });
  assert.equal(left.resolveCommandMode('session.fork', { ...context, source: 'action' }).status, 'blocked');
  assert.equal(right.resolveCommandMode('session.fork', context).status, 'pass'); assert.equal(left.catalog.getSnapshot().length, 0);
  off(); assert.equal(left.modePresentation.getSnapshot().length, 0);
});

test('real service ready/dispose, surface refcounts, ctx.effect cleanup and original DOM keyboard listener cleanup', async () => {
  const harness = load(); const effects = [], localeListeners = new Set();
  const ctx = { effect(factory) { const dispose = factory(); effects.push(dispose); return dispose; }, locale: { subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener); } } };
  const service = new harness.Service(ctx); await new Promise(resolve => setImmediate(resolve));
  let calls = 0, signals = 0;
  service.modePresentation.subscribe(() => signals++);
  const offCommand = service.register(command('session.new', 'KeyN', () => calls++)); await new Promise(resolve => setImmediate(resolve));
  const offSurface1 = service.registerCommandModeSurface('chat.branch'), offSurface2 = service.registerCommandModeSurface('chat.branch');
  assert.equal(service.commandModeSurfaces.includes('chat.branch'), true); offSurface1(); offSurface1(); assert.equal(service.commandModeSurfaces.includes('chat.branch'), true);
  const handle = service.registerCommandMode({ id: 'bot', priority: 1, commands: { 'session.new': { label: () => 'Choose Bot', resolve: () => ({ status: 'blocked', reason: 'mode' }) } } });
  await handle.ready; assert.equal(service.catalog.getSnapshot()[0].label, 'Choose Bot');
  const key = (overrides = {}) => ({ code: 'KeyN', key: 'n', metaKey: true, altKey: true, ctrlKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
    composedPath: () => [harness.document.activeElement], getModifierState: () => false, preventDefault() { this.defaultPrevented = true; }, ...overrides });
  for (const override of [{}, { isComposing: true }, { defaultPrevented: true }, { getModifierState: () => true }]) harness.window.emit('keydown', key(override));
  assert.equal(calls, 0);
  const disposed = handle.dispose(); assert.equal(handle.dispose(), disposed); await disposed;
  harness.window.emit('keydown', key()); assert.equal(calls, 1);
  const activeHandle = service.registerCommandMode({ id: 'unload', priority: 1, commands: { 'session.new': { hidden: true, resolve: () => ({ status: 'blocked', reason: 'mode' }) } } });
  await activeHandle.ready;
  for (const dispose of effects.reverse()) dispose?.();
  assert.equal(service.modePresentation.getSnapshot().length, 0); assert.deepEqual(plain(service.commandModeSurfaces), ['keyboard', 'menu']);
  assert.equal(harness.window.count(), 0); assert.equal(harness.document.count(), 0); assert.equal(localeListeners.size, 0);
  assert.deepEqual(harness.disposed(), { compositionDisposed: 1, observersDisposed: 1 });
  assert.throws(() => service.registerCommandMode({ id: 'late', priority: 1, commands: {} }), /disposed/);
  assert.throws(() => service.registerCommandModeSurface('chat.branch'), /Unsupported/);
  const finalSignals = signals; offSurface2(); await activeHandle.dispose(); assert.equal(signals, finalSignals); offCommand();
});
