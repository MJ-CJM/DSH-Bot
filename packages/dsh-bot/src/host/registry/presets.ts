import { isDeepStrictEqual } from 'node:util';
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import type { BotRecord } from '../../shared/schema.js';
import type { BotStatus } from '../../shared/remote-contract.js';
import { DshBotError } from '../errors.js';
import { composeBotPreset, ensureBotSkillsDirectory } from '../composer.js';
import { RegistryLifecycle } from './lifecycle.js';
import type { Lease } from './types.js';
import { sameBotConfig, messageOf } from './identity.js';

export abstract class RegistryPresets extends RegistryLifecycle {
  /** Only retained disposer handles establish ownership; a prefix is not ownership. */
  protected async reconcile(): Promise<void> {
    try {
      const expected = new Map<string, { bot: BotRecord; definition: PresetDefinition }>();
      for (const bot of this.stores.bots.list()) {
        await ensureBotSkillsDirectory(bot.id, this.config);
        const definition = await composeBotPreset(bot, this.ctx, this.config);
        expected.set(definition.id, { bot, definition });
      }
      const roster = new Map((await this.ctx.agentPresets.list()).map((row) => [row.id, row]));
      for (const [id, lease] of this.leases) {
        const wanted = expected.get(id);
        if (
          !wanted ||
          !roster.has(id) ||
          roster.get(id)?.broken !== undefined ||
          !isDeepStrictEqual(lease.definition, wanted.definition) ||
          !sameBotConfig(lease.bot, wanted.bot)
        )
          await this.release(lease);
      }
      for (const [id, { bot, definition }] of expected) {
        if (!this.leases.has(id)) {
          try {
            await this.acquire(definition, bot);
          } catch (error) {
            this.diagnostics.set(bot.id, messageOf(error));
            this.ctx.logger.error(`[dsh-bot] reconcile failed bot=${bot.id}: ${messageOf(error)}`);
            throw error;
          }
        }
      }
      const invalid = (await this.statusRows()).find((row) => row.preset.state !== 'ok');
      if (invalid) throw new Error(`Bot '${invalid.id}': ${invalid.preset.reason ?? invalid.preset.state}`);
      this.diagnostics.clear();
      this.failed = false;
    } catch (error) {
      throw new DshBotError('bot/unavailable', `Preset reconciliation failed: ${messageOf(error)}`, { cause: error });
    }
  }

  protected async statusRows(): Promise<BotStatus[]> {
    const roster = new Map((await this.ctx.agentPresets.list()).map((row) => [row.id, row]));
    // Template reads are diagnostic only: never recompose/unload a retained
    // generation from status(). Retry each query so a recovered template clears.
    const bots = this.stores.bots.list();
    const templateErrors = new Map<string, string>();
    for (const template of new Set(bots.map((bot) => bot.template))) {
      try {
        await this.ctx.agentPresets.readDocument(template);
      } catch (error) {
        templateErrors.set(template, `Cannot read template '${template}': ${messageOf(error)}`);
      }
    }
    const avatarWarnings = new Set(this.stores.bots.avatarWarnings());
    return bots.map((bot): BotStatus => {
      const presetId = `${this.config.presetIdPrefix}${bot.id}`;
      const identity = {
        id: bot.id,
        presetId,
        ...(avatarWarnings.has(bot.id) ? { warnings: ['avatar/invalid' as const] } : {}),
      };
      const row = roster.get(presetId);
      const templateError = templateErrors.get(bot.template);
      if (templateError) return { ...identity, preset: { state: 'broken', reason: templateError } };
      if (!row)
        return {
          ...identity,
          preset: {
            state: 'missing',
            reason: this.diagnostics.get(bot.id) ?? `Preset '${presetId}' is not registered`,
          },
        };
      const lease = this.leases.get(presetId);
      const reason =
        row.broken ??
        (!lease
          ? 'Preset id is owned by another registration'
          : !sameBotConfig(lease.bot, bot)
            ? 'Preset differs from the stored Bot'
            : undefined);
      return { ...identity, preset: reason === undefined ? { state: 'ok' } : { state: 'broken', reason } };
    });
  }

  protected async release(lease: Lease): Promise<void> {
    await lease.dispose();
    this.leases.delete(lease.definition.id);
  }

  protected async acquire(definition: PresetDefinition, bot: BotRecord): Promise<void> {
    this.activating.set(bot.id, structuredClone(bot));
    try {
      const dispose = await this.ctx.agentPresets.register(definition);
      this.leases.set(definition.id, { definition, bot: structuredClone(bot), dispose });
      const row = (await this.ctx.agentPresets.list()).find((row) => row.id === definition.id);
      if (!row || row.broken !== undefined)
        throw new Error(row?.broken ?? `Preset '${definition.id}' missing after registration`);
    } catch (error) {
      throw new DshBotError('bot/preset-failed', `Preset '${definition.id}' failed: ${messageOf(error)}`, {
        cause: error,
      });
    } finally {
      this.activating.delete(bot.id);
    }
  }

  protected async transition<T>(id: string, candidate: BotRecord | undefined, commit: () => Promise<T>): Promise<T> {
    const presetId = `${this.config.presetIdPrefix}${id}`;
    // Prepare before retiring the current generation: parse/I/O failures have no preset gap.
    const definition = candidate ? await composeBotPreset(candidate, this.ctx, this.config) : undefined;
    if (candidate) await ensureBotSkillsDirectory(candidate.id, this.config);
    const previous = this.leases.get(presetId);
    const previousBroken =
      previous && (await this.ctx.agentPresets.list()).find((row) => row.id === presetId)?.broken !== undefined;
    // An unregister rejection has unknown side effects; do not claim recovery.
    if (previous) {
      try {
        await this.release(previous);
      } catch (error) {
        this.failed = true;
        throw new DshBotError('bot/rollback-failed', `Cannot retire '${presetId}': ${messageOf(error)}`, {
          cause: error,
        });
      }
    }
    try {
      if (candidate && definition) await this.acquire(definition, candidate);
      const result = await commit();
      this.diagnostics.delete(id);
      return result;
    } catch (error) {
      try {
        const failed = this.leases.get(presetId);
        if (failed) await this.release(failed);
        if (previous) {
          try {
            await this.acquire(previous.definition, previous.bot);
          } catch (restore) {
            // A previously broken startup definition remains editable/deletable.
            if (!previousBroken || !this.leases.has(presetId)) throw restore;
            this.diagnostics.set(id, messageOf(restore));
          }
        }
      } catch (rollback) {
        this.failed = true;
        throw new DshBotError('bot/rollback-failed', `${messageOf(error)}; rollback failed: ${messageOf(rollback)}`, {
          cause: new AggregateError([error, rollback]),
        });
      }
      throw error;
    }
  }

}
