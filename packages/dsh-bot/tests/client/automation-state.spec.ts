import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { createRoutineActions } from '../../src/client/automation-state.js';
import type { RoutineRecord, RunRecord } from '../../src/shared/automation.js';
import { Config } from '../../src/client/config.js';
import { remoteDouble } from './helpers.js';
async function fixture(test: (f: { ctx: Context; remote: ReturnType<typeof remoteDouble>; actions: ReturnType<typeof createRoutineActions> }) => Promise<void>) {
  const ctx = new Context(); const remote = remoteDouble();
  ctx.provide('remote.dshBot.routine', remote.routine); ctx.provide('remote.dshBot.run', remote.run); ctx.provide('remote.dshBot.automation', remote.automation);
  const actions = createRoutineActions(ctx, { routineHistoryPageSize: 2 });
  try { await test({ ctx, remote, actions }); } finally { await ctx.fiber.dispose(); }
}
describe('Routine catalogs', () => {
  it('reads latest manual runs independently of the scheduled cursor receipt and discards stale catalog responses', async () => fixture(async ({ remote, actions }) => {
    const record = { id: 'routine', lastRunId: 'old-scheduled' } as RoutineRecord;
    remote.data.routines = [record]; remote.data.runs = [{ id: 'new-manual', routineId: 'routine', status: 'waiting_approval' } as RunRecord];
    await actions.catalog.refresh(); expect(actions.catalog.getSnapshot().lastRuns[0]?.id).toBe('new-manual');
    let release!: (value: Awaited<ReturnType<typeof remote.routine.list>>) => void;
    remote.routine.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = actions.catalog.refresh(); await vi.waitFor(() => expect(release).toBeDefined());
    remote.data.routines = [];
    await actions.catalog.refresh(); release({ ok: true, value: [record] }); await old;
    expect(actions.catalog.getSnapshot().routines).toEqual([]);
  }));
  it('pages using the returned cursor, refreshes all requested pages and releases reads on dispose', async () => fixture(async ({ remote, actions }) => {
    const rows = [5, 4, 3].map(number => ({ id: `run-${number}`, requestedAt: number, routineId: 'r' }) as RunRecord);
    remote.run.list.mockImplementation(async options => ({ ok: true, value: rows.filter(row => !options.before || row.requestedAt < options.before.requestedAt).slice(0, options.limit) }));
    const history = actions.history('r');
    await history.refresh(); expect(history.getSnapshot().runs).toHaveLength(2); expect(history.getSnapshot().more).toBe(true);
    await history.loadMore(); expect(history.getSnapshot().runs).toHaveLength(3); expect(history.getSnapshot().more).toBe(false);
    expect(remote.run.list).toHaveBeenCalledWith({ routineId: 'r', limit: 2, before: { id: 'run-4', requestedAt: 4 } });
    history.dispose(); const calls = remote.run.list.mock.calls.length; await history.refresh(); expect(remote.run.list).toHaveBeenCalledTimes(calls);
  }));
  it('validates the configurable page size and rejects writes after owner unload', async () => fixture(async ({ ctx, actions, remote }) => {
    expect(Config({}).routineHistoryPageSize).toBe(50);
    for (const value of [0, 201, 1.5]) expect(() => Config({ routineHistoryPageSize: value })).toThrow();
    await ctx.fiber.dispose(); await expect(actions.runNow('r', 'op')).rejects.toMatchObject({ code: 'automation/unavailable' });
    expect(remote.routine.runNow).not.toHaveBeenCalled();
  }));
});
