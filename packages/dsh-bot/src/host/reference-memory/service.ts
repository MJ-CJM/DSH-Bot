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
export { referenceMemoryDomain, memoryEntity, verifyMemoryEntity } from './model.js';
export class ReferenceMemory extends MemoryCopyWorkflow {
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
