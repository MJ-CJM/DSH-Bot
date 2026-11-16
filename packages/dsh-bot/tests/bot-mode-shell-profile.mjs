import '../../../scripts/deepening/network-guard.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';

// Test-only public plugin entry: never writes product sources or registers real models.
export const name = 'bot-mode-shell-profile';
export const inject = ['loader', 'llm', 'agents', 'sessions', 'dshBots', 'sessionController'];
export function apply(ctx, config) {
  ctx.effect(() => {
    let release, disposed = false;
    const run = (async () => {
      await ctx.loader.await(); await ctx.dshBots.waitUntilReady();
      assert.deepEqual(ctx.llm.listProviders(), []);
      class Adapter extends LlmAdapter {
        async listModels(provider) { return [{ provider, id: 'fixture', name: 'Shell spike synthetic model' }]; }
        async *stream() {
          const text = 'BOT_MODE_SHELL_NATIVE_REPLY';
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text };
          yield { type: 'block-end', index: 0, block: { type: 'text', text } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
      release = ctx.llm.registerAdapter(['dp-loopback'], new Adapter());
      await ctx.dshBots.create({ id: 'shell-native', name: 'Shell Native Bot', template: 'minimal',
        model: { provider: 'dp-loopback', model: 'fixture' }, memory: { enabled: false, injectLimit: 20 } });
      const main = await ctx.dshBots.openConversation('shell-native');
      const { agent } = await ctx.sessionController.resolveAgent(main.sessionId); assert.ok(agent);
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BOT_MODE_SHELL_SEED' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      await writeFile(resolve(config.outputDir, 'fixture.json'), JSON.stringify({ sessionId: main.sessionId, realModelRequests: 0 }));
      if (!disposed) console.log('B4_WEB_READY');
    })().catch(async error => {
      await writeFile(resolve(config.outputDir, 'fixture-error.json'), JSON.stringify({ error: String(error), stack: error.stack }));
      console.log('B4_WEB_FAILED');
    });
    return async () => { disposed = true; await run; release?.(); };
  }, 'bot-mode-shell: synthetic fixture');
}

/** Appended inside a copied public Client bundle's factory, only in the isolated test artifact. */
export const clientProbeSource = String.raw`
const original = module.exports;
return { ...original, inject: [...original.inject, 'shortcuts'], async apply(ctx, options) {
  console.warn('BOT_MODE_PROBE_APPLY_BEGIN');
  await original.apply(ctx, options);
  console.warn('BOT_MODE_PROBE_APPLY_READY');
  const React = require('react'), h = React.createElement;
  let modeDisposers = [], record = { mode: false, registrationErrors: {} };
  const listeners = new Set();
  const publish = () => { for (const listener of listeners) listener(); };
  const snapshot = () => JSON.stringify({ ...record,
    catalog: ctx.shortcuts.catalog.getSnapshot().filter(row => /^session\.(new|search|fork|archive)$/.test(row.id)),
    sessions: ctx.sessions.list.getSnapshot(), workspaces: ctx.workspaces.list.getSnapshot() });
  function Controls() {
    const state = React.useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot);
    const [modal, setModal] = React.useState(false);
    return h('div', { style: { pointerEvents: 'auto', background: 'var(--dsw-alias-bg-base)' }, 'data-shell-probe': '' },
      h('button', { onClick: () => install() }, 'Install shell probe'),
      h('button', { onClick: () => restore() }, 'Restore shell probe'),
      h('button', { onClick: () => setModal(!modal) }, 'Toggle probe modal'),
      h('output', { 'data-shell-state': '', style: { display: 'none' } }, state),
      modal ? h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': 'Probe modal', 'data-shortcut-modal': 'bot-mode-probe' }, 'A real modal blocks Web commands and also obscures normal input.') : null);
  }
  function Sidebar() { return h('nav', { 'data-probe-sidebar': '', 'aria-label': 'Bot mode probe' }, 'Shell Native Bot'); }
  function Leading() { return h('button', { 'data-probe-leading': '', onClick: () => ctx.layout.toggleSidebar() }, 'Show Bots'); }
  function restore() { for (const release of modeDisposers.reverse()) release(); modeDisposers = []; record.mode = false; publish(); }
  function install() {
    if (record.mode) return;
    ctx.effect(() => {
      const releases = [ctx.slots.register({ name: 'sidebar', id: 'bot-mode-shell-probe', priority: -100, locale: 'dsh-bot' }, Sidebar),
        ctx.slots.register({ name: 'shell.leading', id: 'bot-mode-leading-probe', priority: -100, locale: 'dsh-bot' }, Leading)];
      modeDisposers = releases; record.mode = true;
      const candidate = { label: () => 'Bot search', aliases: [], regions: ['page', 'editable'], modals: [],
        resolve: () => ({ status: 'handled', run: () => { record.botCommandCalls = (record.botCommandCalls ?? 0) + 1; publish(); } }) };
      for (const [name, command] of [['sameId', { ...candidate, id: 'session.new', defaults: {} }],
        ['sameBinding', { ...candidate, id: 'bot-mode.probe.new', defaults: { 'web:macos': { code: 'KeyN', modifiers: ['primary', 'alt'] } } }]]) {
        try { const release = ctx.shortcuts.register(command); releases.push(release); record.registrationErrors[name] = null; }
        catch (error) { record.registrationErrors[name] = String(error); }
      }
      publish(); return () => { for (const release of releases.reverse()) release(); };
    }, 'bot-mode-shell: temporary navigation');
  }
  try {
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => { console.warn('BOT_MODE_PROBE_INJECT_READY'); return ctx.slots.register({ name: 'shell.overlay', id: 'bot-mode-shell-controls', locale: 'dsh-bot', order: 999 }, Controls); }), 'bot-mode-shell: controls');
    ctx.effect(() => { const off = [ctx.shortcuts.catalog.subscribe(publish), ctx.sessions.list.subscribe(publish), ctx.workspaces.list.subscribe(publish)]; return () => { for (const release of off) release(); restore(); }; }, 'bot-mode-shell: observations');
    console.warn('BOT_MODE_PROBE_REGISTERED', JSON.stringify(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)));
  } catch (error) { console.error('BOT_MODE_PROBE_FAILED', error.stack ?? String(error)); throw error; }
} };
`;
