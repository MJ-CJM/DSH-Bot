import { outlets } from '../data-flow/tool-guard.js';
import { MemoryLineage } from '../data-flow/lineage.js';
import type { z } from 'zod';
import { type BotKey, sameBot } from '../../shared/integrations.js';
import {
  type CopyReceipt,
  REFERENCE_SOURCE,
  REFERENCE_VERSION,
  graphBindingSchema,
} from '../../shared/reference-memory.js';
import { OperationError, digest, need, parse } from '../common/operations.js';
import { checkedFile } from './files.js';

import {
  copyRowSchema,
  keyOf,
  canonicalRows,
  sourceDigest,
  entityName,
  memoryEntity,
  verifyMemoryEntity,
  type Live,
} from './model.js';
import { ReferenceBackend } from './backend.js';
export class MemoryCopyWorkflow extends ReferenceBackend {
  protected rows(bot: BotKey) {
    return this.registry
      .memoryFor(bot.botId)
      .snapshot(Number.MAX_SAFE_INTEGER)
      .then((rows) => canonicalRows(rows));
  }
  protected row(bot: BotKey, id: string) {
    const row = need(this.domain.table('copies').get(id));
    if (!sameBot(row.receipt.bot, bot)) throw new OperationError('not-found');
    if (outlets(this.registry) && row.flowEpoch !== this.registry.memoryKernel?.epoch)
      throw new Error('Legacy or stale graph stage held');
    return structuredClone(row);
  }
  protected async saveCopy(row: z.output<typeof copyRowSchema>) {
    await this.domain.table('copies').put(row.receipt.id, parse(copyRowSchema, row));
    this.changed();
    return structuredClone(row.receipt);
  }
  protected async preview(bot: BotKey): Promise<CopyReceipt> {
    const binding = this.binding(bot),
      rows = await this.rows(bot);
    if (rows.length > 1000) throw new OperationError('invalid');
    for (const record of rows) memoryEntity(bot, record);
    await this.assertBot(bot);
    const hash = sourceDigest(rows),
      id = `copy:${digest([bot, hash, binding?.revision ?? 0])}`;
    const old = this.domain.table('copies').get(id);
    if (old) return structuredClone(old.receipt);
    return this.saveCopy({
      snapshot: rows,
      ...(this.registry.memoryKernel ? { flowEpoch: this.registry.memoryKernel.epoch } : {}),
      previousMode: binding?.mode ?? 'internal',
      receipt: {
        id,
        bot,
        sourceDigest: hash,
        bindingRevision: binding?.revision ?? 0,
        targetFileIdentity: digest([bot, 'copy', hash, binding?.revision ?? 0]),
        previousFileIdentity: binding?.fileIdentity ?? digest([bot, 'initial']),
        phase: 'preview',
        records: rows.map((r) => ({
          memoryId: r.id,
          digest: digest(r),
          targetEntityName: entityName(bot, r.id),
          status: 'pending',
        })),
        startedAt: Date.now(),
      },
    });
  }
  protected async stage(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id);
    if (row.receipt.phase === 'committed' || row.receipt.phase === 'verified') return row.receipt;
    if (
      row.receipt.phase === 'rolled-back' ||
      sourceDigest(await this.rows(bot)) !== row.receipt.sourceDigest ||
      (this.binding(bot)?.revision ?? 0) !== row.receipt.bindingRevision
    )
      throw new OperationError('conflict');
    const agent = await this.main(bot);
    if (agent?.status !== 'idle' || agent.ctx.tools.get('run_code', agent)) throw new OperationError('unsupported');
    const flow = outlets(this.registry);
    if (flow) {
      const versions = row.snapshot.map(r => flow.kernel.snapshot.versions.get(r.id)?.versionId);
      if (versions.some(v => !v)) throw new Error('Unknown copy lineage');
      const label = await new MemoryLineage(flow.kernel).record(agent.session.id, versions as string[]);
      await flow.inherit(agent.session.id, label);
    }
    const cancel = new AbortController();
    this.copying.set(id, cancel);
    return agent
      .runMaintenance(async (maintenanceSignal) => {
        const signal = AbortSignal.any([maintenanceSignal, cancel.signal]);
        await this.stop(bot);
        row.receipt.phase = 'staging';
        await this.saveCopy(row);
        let l: Live | undefined;
        try {
          l = await this.mount(bot, agent, row.receipt.targetFileIdentity, true);
          const initial = await this.read(l, signal);
          for (let i = 0; i < row.snapshot.length; i++) {
            signal.throwIfAborted();
            const record = need(row.snapshot[i]),
              receipt = need(row.receipt.records[i]),
              target = memoryEntity(bot, record);
            const existing = initial.entities.find((e) => e.name === target.name);
            if (existing) verifyMemoryEntity(bot, record, existing);
            else await this.call(l, 'create_entities', { entities: [target] }, signal);
            receipt.status = 'written';
            await this.saveCopy(row);
          }
          const graph = await this.read(l, signal);
          if (graph.entities.length !== row.snapshot.length || graph.relations.length)
            throw new OperationError('conflict');
          for (let i = 0; i < row.snapshot.length; i++) {
            const record = need(row.snapshot[i]);
            verifyMemoryEntity(
              bot,
              record,
              graph.entities.find((e) => e.name === entityName(bot, record.id)),
            );
            need(row.receipt.records[i]).status = 'verified';
          }
          if (sourceDigest(await this.rows(bot)) !== row.receipt.sourceDigest) throw new OperationError('conflict');
          row.receipt.phase = 'verified';
          row.receipt.verifiedAt = Date.now();
          return await this.saveCopy(row);
        } catch (error) {
          row.receipt.phase = 'failed';
          await this.saveCopy(row);
          throw error;
        } finally {
          if (l) await this.closeLive(l);
          const binding = this.binding(bot);
          if (binding?.mode === 'internal+reference-graph' && !this.stopping && !this.registry.memoryKernel?.blocked)
            await this.mount(bot, agent, binding.fileIdentity, false);
        }
      })
      .finally(() => this.copying.delete(id));
  }
  protected async commit(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id),
      binding = this.binding(bot);
    if (
      binding?.importId === id &&
      binding.revision === row.receipt.bindingRevision + 1 &&
      binding.fileIdentity === row.receipt.targetFileIdentity
    ) {
      if (row.receipt.phase === 'committed') return row.receipt;
      row.receipt.phase = 'committed';
      row.receipt.committedAt ??= Date.now();
      return this.saveCopy(row);
    }
    if (row.receipt.phase !== 'verified' || (binding?.revision ?? 0) !== row.receipt.bindingRevision)
      throw new OperationError('conflict');
    await this.stop(bot);
    try {
      const receipt = await this.registry.memoryFor(bot.botId).withSnapshot(Number.MAX_SAFE_INTEGER, async (rows) => {
        if (
          sourceDigest(rows) !== row.receipt.sourceDigest ||
          this.registry.presetBot(bot.botId).createdAt !== bot.botCreatedAt
        )
          throw new OperationError('conflict');
        // Recheck the exact verified bytes before the sole pointer commit. No internal memory write occurs.
        await this.prepare(bot, row.receipt.targetFileIdentity);
        const bytes = need(
          await checkedFile(
            this.file(bot, row.receipt.targetFileIdentity),
            this.registry.config.referenceMemoryMaxFileBytes,
          ),
        );
        const entities = bytes
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((e) => e.type === 'entity');
        for (const record of rows) {
          const entity = entities.find((e) => e.name === entityName(bot, record.id));
          if (!entity) throw new OperationError('invalid');
          const { type: _type, ...value } = entity;
          verifyMemoryEntity(bot, record, value);
        }
        this.row(bot, id);
        await this.domain.table('bindings').put(
          keyOf(bot),
          graphBindingSchema.parse({
            bot,
            mode: 'internal+reference-graph',
            provider: 'mcp-reference',
            packageVersion: REFERENCE_VERSION,
            sourceCommit: REFERENCE_SOURCE,
            scope: 'main-only',
            revision: row.receipt.bindingRevision + 1,
            fileIdentity: row.receipt.targetFileIdentity,
            importId: id,
          }),
        );
        row.receipt.phase = 'committed';
        row.receipt.committedAt = Date.now();
        return this.saveCopy(row);
      });
      await this.applyNow(bot);
      return receipt;
    } catch (error) {
      // Keep the binding pointer authoritative across verification or manifest-write failures.
      await this.applyNow(bot);
      throw error;
    }
  }
  protected async rollback(bot: BotKey, id: string): Promise<CopyReceipt> {
    const row = this.row(bot, id),
      binding = this.binding(bot);
    if (row.receipt.phase === 'rolled-back') return row.receipt;
    if (binding?.importId === id) {
      if (binding.revision !== row.receipt.bindingRevision + 1) throw new OperationError('conflict');
      await this.stop(bot);
      this.row(bot, id);
      await this.domain.table('bindings').put(
        keyOf(bot),
        graphBindingSchema.parse({
          ...binding,
          importId: undefined,
          mode: row.previousMode,
          fileIdentity: row.receipt.previousFileIdentity,
          revision: binding.revision + 1,
        }),
      );
    } else if ((binding?.revision ?? 0) !== row.receipt.bindingRevision) throw new OperationError('conflict');
    row.receipt.phase = 'rolled-back';
    await this.saveCopy(row);
    await this.applyNow(bot);
    return row.receipt;
  }
}
