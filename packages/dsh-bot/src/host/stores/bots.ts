import { DshBotError, parseInput } from '../errors.js';
import { validateDefaultCwd } from '../home.js';
import { botIdSchema } from '../../shared/ids.js';
import {
  botRegistryStateSchema,
  botCreateSchema,
  botPatchSchema,
  botRemoveOptionsSchema,
  botSchema,
  normalizeBotPatch,
  timestampSchema,
} from '../../shared/schema.js';
import type { BotCreateInput, BotPatch, BotRecord, BotRemoveOptions } from '../../shared/schema.js';

import {
  type BotDomain,
  publicBot,
  invalidAvatar,
  read,
  write,
  nextTimestamp,
  compareId,
  missingBot,
  deleteBotMemories,
  deleteBotActivities,
} from './domain.js';
export class BotStore {
  constructor(private readonly domain: BotDomain) {}

  botsWorkspaceId(): string | undefined {
    return read(() => this.domain.table('registry_state').get('bots-workspace')?.botsWorkspaceId);
  }

  async saveBotsWorkspaceId(id: string): Promise<void> {
    const state = parseInput(botRegistryStateSchema, { botsWorkspaceId: id });
    await write(this.domain, () => this.domain.table('registry_state').put('bots-workspace', state));
  }

  /** A durable marker prevents reseeding after users deliberately remove every Bot.
   * A pending batch resumes missing examples after an interrupted initial write.
   */
  async seedExamples(inputs: readonly BotCreateInput[]): Promise<void> {
    const examples = inputs.map((input) => parseInput(botCreateSchema, input));
    await Promise.all(examples.map((example) => validateDefaultCwd(example.defaultCwd)));
    await write(this.domain, async () => {
      const state = this.domain.table('registry_state');
      const bots = this.domain.table('bots');
      const previous = state.get('examples');
      if (previous?.status === 'complete') return;
      if (previous === undefined && bots.size > 0) {
        await state.put('examples', botRegistryStateSchema.parse({ status: 'complete' }));
        return;
      }
      await state.put('examples', botRegistryStateSchema.parse({ status: 'pending' }));
      for (const example of examples) {
        if (bots.get(example.id)) continue;
        const now = Date.now();
        const record = parseInput(botSchema, { ...example, createdAt: now, updatedAt: now, schemaVersion: 1 });
        await bots.put(record.id, record);
      }
      await state.put('examples', botRegistryStateSchema.parse({ status: 'complete' }));
    });
  }

  list(): BotRecord[] {
    return read(() =>
      [...this.domain.table('bots').entries()]
        .map(([, value]) => publicBot(value))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareId(a.id, b.id)),
    );
  }

  get(id: string): BotRecord {
    const key = parseInput(botIdSchema, id);
    return read(() => {
      const record = this.domain.table('bots').get(key);
      if (!record) throw missingBot(key);
      return publicBot(record);
    });
  }

  avatarWarnings(): string[] {
    return read(() =>
      [...this.domain.table('bots').entries()].filter(([, row]) => invalidAvatar(row)).map(([, row]) => row.id),
    );
  }

  async create(input: BotCreateInput, createdAt = Date.now()): Promise<BotRecord> {
    const fields = parseInput(botCreateSchema, input);
    await validateDefaultCwd(fields.defaultCwd);
    const now = parseInput(timestampSchema, createdAt);
    return write(this.domain, async () => {
      const table = this.domain.table('bots');
      if (table.get(fields.id)) throw new DshBotError('bot/conflict', `Bot '${fields.id}' already exists`);
      const record = parseInput(botSchema, { ...fields, createdAt: now, updatedAt: now, schemaVersion: 1 });
      await table.put(record.id, record);
      return structuredClone(record);
    });
  }

  async update(id: string, patch: BotPatch, expectedUpdatedAt?: number): Promise<BotRecord> {
    const key = parseInput(botIdSchema, id);
    const fields = normalizeBotPatch(parseInput(botPatchSchema, patch));
    await validateDefaultCwd(fields.defaultCwd);
    const expected = parseInput(timestampSchema.optional(), expectedUpdatedAt);
    return write(this.domain, async () =>
      publicBot(
        await this.domain.table('bots').update(key, (current) => {
          // Check at the domain's write slot, never against a pre-queue snapshot.
          if (expected !== undefined && current.updatedAt !== expected) {
            throw new DshBotError('bot/conflict', `Bot '${key}' has changed; reload before updating`);
          }
          if (invalidAvatar(current) && !('avatar' in fields)) {
            throw new DshBotError(
              'bot/invalid',
              'Stored avatar is unsupported; explicitly replace or clear the avatar before updating.',
            );
          }
          return parseInput(botSchema, { ...current, ...fields, updatedAt: nextTimestamp(current.updatedAt) });
        }),
      ),
    );
  }

  /** Delete dependent data first so failed cleanup leaves the Bot available for retry. */
  async remove(id: string, options: BotRemoveOptions = {}): Promise<void> {
    const key = parseInput(botIdSchema, id);
    const { deleteMemories } = parseInput(botRemoveOptionsSchema, options);
    return write(this.domain, async () => {
      if (!this.domain.table('bots').get(key)) throw missingBot(key);
      if (deleteMemories) await deleteBotMemories(this.domain, key);
      // Activity is never retained, including when the user keeps memories.
      await deleteBotActivities(this.domain, key);
      if (!(await this.domain.table('bots').delete(key))) throw missingBot(key);
    });
  }
}
