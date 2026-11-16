import { taskSupportInputSchema, taskMaterialInputSchema, taskResumeInputSchema } from '../../shared/task-materials.js';
import type { Context } from '@deepseek-ai/cordis';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SUPERGROUP_REMOTE } from '../../shared/supergroup-contract.js';
import { supergroupCatalogInputSchema, supergroupGroupInputSchema, supergroupSendGroupInputSchema, supergroupCancelInputSchema, supergroupSessionInputSchema, supergroupConfigureSchema } from '../../shared/supergroup.js';
import type { Supergroup } from './service.js';

export const SUPERGROUP_HOST = {
  package: 'dsh-bot/supergroup', face: 'host', schemas: [],
  get invocations() { return SUPERGROUP_REMOTE.descriptors; },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;

export class SupergroupRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly groups: Supergroup) {
    super(ctx, 'dshBotSupergroupRemote', { namespace: 'dshBotSupergroup' });
  }
  private owner() {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') throw new Error('Owner access required');
  }
  @Remote async taskSupport(input: unknown) { this.owner(); return this.groups.taskSupport(taskSupportInputSchema.parse(input).workId); }
  @Remote async addMaterial(input: unknown) { this.owner(); return this.groups.addMaterial(taskMaterialInputSchema.parse(input)); }
  @Remote async resumeWork(input: unknown) { this.owner(); return this.groups.resumeWork(taskResumeInputSchema.parse(input)); }
  @Remote async pendingTasks() { this.owner(); return this.groups.pendingTasks(); }
  @Remote async catalog(input: unknown) { this.owner(); return this.groups.catalog(supergroupCatalogInputSchema.parse(input)); }
  @Remote async byGroup(input: unknown) { this.owner(); return this.groups.byGroup(supergroupGroupInputSchema.parse(input).group); }
  @Remote async sendGroupInput(input: unknown) { this.owner(); return this.groups.sendGroupInput(supergroupSendGroupInputSchema.parse(input)); }
  @Remote async forSession(input: unknown) {
    this.owner();
    return this.groups.forSession(supergroupSessionInputSchema.parse(input));
  }
  @Remote async cancel(input: unknown) {
    this.owner();
    const value = supergroupCancelInputSchema.parse(input);
    await this.groups.cancel(value.workId, value.expectedRevision);
    return null;
  }
  @Remote async settings() {
    this.owner();
    return this.groups.settings();
  }
  @Remote async configure(input: unknown) {
    this.owner();
    return this.groups.configure(supergroupConfigureSchema.parse(input));
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { dshBotSupergroupRemote: SupergroupRemote }
}
