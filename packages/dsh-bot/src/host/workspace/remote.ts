import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { WORKSPACE_REMOTE } from '../../shared/workspace-contract.js';
import type { WorkspaceMethods, ReferenceMemoryMethods } from '../../shared/workspace-contract.js';
import type { WorkspaceManagement } from './service.js';
import type { ReferenceMemory } from '../reference-memory/service.js';
import { OperationError } from '../common/operations.js';
export const WORKSPACE_HOST = {
  package: 'dsh-bot/workspace',
  face: 'host',
  schemas: [],
  get invocations() {
    return WORKSPACE_REMOTE.descriptors;
  },
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution;
export class WorkspaceRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private management: WorkspaceManagement | undefined,
  ) {
    super(ctx, 'dshBotWorkspaceRemote', { namespace: 'dshBot.workspace' });
  }
  @Remote async request(input: Parameters<WorkspaceMethods['request']>[0]) {
    if (!this.management) throw new OperationError('unavailable');
    return this.management.request(input);
  }
}
export class ReferenceMemoryRemote extends TypertRemoteService {
  constructor(
    ctx: Context,
    private memory: ReferenceMemory | undefined,
  ) {
    super(ctx, 'dshBotReferenceMemoryRemote', {
      namespace: 'dshBot.referenceMemory',
    });
  }
  @Remote async request(input: Parameters<ReferenceMemoryMethods['request']>[0]) {
    if (!this.memory) throw new OperationError('unavailable');
    return this.memory.request(input);
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotWorkspaceRemote: WorkspaceRemote;
    dshBotReferenceMemoryRemote: ReferenceMemoryRemote;
  }
}
