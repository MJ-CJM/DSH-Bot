import type { Context } from '@deepseek-ai/cordis';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { RoutineCreate, RoutinePatch, RoutineRecord, RunRecord } from '../shared/automation.js';
import type { AutomationStatus, AutomationRemoteMethods } from '../shared/automation-contract.js';
import { createPollingCatalog, type BotCatalogOptions, type PollingCatalog } from './state.js';

export interface AutomationData { routines: RoutineRecord[]; lastRuns: RunRecord[]; status?: AutomationStatus }
export interface RoutineActions {
  catalog: PollingCatalog<AutomationData>;
  create(input: RoutineCreate): Promise<void>;
  update(record: RoutineRecord, patch: RoutinePatch): Promise<void>;
  remove(record: RoutineRecord): Promise<void>;
  runNow(id: string, operationId: string): Promise<void>;
  history(id: string): PollingCatalog<{ runs: RunRecord[]; more: boolean }> & { loadMore(): Promise<void> };
}
const unwrap = <T>(result: RemoteResult<T>): T => { if (!result.ok) throw result.error; return result.value; };
export function createRoutineActions(ctx: Context, options: BotCatalogOptions & { routineHistoryPageSize?: number }): RoutineActions {
  const pageSize = options.routineHistoryPageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new TypeError('Invalid Routine history page size');
  let active = true;
  ctx.effect(() => () => { active = false; }, 'dsh-bot: routine actions');
  const remote = <N extends 'routine' | 'run' | 'automation'>(name: N): AutomationRemoteMethods<`dshBot.${N}`> => {
    const service = ctx.get(`remote.dshBot.${name}`);
    if (!active || !service) throw { code: 'automation/unavailable', message: '' };
    return service as AutomationRemoteMethods<`dshBot.${N}`>;
  };
  const catalog = createPollingCatalog<AutomationData>(ctx, { routines: [], lastRuns: [] }, async () => {
    const status = unwrap(await remote('automation').status());
    if (status.state !== 'ready') return { routines: [], lastRuns: [], status };
    const routines = unwrap(await remote('routine').list({}));
    // lastRunId is the scheduled cursor receipt; manual runs also count here.
    const lastRuns = (await Promise.all(routines.map(async routine =>
      unwrap(await remote('run').list({ routineId: routine.id, limit: 1 }))))).flat();
    return { routines, lastRuns, status };
  }, options);
  const write = async (action: () => Promise<RemoteResult<unknown>>) => {
    const result = await action();
    // Also refresh conflicts without overwriting the editor's draft/revision.
    await catalog.refresh();
    unwrap(result);
  };
  return {
    catalog,
    create: input => write(() => remote('routine').create(input)),
    update: (record, patch) => write(() => remote('routine').update(record.id, patch, record.revision)),
    remove: record => write(() => remote('routine').delete(record.id, record.revision)),
    runNow: (id, operationId) => write(() => remote('routine').runNow(id, operationId)),
    history(id) {
      let pages = 1;
      const history = createPollingCatalog(ctx, { runs: [] as RunRecord[], more: false }, async () => {
        const runs: RunRecord[] = [];
        let before: { requestedAt: number; id: string } | undefined;
        let more = false;
        const requestedPages = pages;
        for (let page = 0; page < requestedPages; page++) {
          const result = unwrap(await remote('run').list({ routineId: id, limit: pageSize, ...(before ? { before } : {}) }));
          runs.push(...result);
          more = result.length === pageSize;
          const last = result.at(-1);
          if (!more || !last) break;
          before = { requestedAt: last.requestedAt, id: last.id };
        }
        return { runs, more };
      }, options);
      return { ...history, loadMore: async () => { pages++; await history.refresh(); } };
    },
  };
}
