// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { createModeLifecycle } from '../../src/client/bot-mode/lifecycle.js';
import { botModeCapabilities } from './helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

it('waits for old asynchronous UI/command cleanup before enabling a fresh mode generation', async () => {
  const cleanup = deferred();
  let uiCount = 0, commandCount = 0;
  const register = vi.fn(() => {
    commandCount++;
    return { ready: Promise.resolve(), dispose: async () => { commandCount--; } };
  });
  const lifecycle = createModeLifecycle({
    service: () => ({ ...botModeCapabilities, registerCommandMode: register }),
    install: () => {
      const first = ++uiCount === 1;
      return async () => { if (first) await cleanup.promise; uiCount--; };
    },
    newBot() {}, search() {}, blocked: () => 'blocked',
  });
  try {
    await lifecycle.enable();
    expect(uiCount).toBe(1); expect(commandCount).toBe(1);
    const disabling = lifecycle.disable();
    const enabling = lifecycle.enable();
    await Promise.resolve(); await Promise.resolve();
    // A new generation must not claim readiness against the old command handle
    // or install another sidebar while the old sidebar disposer is pending.
    expect(uiCount).toBe(1);
    cleanup.resolve(); await Promise.all([disabling, enabling]);
    expect(lifecycle.getSnapshot().state).toBe('ready');
    expect(uiCount).toBe(1); expect(commandCount).toBe(1);
    expect(register).toHaveBeenCalledTimes(2);
  } finally { cleanup.resolve(); await lifecycle.dispose(); }
});

it('does not register the same native mode ID while cancelled command readiness is still disposing', async () => {
  const ready = deferred(), cleanup = deferred();
  let occupied = false;
  const register = vi.fn(() => {
    if (occupied) throw new Error('Duplicate command mode ID');
    occupied = true;
    const first = register.mock.calls.length === 1;
    return { ready: first ? ready.promise : Promise.resolve(), dispose: async () => {
      if (first) await cleanup.promise;
      occupied = false;
    } };
  });
  const install = vi.fn(() => () => {});
  const lifecycle = createModeLifecycle({ service: () => ({ ...botModeCapabilities, registerCommandMode: register }),
    install, newBot() {}, search() {}, blocked: () => 'blocked' });
  try {
    const initial = lifecycle.enable();
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const disabling = lifecycle.disable(), restart = lifecycle.enable();
    await Promise.resolve(); await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
    cleanup.resolve(); await Promise.all([disabling, restart]);
    expect(lifecycle.getSnapshot().state).toBe('ready');
    expect(register).toHaveBeenCalledTimes(2); expect(occupied).toBe(true);
    ready.resolve(); await initial;
    expect(install).toHaveBeenCalledTimes(1);
  } finally { ready.resolve(); cleanup.resolve(); await lifecycle.dispose(); }
  expect(occupied).toBe(false);
});

it('lets a later fail supersede an older disable without publishing a stale off state', async () => {
  const cleanup = deferred(), dispose = vi.fn(async () => {});
  const lifecycle = createModeLifecycle({ service: () => ({ ...botModeCapabilities,
    registerCommandMode: () => ({ ready: Promise.resolve(), dispose }) }),
    install: () => () => cleanup.promise, newBot() {}, search() {}, blocked: () => 'blocked' });
  const states: string[] = [];
  const unsubscribe = lifecycle.subscribe(() => states.push(lifecycle.getSnapshot().state));
  try {
    await lifecycle.enable();
    const disabling = lifecycle.disable(), failing = lifecycle.fail('service-lost');
    cleanup.resolve(); await Promise.all([disabling, failing]);
    expect(lifecycle.getSnapshot()).toEqual({ state: 'failed', reason: 'service-lost' });
    expect(states).toEqual(['starting', 'ready', 'failed']);
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally { unsubscribe(); cleanup.resolve(); await lifecycle.dispose(); }
});

it('does not prepare or reinstall after disposal overtakes a restart waiting for old cleanup', async () => {
  const cleanup = deferred(), dispose = vi.fn(async () => {}), install = vi.fn(() => () => cleanup.promise);
  const register = vi.fn(() => ({ ready: Promise.resolve(), dispose }));
  const lifecycle = createModeLifecycle({ service: () => ({ ...botModeCapabilities, registerCommandMode: register }),
    install, newBot() {}, search() {}, blocked: () => 'blocked' });
  await lifecycle.enable();
  const disabling = lifecycle.disable(), restart = lifecycle.enable(), closing = lifecycle.dispose();
  cleanup.resolve(); await Promise.all([disabling, restart, closing]);
  expect(install).toHaveBeenCalledTimes(1); expect(register).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  await expect(lifecycle.enable()).rejects.toThrow('Bot mode disposed');
});

it('finishes rejected readiness cleanup before retrying and releases each command generation once', async () => {
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((_resolve, fail) => { reject = fail; });
  const cleanup = deferred(), disposed: number[] = [];
  const register = vi.fn(() => {
    const number = register.mock.calls.length;
    return { ready: number === 1 ? ready : Promise.resolve(), dispose: async () => {
      if (number === 1) await cleanup.promise;
      disposed.push(number);
    } };
  });
  const install = vi.fn(() => () => {});
  const lifecycle = createModeLifecycle({ service: () => ({ ...botModeCapabilities, registerCommandMode: register }),
    install, newBot() {}, search() {}, blocked: () => 'blocked' });
  try {
    const failed = lifecycle.enable().catch(error => error as Error);
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    reject(new Error('Native readiness failed'));
    await Promise.resolve(); await Promise.resolve();
    expect(install).not.toHaveBeenCalled(); expect(disposed).toEqual([]);
    cleanup.resolve();
    expect(await failed).toMatchObject({ message: 'Native readiness failed' });
    expect(lifecycle.getSnapshot()).toEqual({ state: 'failed', reason: 'Native readiness failed' });
    await lifecycle.enable();
    expect(lifecycle.getSnapshot().state).toBe('ready');
    expect(register).toHaveBeenCalledTimes(2); expect(install).toHaveBeenCalledTimes(1);
  } finally { cleanup.resolve(); await lifecycle.dispose(); }
  expect(disposed).toEqual([1, 2]);
});

it('does not let an old failed UI installation clear or fail a retry that waits for its command disposal', async () => {
  const cleanup = deferred(), firstDispose = vi.fn(() => cleanup.promise);
  const register = vi.fn(() => ({ ready: Promise.resolve(), dispose: register.mock.calls.length === 1 ? firstDispose : async () => {} }));
  const install = vi.fn(() => { if (install.mock.calls.length === 1) throw new Error('UI installation failed'); return () => {}; });
  const lifecycle = createModeLifecycle({ service: () => ({ ...botModeCapabilities, registerCommandMode: register }),
    install, newBot() {}, search() {}, blocked: () => 'blocked' });
  const states: string[] = [];
  const unsubscribe = lifecycle.subscribe(() => states.push(lifecycle.getSnapshot().state));
  try {
    const initial = lifecycle.enable().catch(error => error as Error);
    await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1));
    const retry = lifecycle.enable();
    await Promise.resolve(); await Promise.resolve();
    expect(register).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    expect(await initial).toMatchObject({ message: 'UI installation failed' });
    await retry;
    expect(register).toHaveBeenCalledTimes(2); expect(install).toHaveBeenCalledTimes(2);
    expect(lifecycle.getSnapshot().state).toBe('ready');
    expect(states).toEqual(['starting', 'starting', 'ready']);
  } finally { unsubscribe(); cleanup.resolve(); await lifecycle.dispose(); }
});
