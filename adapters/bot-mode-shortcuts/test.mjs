import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
const root = resolve(import.meta.dirname, '../..');
const { build } = await import(resolve(root, 'node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'));
const require = createRequire(import.meta.url);
// Unit boundary: registry algorithms use an observable-store contract test double.
// The integration runner separately exercises the served client with the native store.
const snapshot = initial => {
  let value = initial; const listeners = new Set();
  return { getSnapshot: () => value, set(next) { value = next; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
};
const compiled = await build({ entryPoints: [resolve(import.meta.dirname, 'src/client/registry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['@deepseek-ai/dsh-client-store'], nodePaths: [resolve(root, 'node_modules/.pnpm/node_modules')] });
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
  require: id => id === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore: snapshot } : require(id), crypto: globalThis.crypto });
const { ShortcutRegistry } = module.exports;
const context = { region: 'editable', modal: null, target: null };
const gesture = code => ({ code, alt: true, meta: true, shift: false, control: false, repeat: false, composing: false, defaultPrevented: false });
const command = (id, code, run) => ({ id, label: () => id, aliases: [], defaults: { 'web:macos': { code, modifiers: ['alt', 'meta'] } },
  regions: ['page', 'editable'], modals: [], resolve: () => ({ status: 'handled', run }) });
const fixture = () => {
  const registry = new ShortcutRegistry('web', 'macos'), calls = [];
  const offNew = registry.register(command('session.new', 'KeyN', () => calls.push('native-new')));
  registry.register(command('session.archive', 'KeyA', () => calls.push('native-archive')));
  registry.register(command('session.fork', 'KeyF', () => calls.push('native-fork')));
  const mode = registry.registerCommandMode({ id: 'bot', priority: 100, commands: {
    'session.new': { label: () => 'Choose Bot', resolve: () => ({ status: 'handled', run: () => calls.push('bot-new') }) },
    'session.archive': { resolve: () => ({ status: 'handled', run: () => calls.push('bot-archive') }) },
    'session.fork': { hidden: true, resolve: () => ({ status: 'blocked', reason: 'bot-mode' }) },
  } });
  return { registry, calls, mode, offNew };
};
test('keyboard and explicit menu route once; hidden Fork stays blocked and consumed', () => {
  const { registry, calls } = fixture(); let consumed = 0;
  for (const code of ['KeyN', 'KeyA', 'KeyF']) registry.dispatch(gesture(code), context, () => consumed++);
  for (const id of ['session.new', 'session.archive', 'session.fork']) registry.invoke(id, context);
  assert.deepEqual(calls, ['bot-new', 'bot-archive', 'bot-new', 'bot-archive']); assert.equal(consumed, 3);
  assert.equal(registry.catalog.getSnapshot().some(row => row.id === 'session.fork'), false);
  assert.equal(registry.catalog.getSnapshot().find(row => row.id === 'session.new').label, 'Choose Bot');
  assert.equal(registry.definitions().some(row => row.id === 'session.fork'), true);
});
test('same priority conflicts reject atomically; priorities and pass chain deterministic', () => {
  const { registry, calls } = fixture();
  assert.throws(() => registry.registerCommandMode({ id: 'conflict', priority: 100, commands: { 'session.new': { resolve: () => ({ status: 'pass' }) } } }), /Conflicting/);
  const off = registry.registerCommandMode({ id: 'higher', priority: 200, commands: { 'session.new': { label: () => 'Higher', resolve: () => ({ status: 'pass' }) } } });
  registry.dispatch(gesture('KeyN'), context, () => {}); assert.deepEqual(calls, ['bot-new']);
  assert.equal(registry.catalog.getSnapshot().find(row => row.id === 'session.new').label, 'Higher');
  off(); assert.equal(registry.catalog.getSnapshot().find(row => row.id === 'session.new').label, 'Choose Bot');
});
test('disposal recomputes live command registrations and current preferences', () => {
  const { registry, calls, mode, offNew } = fixture();
  const current = registry.config.getSnapshot();
  registry.configure({ ...current, revision: 'updated', sequence: current.sequence + 1,
    document: { schemaVersion: 1, profiles: { 'web:macos': { 'session.archive': { code: 'KeyB', modifiers: ['alt', 'meta'] } } } } });
  offNew(); registry.register(command('session.new', 'KeyN', () => calls.push('replacement-new')));
  mode(); mode();
  registry.dispatch(gesture('KeyN'), context, () => {}); registry.dispatch(gesture('KeyA'), context, () => {});
  registry.dispatch(gesture('KeyB'), context, () => {}); registry.invoke('session.fork', context);
  assert.deepEqual(calls, ['replacement-new', 'native-archive', 'native-fork']);
  assert.equal(registry.config.getSnapshot().revision, 'updated');
  assert.equal(registry.catalog.getSnapshot().find(row => row.id === 'session.new').label, 'session.new');
});
test('input composition, locally consumed keys, repeats, and modal ownership remain native', () => {
  const { registry, calls } = fixture(); let consumed = 0;
  for (const override of [{ composing: true }, { defaultPrevented: true }]) assert.equal(registry.dispatch({ ...gesture('KeyN'), ...override }, context, () => consumed++).status, 'pass');
  assert.equal(registry.dispatch(gesture('KeyN'), { ...context, modal: 'other' }, () => consumed++).status, 'blocked');
  registry.dispatch({ ...gesture('KeyN'), repeat: true }, context, () => consumed++);
  assert.deepEqual(calls, []); assert.equal(consumed, 2);
});
test('modes are window local and do not resurrect unloaded commands', () => {
  const left = fixture(), right = fixture(); right.mode(); left.offNew();
  left.mode(); assert.equal(left.registry.dispatch(gesture('KeyN'), context, () => {}).status, 'pass');
  right.registry.dispatch(gesture('KeyN'), context, () => {}); assert.deepEqual(right.calls, ['native-new']);
});
test('mode-only action resolution and presentation are live while native command is unregistered', () => {
 const registry=new ShortcutRegistry('web','macos');let signals=0;registry.modePresentation.subscribe(()=>signals++);
 const off=registry.registerCommandMode({id:'chat-policy',priority:10,commands:{'session.fork':{hidden:true,resolve:()=>({status:'blocked',reason:'bot-mode'})}}});
 assert.equal(registry.resolveCommandMode('session.fork',{...context,source:'action'}).status,'blocked');
 assert.equal(registry.modePresentation.getSnapshot()[0].hidden,true);assert.equal(registry.catalog.getSnapshot().length,0);
 off();assert.equal(registry.resolveCommandMode('session.fork',context).status,'pass');assert.equal(registry.modePresentation.getSnapshot().length,0);assert.ok(signals>=2);
});
test('native Chat surface acknowledgement notifies even with empty mode presentation', async () => {
 const { readFile }=await import('node:fs/promises');const client=await readFile(resolve(root,'.dsh-dev/bot-mode-adapter/package/lib/client.js'),'utf8');let api;
 runInNewContext(client,{window:{__ModuleLoader__:{load:({factory})=>{api=factory(id=>id==='@deepseek-ai/cordis'?{Service:class{}}:id==='@deepseek-ai/dsh-client-store'?{createSnapshotStore:snapshot}:{});}}},console,crypto:globalThis.crypto});
 const service=Object.create(api.default.prototype);service.active=true;service.modeSurfaces=new Map();service.registry=new ShortcutRegistry('web','macos');let signals=0;service.registry.modePresentation.subscribe(()=>signals++);
 assert.equal(service.commandModeSurfaces.includes('chat.branch'),false);
 const off=service.registerCommandModeSurface('chat.branch');assert.equal(service.commandModeSurfaces.includes('chat.branch'),true);assert.equal(signals,1);
 off();off();assert.equal(service.commandModeSurfaces.includes('chat.branch'),false);assert.equal(signals,2);
});
