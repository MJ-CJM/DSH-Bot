import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { AUTOMATION_REMOTE, type AutomationHostMethods, type AutomationStatus } from '../../shared/automation-contract.js';
import type { RunService } from './store.js';
import type { NativeSchedules } from '../native-schedule/service.js';
import type { RunRequest } from '../../shared/automation.js';
import { AutomationError } from './errors.js';
export const AUTOMATION_HOST = { package: 'dsh-bot/automation', face: 'host', schemas: [],
  get invocations() { return AUTOMATION_REMOTE.descriptors; }, model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
declare module '@deepseek-ai/cordis' {
  interface Context { dshBotNativeSchedules: NativeScheduleRemote; dshBotRuns: RunRemote; dshBotAutomation: AutomationStatusRemote }
}
export class AutomationStatusRemote extends TypertRemoteService implements AutomationHostMethods<'dshBot.automation'> {
  constructor(ctx: Context, private readonly readStatus: () => AutomationStatus) { super(ctx, 'dshBotAutomation', { namespace: 'dshBot.automation' }); }
  @Remote async status() { return this.readStatus(); }
}
export class NativeScheduleRemote extends TypertRemoteService implements AutomationHostMethods<'dshBot.nativeSchedule'> {
  constructor(ctx: Context, private readonly native: NativeSchedules, private readonly submit: (request: RunRequest) => ReturnType<RunService['enqueue']>) {
    super(ctx, 'dshBotNativeSchedules', { namespace: 'dshBot.nativeSchedule' });
  }
  @Remote async aggregate() { return this.native.aggregate(); }
  @Remote async deleteLegacy(id: string) { await this.native.deleteLegacy(id); return true; }
  @Remote async runNow(id: string, operationId: string, expected: { title: string; prompt: string; botCreatedAt: number }, approved: true) {
    if (approved !== true) throw new AutomationError('automation/invalid', 'Explicit confirmation required');
    const { binding, task } = await this.native.task(id);
    if (expected.title !== task.title || expected.prompt !== task.prompt || expected.botCreatedAt !== binding.botCreatedAt) {
      throw new AutomationError('automation/conflict', 'Task changed since confirmation');
    }
    return this.submit({ trigger: 'manual', nativeScheduleId: id, operationId, botId: binding.botId, botCreatedAt: binding.botCreatedAt,
      title: task.title, prompt: task.prompt, timeZone: 'timeZone' in task ? task.timeZone : 'UTC' });
  }
}
export class RunRemote extends TypertRemoteService implements AutomationHostMethods<'dshBot.run'> {
  constructor(ctx: Context, private readonly runs: RunService) { super(ctx, 'dshBotRuns', { namespace: 'dshBot.run' }); }
  @Remote async list(options: Parameters<RunService['list']>[0]) { return this.runs.list(options); }
  @Remote async get(id: string) { return this.runs.get(id); }
}
