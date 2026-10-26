import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import {
  type DshBotMemoryMethods,
  type MemoryRemoteListInput,
  type MemoryRemotePatch,
  type MemoryRemoteSaveInput,
  type MemoryRemoteSearchInput,
  memoryRemoteListSchema,
  memoryRemotePatchSchema,
  memoryRemoteSaveSchema,
  memoryRemoteSearchSchema,
} from '../../shared/remote-contract.js';
import type { MemoryRecord, MemorySaveResult } from '../../shared/schema.js';
import { parseInput } from '../errors.js';
import type {} from '../registry.js';
import { rejectMemorySecrets } from './secrets.js';
import { forgetChoiceSchema, forgetSelectionSchema, type ForgetChoice, type ForgetSelection } from '../../shared/memory-forget.js';
import { z } from 'zod';

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotMemory: DshBotMemoryRemote;
  }
}

/** The registry owns all storage and queue lifetimes; this service only adapts UI calls. */
export class DshBotMemoryRemote extends TypertRemoteService implements DshBotMemoryMethods {
  static inject = ['dshBots'];

  constructor(ctx: Context) {
    super(ctx, 'dshBotMemory', { namespace: 'dshBot.memory' });
  }
  private forgetting() {
    const service = this.ctx.dshBots.memoryForget;
    if (!service) throw new Error('Memory cleanup is not ready');
    return service;
  }

  @Remote
  async previewForget(botId: string, selection: ForgetSelection) {
    return this.forgetting().preview(botId, parseInput(forgetSelectionSchema, selection));
  }
  @Remote
  async chooseForget(choice: ForgetChoice) {
    const result = await this.forgetting().choose(parseInput(forgetChoiceSchema, choice));
    this.ctx.dshBots.invalidate();
    return result;
  }
  @Remote
  async cleanupStatuses() { return this.forgetting().runner.statuses(); }
  @Remote
  async retryCleanup(id: string) {
    return this.forgetting().runner.resume(parseInput(z.uuid(), id));
  }
  @Remote
  async rootInstructions() { return this.forgetting().roots(); }

  @Remote
  async list(botId: string, options: MemoryRemoteListInput): Promise<MemoryRecord[]> {
    return this.ctx.dshBots.memoryFor(botId).query(parseInput(memoryRemoteListSchema, options));
  }

  @Remote
  async search(botId: string, input: MemoryRemoteSearchInput): Promise<MemoryRecord[]> {
    return this.ctx.dshBots.memoryFor(botId).query(parseInput(memoryRemoteSearchSchema, input));
  }

  @Remote
  async save(botId: string, input: MemoryRemoteSaveInput): Promise<MemorySaveResult> {
    rejectMemorySecrets(input);
    const fields = parseInput(memoryRemoteSaveSchema, input);
    return this.ctx.dshBots.memoryFor(botId).save(fields, { by: 'user', at: Date.now() });
  }

  @Remote
  async update(botId: string, id: string, patch: MemoryRemotePatch): Promise<MemoryRecord> {
    rejectMemorySecrets(patch);
    return this.ctx.dshBots.memoryFor(botId).update(id, parseInput(memoryRemotePatchSchema, patch));
  }

  // "remove" is reserved by rc.2's Client namespace service, including nested namespaces.
  @Remote('delete')
  async remove(botId: string, id: string): Promise<void> {
    return this.ctx.dshBots.memoryFor(botId).forget({ id });
  }

  @Remote
  async quarantineCount(): Promise<number> {
    return this.ctx.dshBots.memoryQuarantineCount();
  }

  @Remote
  async count(botId: string): Promise<number> {
    return this.ctx.dshBots.memoryFor(botId).count();
  }
}
