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
import type { MemoryQuery, MemoryCreate, MemoryRevise, MemoryConfirm, MemoryResolve } from '../../shared/memory-management.js';

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
  @Remote
  async autoShareStatus() { return this.ctx.dshBots.autoShareStatus(); }
  @Remote
  async setAutoShare(input: { enabled: boolean; expectedRevision: number }) { return this.ctx.dshBots.setAutoShare(input); }
  @Remote
  async query(input: MemoryQuery) { return this.ctx.dshBots.manageMemory(m => m.query(input)); }
  @Remote
  async createManaged(input: MemoryCreate) {
    const result = await this.ctx.dshBots.manageMemory(m => m.create(input)); this.ctx.dshBots.invalidate(); return result;
  }
  @Remote
  async revise(input: MemoryRevise) {
    await this.ctx.dshBots.manageMemory(m => m.revise(input)); this.ctx.dshBots.invalidate();
  }
  @Remote
  async confirm(input: MemoryConfirm) {
    const result = await this.ctx.dshBots.manageMemory(m => m.confirm(input)); this.ctx.dshBots.invalidate(); return result;
  }
  @Remote
  async resolve(input: MemoryResolve) {
    await this.ctx.dshBots.manageMemory(m => m.resolve(input)); this.ctx.dshBots.invalidate();
  }
  @Remote
  async previewContribution(id: string) { return this.forgetting().previews.contribution(parseInput(z.uuid(), id)); }
  @Remote
  async previewShared(selection: ForgetSelection) {
    return this.forgetting().previewShared(parseInput(forgetSelectionSchema, selection));
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
