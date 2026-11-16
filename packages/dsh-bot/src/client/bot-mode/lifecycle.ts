/** The adapter owns command arbitration; no DOM keyboard interception or
 * mutation of another plugin's registry. Every registration is reversible. */
export interface CommandMode {
  id: string; priority: number;
  commands: Readonly<Record<string, { label?: () => string; hidden?: boolean; resolve(context: unknown):
    { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } }>>;
}
export interface CommandModeHandle { ready: Promise<void>; dispose(): Promise<void> }
export interface CommandModeService {
  readonly commandModeSurfaces: readonly string[];
  readonly modePresentation: { getSnapshot(): readonly { id: string; hidden: boolean; label?: string }[]; subscribe(listener: () => void): () => void };
  resolveCommandMode(id: string, context: unknown): { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } | { status: 'pass' };
  registerCommandMode(mode: CommandMode): CommandModeHandle;
}
export const BOT_MODE_COMMANDS = ['session.new', 'session.search', 'session.rename', 'session.fork', 'session.archive', 'workspace.add'] as const;
export interface ModeSnapshot { state: 'off' | 'starting' | 'ready' | 'failed'; reason?: string }
export function createModeLifecycle(options: {
  service(): CommandModeService | undefined;
  install(): () => void | Promise<void>;
  newBot(): void; search(): void; blocked(): string; newLabel?(): string; searchLabel?(): string;
}) {
  let snapshot: ModeSnapshot = { state: 'off' }, handle: CommandModeHandle | undefined, release: (() => void | Promise<void>) | undefined;
  let epoch = 0, disposed = false, prepared = false, pending: Promise<void> | undefined, teardown: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (state: ModeSnapshot) => { snapshot = state; for (const listener of listeners) listener(); };
  const clear = (): Promise<void> => {
    // Detach the old generation before awaiting its UI disposer. A new prepare
    // must wait for both UI and command cleanup before reusing the mode ID.
    const previousRelease = release, previousHandle = handle, previousTeardown = teardown;
    release = undefined; handle = undefined; prepared = false;
    if (!previousRelease && !previousHandle) return previousTeardown ?? Promise.resolve();
    const task = (async () => {
      await previousTeardown;
      try { await previousRelease?.(); }
      finally { await previousHandle?.dispose(); }
    })().finally(() => { if (teardown === task) teardown = undefined; });
    teardown = task; return task;
  };
  const prepare = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Bot mode disposed'));
    if (prepared) return Promise.resolve();
    if (pending) return pending;
    const generation = ++epoch;
    const task = (async () => {
      publish({ state: 'starting' });
      try {
        await teardown;
        if (disposed || generation !== epoch) return;
        const service = options.service();
        if (!service || typeof service.registerCommandMode !== 'function') throw new Error('command-mode-unavailable');
        // Chat's message footer forks directly at an exact turn boundary. Only
        // a host that hides and rechecks that action can enter complete mode.
        if (!service.commandModeSurfaces?.includes('chat.branch') || !service.modePresentation
          || typeof service.resolveCommandMode !== 'function') throw new Error('chat-action-mode-unavailable');
        // Implicit workspace reconnect must preserve a persisted blank Bot's
        // native preset before mode navigation may depend on its binding.
        if (!service.commandModeSurfaces.includes('workspace.blank-preset')) throw new Error('workspace-blank-preset-unavailable');
        const commands: CommandMode['commands'] = Object.fromEntries(BOT_MODE_COMMANDS.map(id => [id, {
          ...(id === 'session.new' && options.newLabel ? { label: options.newLabel } : id === 'session.search' && options.searchLabel ? { label: options.searchLabel } : {}),
          hidden: id !== 'session.new' && id !== 'session.search',
          resolve: () => id === 'session.new' ? { status: 'handled' as const, run: options.newBot }
            : id === 'session.search' ? { status: 'handled' as const, run: options.search }
            : { status: 'blocked' as const, reason: options.blocked() },
        }]));
        const next = service.registerCommandMode({ id: 'dsh-bot.bot-mode', priority: 100, commands });
        handle = next;
        await next.ready;
        if (disposed || generation !== epoch) return;
        prepared = true;
      } catch (error) {
        if (generation !== epoch || disposed) return;
        await clear();
        if (disposed || generation !== epoch) return;
        publish({ state: 'failed', reason: error instanceof Error ? error.message : 'unavailable' });
        throw error;
      }
    })().finally(() => { if (pending === task) pending = undefined; });
    pending = task; return task;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    prepare,
    async enable() {
      const preparing = prepare(), generation = epoch;
      await preparing;
      if (disposed || generation !== epoch || !prepared) return;
      if (release) return;
      try { release = options.install(); publish({ state: 'ready' }); }
      catch (error) { await clear(); if (!disposed && generation === epoch) publish({ state: 'failed', reason: 'layout-unavailable' }); throw error; }
    },
    async fail(reason: string) { const generation = ++epoch; pending = undefined; await clear(); if (!disposed && generation === epoch) publish({ state: 'failed', reason }); },
    async disable() { const generation = ++epoch; pending = undefined; await clear(); if (!disposed && generation === epoch) publish({ state: 'off' }); },
    async dispose() { disposed = true; ++epoch; pending = undefined; try { await clear(); } finally { listeners.clear(); } },
  };
}
export type ModeLifecycle = ReturnType<typeof createModeLifecycle>;
