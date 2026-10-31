import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type { ISessions, SessionFace, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client';
import type {} from '@deepseek-ai/dsh-permission-presets/remote';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { dshBotGroupPermission: unknown }
}

export interface GroupPermissionSnapshot {
  catalog: PermissionCatalog | null;
  currentValue: string | undefined;
  loading: boolean;
  saving: boolean;
  loadError: boolean;
  saveError: boolean;
  /** Revokes menu choices and risk acknowledgements whenever the Host catalog changes. */
  catalogVersion: number;
}

export function requiresPermissionAcknowledgement(preset: string): boolean {
  return preset === 'danger-full-access' || preset === 'auto';
}

/** A root-session bridge to the native catalog, projection and /permission writer.
 * No settings defaults or already running child sessions are modified here.
 */
export function createGroupPermissionState(ctx: Context, rootSessionId: string) {
  let snapshot: GroupPermissionSnapshot = { catalog: null, currentValue: undefined,
    loading: false, saving: false, loadError: false, saveError: false, catalogVersion: 0 };
  const listeners = new Set<() => void>();
  const store: ObservableSnapshot<GroupPermissionSnapshot> = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      if (disposed) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
  };
  const connection = ctx.get('connection') as ConnectionHandle | undefined;
  // This repository compiles Host and Client Cordis merges together. The
  // explicit public Client face avoids the Host SessionStore name collision.
  const sessions = ctx.sessions as unknown as ISessions;
  let disposed = false, readEpoch = 0, sessionEpoch = 0, writeEpoch = 0;
  let generationId: number | undefined;
  let reference: SessionReference | undefined;
  let live: SessionFace | undefined;
  let stopProjection: (() => void) | undefined;
  const stops: (() => void)[] = [];
  const publish = (patch: Partial<GroupPermissionSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const connected = () => generationId !== undefined && connection?.generation.getSnapshot()?.id === generationId;
  const clearSession = () => {
    ++sessionEpoch;
    stopProjection?.(); stopProjection = undefined;
    reference?.release(); reference = undefined; live = undefined;
    publish({ currentValue: undefined });
  };
  const bindSession = async () => {
    clearSession();
    if (!connected() || disposed) return;
    const epoch = sessionEpoch;
    try {
      const next = sessions.retain(rootSessionId as SessionId, { source: 'dshBotGroupPermission' });
      reference = next;
      const binding = await next.ready;
      if (disposed || epoch !== sessionEpoch || !connected()) return;
      live = binding.session;
      const projection = binding.session.projections.faceOf('permissions');
      const update = () => {
        if (disposed || epoch !== sessionEpoch || !connected()) return;
        const value = projection.getSnapshot() as PermissionSelection | undefined;
        publish({ currentValue: value?.currentValue });
      };
      stopProjection = projection.subscribe(update);
      update();
    } catch {
      if (disposed || epoch !== sessionEpoch) return;
      clearSession();
      publish({ loadError: true });
    }
  };
  const refresh = async () => {
    if (disposed) return;
    const epoch = ++readEpoch, generation = generationId;
    publish({ catalog: null, loading: true, loadError: false, catalogVersion: store.getSnapshot().catalogVersion + 1 });
    try {
      if (!connected()) throw new Error('No active Host');
      // Optional native namespaces are not declared inject dependencies of the
      // Bots plugin. Public explicit lookup avoids Cordis' dotted-access gate.
      const remote = ctx.get('remote.permissionPresets') as TypertRemoteNamespaceMap['permissionPresets'] | undefined;
      if (!remote) throw new Error('Native permission catalog unavailable');
      const result = await remote.catalog();
      if (!result.ok) throw result.error;
      if (disposed || epoch !== readEpoch || generation !== generationId || !connected()) return;
      publish({ catalog: result.value, loading: false });
    } catch {
      if (disposed || epoch !== readEpoch || generation !== generationId) return;
      publish({ catalog: null, loading: false, loadError: true });
    }
    // A failed initial history open is retryable without creating an Agent turn.
    if (!disposed && !reference && connected()) await bindSession();
  };
  const select = async (preset: string, acknowledged = false): Promise<boolean> => {
    const snapshot = store.getSnapshot();
    if (disposed || !connected() || !live || snapshot.saving || snapshot.currentValue === undefined
      || !snapshot.catalog?.options.some(option => option.value === preset)
      || (requiresPermissionAcknowledgement(preset) && !acknowledged)) return false;
    if (preset === snapshot.currentValue) return true;
    const session = live, epoch = ++writeEpoch, generation = generationId;
    publish({ saving: true, saveError: false });
    try {
      // SessionFace.command intentionally exposes admission only and discards
      // handler failures. Use its same public writer to inspect the outcome.
      const remote = ctx.get('remote.commands') as TypertRemoteNamespaceMap['commands'] | undefined;
      if (!remote) throw new Error('Native command writer unavailable');
      const result = await remote.execute(rootSessionId as SessionId, `/permission ${preset}`, []);
      if (!result.ok || result.value?.result.kind !== 'success') throw new Error('Permission command rejected');
      if (disposed || epoch !== writeEpoch || session !== live || generation !== generationId || !connected()) return false;
      // Only the native permissions projection may publish the selected value.
      publish({ saving: false });
      return true;
    } catch {
      if (disposed || epoch !== writeEpoch || session !== live || generation !== generationId) return false;
      publish({ saving: false, saveError: true });
      return false;
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; ++readEpoch; ++writeEpoch;
    clearSession();
    for (const stop of stops.splice(0)) stop();
    listeners.clear();
  };
  const syncGeneration = () => {
    const next = connection?.generation.getSnapshot()?.id;
    if (disposed || next === generationId) return;
    generationId = next; ++readEpoch; ++writeEpoch;
    clearSession();
    publish({ catalog: null, loading: false, saving: false, saveError: false,
      loadError: false, catalogVersion: store.getSnapshot().catalogVersion + 1 });
    if (next !== undefined) { void bindSession(); void refresh(); }
  };
  const disposeOwner = ctx.effect(() => {
    stops.push(ctx.remote.$on('permission-presets/catalog-changed', () => { void refresh(); }));
    if (connection) stops.push(connection.generation.subscribe(syncGeneration));
    syncGeneration();
    return dispose;
  }, 'dsh-bot: group permission bridge');
  return { rootSessionId, store, refresh, select, dispose: () => { void disposeOwner(); } };
}
export type GroupPermissionState = ReturnType<typeof createGroupPermissionState>;
