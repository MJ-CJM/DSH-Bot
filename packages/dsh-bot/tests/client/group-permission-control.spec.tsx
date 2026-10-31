// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { RiskConfirmationProps } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { createGroupPermissionState, type GroupPermissionState } from '../../src/client/group-permission-state.js';
import { GroupPermissionControl } from '../../src/client/components/GroupPermissionControl.js';
import labels from '../../../../docs/implementation/v061-permission-locales.json';

// Bridge tests use the public primitive's controlled checkbox contract. Native
// modal focus, CSS, keyboard dismissal and portal placement need browser proof.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => ({
  ...await import('./platform-primitives.js'),
  RiskConfirmation: (props: RiskConfirmationProps) => props.open && <div role="dialog" aria-label={props.title}>
    <p>{props.description}</p><label><input type="checkbox" checked={props.acknowledged} disabled={props.disabled}
      onChange={event => props.onAcknowledgedChange(event.currentTarget.checked)} />{props.acknowledgeLabel}</label>
    <button type="button" onClick={props.onCancel}>{props.cancelLabel}</button>
    <button type="button" disabled={props.disabled || !props.acknowledged} onClick={props.onConfirm}>{props.confirmLabel}</button>
  </div>,
}));

const catalog: PermissionCatalog = { defaultPreset: 'workspace-write', defaultOptions: [], options: [
  { value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'Workspace Write' },
  { value: 'danger-full-access', name: 'Full access' }, { value: 'auto', name: 'Auto review' },
] };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function observable<T>(initial: T) {
  let value = initial; const listeners = new Set<() => void>();
  return { getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: T) => { value = next; for (const listener of listeners) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

function fixture(rootSessionId = 'group-root-one', owner?: Context) {
  const projection = observable<PermissionSelection | undefined>({ currentValue: 'workspace-write' });
  const generation = observable<{ id: number } | undefined>({ id: 1 });
  const catalogRead = vi.fn(async () => ({ ok: true as const, value: catalog }));
  const command = vi.fn(async (_sessionId: string, _line: string, _attachments: unknown[]): Promise<RemoteResult<{
    commandId: string; result: { kind: 'success' | 'error'; text?: string };
  } | undefined>> => ({ ok: true, value: { commandId: 'native-command', result: { kind: 'success' } } }));
  const release = vi.fn();
  const retain = vi.fn(() => ({ release, ready: Promise.resolve({ session: { projections: { faceOf: () => projection } } }) }));
  const events = new Map<string, () => void>();
  const stops = new Set<() => void>();
  const ctx = {
    get: (name: string) => name === 'connection' ? { generation } : name === 'remote.permissionPresets'
      ? { catalog: catalogRead } : name === 'remote.commands' ? { execute: command } : undefined,
    sessions: { retain },
    remote: { $on: (name: string, handler: () => void) => {
      events.set(name, handler); return () => { events.delete(name); };
    } },
    effect: owner ? owner.effect.bind(owner) : (setup: () => () => void) => {
      const cleanup = setup(); const stop = () => { if (stops.delete(stop)) cleanup(); };
      stops.add(stop); return stop;
    },
  } as unknown as Context;
  const state = createGroupPermissionState(ctx, rootSessionId);
  cleanups.push(() => { state.dispose(); for (const stop of stops) stop(); });
  return { state, ctx, projection, generation, command, catalogRead, retain, release, events, stops };
}
async function settle() { await act(async () => {}); }
async function mount(language: 'en' | 'zh' = 'en') {
  const f = fixture();
  const element = document.createElement('div'); document.body.append(element);
  const root: Root = createRoot(element);
  cleanups.push(async () => { await act(async () => root.unmount()); element.remove(); });
  const t = ((key: keyof typeof labels.en) => labels[language][key]) as PropsLocale<'dsh-bot'>['t'];
  const render = async (state: GroupPermissionState = f.state, disabled = false) => {
    await act(async () => root.render(<GroupPermissionControl state={state} disabled={disabled} t={t} />));
  };
  const click = async (text: string) => {
    const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text);
    if (!button) throw new Error(`Missing button: ${text}`);
    await act(async () => button.click());
  };
  const trigger = () => { const value = element.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]'); if (!value) throw new Error('Missing permission trigger'); return value; };
  const open = async () => { await act(async () => trigger().click()); };
  const acknowledge = async () => { const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]'); if (!input) throw new Error('Missing acknowledgement'); await act(async () => input.click()); };
  await render();
  return { ...f, root, element, t, render, click, trigger, open, acknowledge };
}

describe('group permission bridge', () => {
  it('reads optional native namespaces through public lookup in a real Cordis consumer scope', async () => {
    const owner = new Context(); cleanups.push(async () => { await owner.fiber.dispose(); });
    const f = fixture(); await settle(); f.state.dispose();
    const provider = owner.plugin({ name: 'permission-namespace-provider', apply(ctx: Context) {
      new class extends Service {
        constructor() { super(ctx, 'remote'); }
        $on = (_event: string, _listener: () => void) => () => {};
      }();
      new class extends Service {
        constructor() { super(ctx, 'remote.permissionPresets'); }
        catalog = f.catalogRead;
      }();
      new class extends Service {
        constructor() { super(ctx, 'remote.commands'); }
        execute = f.command;
      }();
      ctx.provide('connection', { generation: f.generation });
      ctx.provide('sessions', { retain: f.retain });
    } });
    await provider;
    let bridge: GroupPermissionState | undefined;
    let consumerContext: Context | undefined;
    const consumer = owner.plugin({ name: 'group-permission-consumer', inject: ['remote', 'sessions'], apply(ctx: Context) {
      consumerContext = ctx;
      bridge = createGroupPermissionState(ctx, 'group-root-scoped');
    } });
    await consumer; await settle();
    // Native ui-permission declares these injected namespaces; Bots treats
    // them as optional. A literal nested object double hid this runtime gate.
    expect(() => consumerContext?.remote.permissionPresets).toThrow(/without inject/);
    expect(() => consumerContext?.remote.commands).toThrow(/without inject/);
    expect(bridge?.store.getSnapshot()).toMatchObject({ loadError: false, currentValue: 'workspace-write', catalog });
    expect(await bridge?.select('read-only')).toBe(true);
    expect(f.command).toHaveBeenCalledExactlyOnceWith('group-root-scoped', '/permission read-only', []);
    bridge?.dispose();
  });
  it.each(['en', 'zh'] as const)('%s displays only the native projection and uses the root command writer', async language => {
    const f = await mount(language);
    expect(f.trigger().textContent).toContain(f.t('groups.permissionWorkspaceWrite'));
    expect(f.retain).toHaveBeenCalledExactlyOnceWith('group-root-one', { source: 'dshBotGroupPermission' });
    await f.open(); await f.click(f.t('groups.permissionReadOnly'));
    expect(f.command).toHaveBeenCalledExactlyOnceWith('group-root-one', '/permission read-only', []);
    expect(f.trigger().textContent).toContain(f.t('groups.permissionWorkspaceWrite'));
    await act(async () => f.projection.set({ currentValue: 'read-only' }));
    expect(f.trigger().textContent).toContain(f.t('groups.permissionReadOnly'));
  });
  it.each(['danger-full-access', 'auto'])('requires acknowledgement and cancellation never executes %s', async preset => {
    const f = await mount(); await f.open(); await f.click(f.t(preset === 'auto' ? 'groups.permissionAuto' : 'groups.permissionFull'));
    const enable = f.t(preset === 'auto' ? 'groups.permissionAutoEnable' : 'groups.permissionFullEnable');
    expect(f.element.querySelector('[role="dialog"]')).not.toBeNull();
    const confirm = [...f.element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === enable);
    expect(confirm?.disabled).toBe(true);
    await f.click(enable); expect(f.command).not.toHaveBeenCalled();
    await f.acknowledge(); await f.click(f.t('groups.permissionCancel')); expect(f.command).not.toHaveBeenCalled();
    await f.open(); await f.click(f.t(preset === 'auto' ? 'groups.permissionAuto' : 'groups.permissionFull'));
    expect(f.element.querySelector<HTMLInputElement>('input')?.checked).toBe(false);
    await f.acknowledge(); await f.click(enable);
    expect(f.command).toHaveBeenCalledExactlyOnceWith('group-root-one', `/permission ${preset}`, []);
  });
  it('refuses a dangerous write without acknowledgement even through the imperative bridge', async () => {
    const f = fixture(); await settle();
    expect(await f.state.select('danger-full-access')).toBe(false);
    expect(await f.state.select('auto')).toBe(false);
    expect(f.command).not.toHaveBeenCalled();
  });
  it('revokes a risk acknowledgement on catalog invalidation and allows an explicit retry after failure', async () => {
    const f = await mount(); await f.open(); await f.click(f.t('groups.permissionFull')); await f.acknowledge();
    f.catalogRead.mockRejectedValueOnce(new Error('offline'));
    await act(async () => f.events.get('permission-presets/catalog-changed')?.());
    expect(f.element.querySelector('[role="dialog"]')).toBeNull(); expect(f.trigger().disabled).toBe(true);
    expect(f.element.textContent).toContain(f.t('groups.permissionLoadFailed')); expect(f.command).not.toHaveBeenCalled();
    await f.click(f.t('groups.permissionRetry')); expect(f.trigger().disabled).toBe(false);
    await f.open(); await f.click(f.t('groups.permissionFull'));
    expect(f.element.querySelector<HTMLInputElement>('input')?.checked).toBe(false);
  });
  it('hides the control when the permissions projection is absent', async () => {
    const f = await mount(); await act(async () => f.projection.set(undefined));
    expect(f.element.querySelector('button[aria-haspopup="menu"]')).toBeNull();
    expect(await f.state.select('read-only')).toBe(false); expect(f.command).not.toHaveBeenCalled();
  });
  it('offers only Host catalog entries and refuses a mode removed from that catalog', async () => {
    const f = await mount();
    f.catalogRead.mockResolvedValueOnce({ ok: true, value: { ...catalog,
      options: catalog.options.filter(option => option.value !== 'read-only') } });
    await act(async () => f.state.refresh()); await f.open();
    const choices = [...f.element.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);
    expect(choices).not.toContain(f.t('groups.permissionReadOnly'));
    expect(await f.state.select('read-only')).toBe(false); expect(f.command).not.toHaveBeenCalled();
  });
  it('keeps the native value after a rejected command and retries only through a fresh user selection', async () => {
    const f = await mount(); f.command.mockResolvedValueOnce({ ok: true, value: { commandId: 'failed-command', result: { kind: 'error', text: 'unknown preset' } } });
    await f.open(); await f.click(f.t('groups.permissionReadOnly'));
    expect(f.trigger().textContent).toContain(f.t('groups.permissionWorkspaceWrite'));
    expect(f.element.textContent).toContain(f.t('groups.permissionSaveFailed'));
    await f.open(); await f.click(f.t('groups.permissionReadOnly'));
    expect(f.command).toHaveBeenCalledTimes(2); expect(f.element.textContent).not.toContain(f.t('groups.permissionSaveFailed'));
  });
  it('treats a missing native command as a failed switch without changing the projection', async () => {
    const f = fixture(); await settle(); f.command.mockResolvedValueOnce({ ok: true, value: undefined });
    expect(await f.state.select('read-only')).toBe(false);
    expect(f.state.store.getSnapshot()).toMatchObject({ currentValue: 'workspace-write', saving: false, saveError: true });
  });
  it('drops an open confirmation when the group switches and disposes every old subscription', async () => {
    const f = await mount(); await f.open(); await f.click(f.t('groups.permissionFull')); await f.acknowledge();
    const second = fixture('group-root-two'); await f.render(second.state);
    expect(f.element.querySelector('[role="dialog"]')).toBeNull();
    f.state.dispose(); expect(f.release).toHaveBeenCalledOnce(); expect(f.events.size).toBe(0);
    expect(f.stops.size).toBe(0); expect(f.generation.listenerCount).toBe(0); expect(f.projection.listenerCount).toBe(0);
    expect(await f.state.select('danger-full-access', true)).toBe(false);
    await f.open(); await f.click(f.t('groups.permissionReadOnly'));
    expect(second.command).toHaveBeenCalledExactlyOnceWith('group-root-two', '/permission read-only', []); expect(f.command).not.toHaveBeenCalled();
  });
  it('removes the real Cordis owner effect across repeated group mount/unmount cycles', async () => {
    const owner = new Context(); cleanups.push(async () => { await owner.fiber.dispose(); });
    const baseline = owner.fiber.getEffects().length;
    for (let index = 0; index < 20; index++) {
      const f = fixture(`group-root-${index}`, owner); await settle();
      expect(owner.fiber.getEffects()).toHaveLength(baseline + 1);
      f.state.dispose(); f.state.dispose();
      expect(owner.fiber.getEffects()).toHaveLength(baseline);
      expect(f.release).toHaveBeenCalledOnce(); expect(f.events.size).toBe(0);
      expect(f.generation.listenerCount).toBe(0); expect(f.projection.listenerCount).toBe(0);
    }
  });
  it('ignores catalog settlements from a previous connection generation and after disposal', async () => {
    const f = fixture(); await settle();
    let resolve!: (value: Awaited<ReturnType<typeof f.catalogRead>>) => void;
    f.catalogRead.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = f.state.refresh();
    f.generation.set({ id: 2 }); await settle();
    const current = f.state.store.getSnapshot();
    resolve({ ok: true, value: { ...catalog, options: [{ value: 'stale', name: 'Stale mode' }] } }); await pending;
    expect(f.state.store.getSnapshot()).toBe(current);
    f.state.dispose(); f.projection.set({ currentValue: 'danger-full-access' });
    f.generation.set({ id: 3 }); expect(f.state.store.getSnapshot()).toBe(current);
  });
  it('ignores a late command receipt after reconnecting to the same root', async () => {
    const f = fixture(); await settle();
    let resolve!: (value: Awaited<ReturnType<typeof f.command>>) => void;
    f.command.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = f.state.select('read-only'); expect(f.state.store.getSnapshot().saving).toBe(true);
    f.generation.set({ id: 2 }); await settle();
    resolve({ ok: true, value: { commandId: 'native-command', result: { kind: 'success' } } }); expect(await pending).toBe(false);
    expect(f.state.store.getSnapshot()).toMatchObject({ saving: false, saveError: false, currentValue: 'workspace-write' });
  });
});
