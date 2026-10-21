import type {} from '@deepseek-ai/dsh-api-remotes';
import type {} from '@deepseek-ai/dsh-schedule';
import type { Context } from '@deepseek-ai/cordis';
import type { TypertRemoteNamespaceMap, RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { ScheduleCatalogEntry, ScheduleDeliveryRecord, ScheduleUpdateRequest, ScheduleRecord } from '@deepseek-ai/dsh-schedule/client';
import type {} from '@deepseek-ai/dsh-schedule/remote';
import type { AutomationRemoteMethods } from '../shared/automation-contract.js';
import type { ScheduleBinding, LegacyEntry } from '../shared/native-schedule.js';
import { createPollingCatalog, type BotCatalogOptions, type PollingCatalog } from './state.js';
export type NativeTask = ScheduleCatalogEntry & ScheduleBinding;
export interface AutomationData { routines: NativeTask[]; legacy: LegacyEntry[]; legacyUnavailable: boolean; legacySkipped: number; nativeAvailable: boolean }
export interface RoutineActions {
  catalog: PollingCatalog<AutomationData>;
  update(record: NativeTask, patch: Pick<ScheduleUpdateRequest, 'title' | 'prompt' | 'change'>): Promise<void>;
  remove(record: NativeTask): Promise<void>;
  deleteLegacy(id: string): Promise<void>;
  runNow(record: NativeTask, operationId: string): Promise<void>;
  history(record: NativeTask): PollingCatalog<{ records: ScheduleDeliveryRecord[]; more: boolean; unavailable: boolean }> & { loadMore(): Promise<void> };
}
const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
export function expectedRecord(task: NativeTask): ScheduleRecord {
  const { sessionId: _s, status: _t, lastDelivery: _l, botId: _b, botCreatedAt: _c, nativeScheduleId: _n, ...record } = task;
  return record;
}
export function createRoutineActions(ctx: Context, options: BotCatalogOptions & { routineHistoryPageSize?: number }): RoutineActions {
  const pageSize = options.routineHistoryPageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('Invalid delivery history page size');
  const own = () => ctx.get('remote.dshBot.nativeSchedule') as AutomationRemoteMethods<'dshBot.nativeSchedule'>;
  const native = () => ctx.get('remote.schedule') as TypertRemoteNamespaceMap['schedule'];
  const catalog = createPollingCatalog<AutomationData>(ctx, { routines: [], legacy: [], legacyUnavailable: false, legacySkipped: 0, nativeAvailable: false }, async () => {
    // Reconcile first so task creation and its sidecar cannot race this catalog read.
    const aggregate = unwrap(await own().aggregate());
    const tasks = aggregate.nativeAvailable ? unwrap(await native().catalog()) : [];
    const routines = tasks.flatMap(task => {
      const binding = aggregate.bindings.find(row => row.nativeScheduleId === task.id && row.sessionId === task.sessionId);
      return binding ? [{ ...binding, ...task }] : [];
    });
    return { routines, legacy: aggregate.legacy, legacyUnavailable: aggregate.legacyUnavailable, legacySkipped: aggregate.legacySkipped, nativeAvailable: aggregate.nativeAvailable };
  }, options);
  const histories = new Set<() => Promise<void>>();
  ctx.effect(() => ctx.remote.$on('schedule/changed', () => {
    void catalog.refresh(); for (const refresh of histories) void refresh();
  }), 'dsh-bot: native catalog changes');
  // The shared polling scheduler also refreshes on connection/reset and visibility.
  const write = async <T,>(action: () => Promise<RemoteResult<T>>, validate?: (value: T) => void) => {
    const result = await action(); await catalog.refresh(); const value = unwrap(result); validate?.(value);
  };
  return {
    catalog,
    update: (record, patch) => write(() => native().update({ id: record.id, sessionId: record.sessionId, expected: expectedRecord(record), ...patch }), value => {
      if (!('record' in value)) throw value;
    }),
    remove: record => write(() => native().delete({ id: record.id, sessionId: record.sessionId }), value => {
      if (!value.deleted) throw value;
    }),
    deleteLegacy: id => write(() => own().deleteLegacy(id)),
    runNow: (record, operationId) => write(() => own().runNow(record.id, operationId,
      { title: record.title, prompt: record.prompt, botCreatedAt: record.botCreatedAt }, true), value => {
        if (value.status !== 'delivered') throw Object.assign(new Error('Delivery not confirmed'), { code: 'automation/unavailable' });
      }),
    history(record) {
      let pages = 1;
      const history = createPollingCatalog(ctx, { records: [] as ScheduleDeliveryRecord[], more: false, unavailable: false }, async () => {
        const records: ScheduleDeliveryRecord[] = []; let before: ScheduleDeliveryRecord['messageId'] | undefined;
        let more = false; let unavailable = false;
        for (let page = 0; page < pages; page++) {
          const value = unwrap(await native().history({ id: record.id, sessionId: record.sessionId, limit: pageSize, ...(before ? { before } : {}) }));
          if ('code' in value) { if (value.code === 'delivery_cursor_not_found') pages = 1; throw value; }
          records.push(...value.records); before = value.nextBefore; more = Boolean(before);
          unavailable ||= value.earlierRecordsUnavailable || value.earlierRecordsPruned;
          if (!more) break;
        }
        return { records, more, unavailable };
      }, options);
      histories.add(history.refresh);
      return { ...history, dispose() { histories.delete(history.refresh); history.dispose(); },
        loadMore: async () => { pages++; await history.refresh(); } };
    },
  };
}
