import { type BotCreateInput, type BotRecord, botCreateSchema, botSchema } from '../../shared/schema.js';
import { DshBotError, parseInput } from '../errors.js';
import { validateDefaultCwd } from '../home.js';
import { RegistryPresets } from './presets.js';
import type { BotChanged } from './types.js';

export abstract class RegistryMutations extends RegistryPresets {
  protected abstract changed(id: string, action: BotChanged['action']): void;
  protected async createRecord(input: BotCreateInput, action: 'create' | 'duplicate'): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    await validateDefaultCwd(fields.defaultCwd);
    if (this.stores.bots.list().some((bot) => bot.id === fields.id)) {
      throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
    }
    const now = Math.max(Date.now(), this.creationTime + 1);
    this.creationTime = now;
    const candidate = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
    // The generation snapshot and stored identity must share their creation
    // time even when preset activation crosses a millisecond boundary.
    const record = await this.transition(fields.id, candidate, () =>
      this.stores.bots.create(fields, candidate.createdAt),
    );
    this.changed(record.id, action);
    return record;
  }

}
