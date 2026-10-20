import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { AUTOMATION_REMOTE, type AutomationHostMethods } from '../../shared/automation-contract.js';
import type { RoutineService, RunService } from './store.js';
import type { RoutineCreate, RoutinePatch } from '../../shared/automation.js';

export const AUTOMATION_HOST = { package: 'dsh-bot/automation', face: 'host', schemas: [],
  get invocations() { return AUTOMATION_REMOTE.descriptors; }, model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
declare module '@deepseek-ai/cordis' {
  interface Context { dshBotRoutines: RoutineRemote; dshBotRuns: RunRemote }
}
export class RoutineRemote extends TypertRemoteService implements AutomationHostMethods<'dshBot.routine'> {
  constructor(ctx: Context, private readonly routines: RoutineService) { super(ctx, 'dshBotRoutines', { namespace: 'dshBot.routine' }); }
  @Remote
  async list(options: Parameters<RoutineService['list']>[0]) { return this.routines.list(options); }
  @Remote
  async get(id: string) { return this.routines.get(id); }
  @Remote
  async create(input: RoutineCreate) { return this.routines.create(input, { kind: 'user' }); }
  @Remote
  async update(id: string, patch: RoutinePatch, expectedRevision: number) { return this.routines.update(id, patch, expectedRevision); }
  @Remote
  async remove(id: string, expectedRevision: number) { return this.routines.remove(id, expectedRevision); }
}
export class RunRemote extends TypertRemoteService implements AutomationHostMethods<'dshBot.run'> {
  constructor(ctx: Context, private readonly runs: RunService) { super(ctx, 'dshBotRuns', { namespace: 'dshBot.run' }); }
  @Remote
  async list(options: Parameters<RunService['list']>[0]) { return this.runs.list(options); }
  @Remote
  async get(id: string) { return this.runs.get(id); }
}
/** Call from the owner's Host context after opening stores under its lease.
 * No reserve/transition/provenance/quota endpoints are exposed to clients. */
export function registerAutomationRemote(ctx: Context, stores: { routines: RoutineService; runs: RunService }): void {
  ctx.effect(() => ctx.typert.register(AUTOMATION_HOST), 'dsh-bot: automation contract');
  new RoutineRemote(ctx, stores.routines);
  new RunRemote(ctx, stores.runs);
}
