import type { z } from 'zod';
import {
  type CopyReceipt,
  REFERENCE_SOURCE,
  REFERENCE_VERSION,
  graphBindingSchema,
  graphRequestSchema,
  graphResultSchema,
  graphSchema,
} from '../../shared/reference-memory.js';
import { hasCredential } from '../../shared/secrets.js';
import { OperationError, digest, parse } from '../common/operations.js';

import { keyOf } from './model.js';
import { MemoryCopyWorkflow } from './copies.js';
import { managedGraphFiles, eraseManagedGraphs } from './cleanup-files.js';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
export { referenceMemoryDomain, memoryEntity, verifyMemoryEntity } from './model.js';
export class ReferenceMemory extends MemoryCopyWorkflow {
  async forgetInventory() {
    const files = await managedGraphFiles(this.root);
    const copies = [...this.domain.table('copies').entries()];
    return { count: files.length + copies.length, stamp: { files, copies,
      bindings: [...this.domain.table('bindings').entries()] } };
  }
  /** All managed graph generations are in the conservative preview. User explicitly chooses their reset. */
  async forgetCleanup(): Promise<void> {
    for (const l of this.live.values()) l.accepting = false;
    for (const cancel of this.copying.values()) cancel.abort();
    await this.control.run(async () => {
      for (const l of [...this.live.values()]) await this.closeLive(l);
      await eraseManagedGraphs(this.root);
      for (const [id] of [...this.domain.table('copies').entries()]) await this.domain.table('copies').delete(id);
      for (const [key, binding] of this.domain.table('bindings').entries()) {
        if (binding.mode === 'internal' && !binding.importId) continue;
        await this.domain.table('bindings').put(key, graphBindingSchema.parse({ ...binding, mode: 'internal',
          importId: undefined, fileIdentity: digest([randomUUID()]), revision: binding.revision + 1 }));
      }
      // Reopen twice through the actual MCP reader. A stopped writer or an empty directory is insufficient proof.
      for (const [, binding] of this.domain.table('bindings').entries()) {
        const agent = await this.main(binding.bot);
        if (!agent) throw new Error('Reference main unavailable for cold read');
        await agent.runMaintenance(async signal => {
          for (let pass = 0; pass < 2; pass++) {
            const live = await this.mount(binding.bot, agent, binding.fileIdentity, true);
            try {
              const graph = graphSchema.parse(await this.call(live, 'read_graph', {}, signal, true));
              if (graph.entities.length || graph.relations.length) throw new Error('Reference remount contains stale data');
            } finally { await this.closeLive(live); }
          }
          await unlink(this.file(binding.bot, binding.fileIdentity));
        });
      }
      const check = await this.forgetInventory();
      if (check.count || this.live.size) throw new Error('Reference copy cleanup unverified');
      this.changed();
    });
  }
  async request(input: z.input<typeof graphRequestSchema>) {
    const r = parse(graphRequestSchema, input);
    if (r.action === 'status') {
      await this.assertBot(r.bot);
      return graphResultSchema.parse({ status: this.status(r.bot) });
    }
    if (r.action === 'cancel') {
      await this.assertBot(r.bot);
      this.row(r.bot, r.copyId);
      this.copying.get(r.copyId)?.abort();
    }
    return this.control.run(async () => {
      await this.assertBot(r.bot);
      let graph: z.output<typeof graphSchema> | undefined, copy: CopyReceipt | undefined;
      if (r.action === 'configure') {
        const old = this.binding(r.bot);
        if ((old?.revision ?? 0) !== r.expectedRevision) throw new OperationError('conflict');
        await this.stop(r.bot);
        await this.domain.table('bindings').put(
          keyOf(r.bot),
          graphBindingSchema.parse({
            bot: r.bot,
            mode: r.mode,
            provider: 'mcp-reference',
            packageVersion: REFERENCE_VERSION,
            sourceCommit: REFERENCE_SOURCE,
            scope: 'main-only',
            revision: r.expectedRevision + 1,
            fileIdentity: old?.fileIdentity ?? digest([r.bot, 'initial']),
          }),
        );
        if (r.mode !== 'internal') await this.applyNow(r.bot);
      } else if (r.action === 'apply') await this.applyNow(r.bot);
      else if (r.action === 'tool') {
        if (hasCredential(JSON.stringify(r.call))) throw new OperationError('invalid');
        const l = await this.ready(r.bot);
        graph = await l.agent.runMaintenance(async (signal) => {
          const value = await this.call(l, r.call.tool, r.call.arguments, signal);
          if (r.call.tool === 'search_nodes' || r.call.tool === 'read_graph') return parse(graphSchema, value);
          return this.read(l, signal);
        });
      } else if (r.action === 'preview') copy = await this.preview(r.bot);
      else if (r.action === 'stage') copy = await this.stage(r.bot, r.copyId);
      else if (r.action === 'commit') copy = await this.commit(r.bot, r.copyId);
      else if (r.action === 'rollback' || r.action === 'cancel') copy = await this.rollback(r.bot, r.copyId);
      this.changed();
      return graphResultSchema.parse({
        status: this.status(r.bot),
        ...(graph ? { graph } : {}),
        ...(copy ? { copy } : {}),
      });
    });
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    dshBotReferenceMemory: ReferenceMemory;
  }
}
