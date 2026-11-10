import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const assignment = z.strictObject({
  ticketId: z.string(), assignmentId: z.string(), effectId: z.string(),
  bot: z.strictObject({ botId: z.string(), botCreatedAt: z.number() }),
  policyRevision: z.number(), action: z.string(), target: z.string(), dataScope: z.string(), modelBudget: z.number(),
});
const receipt = z.strictObject({
  receiptId: z.string(),
  assignment,
  state: z.enum(['accepted', 'denied', 'dispatching', 'completed']),
  rejection: z.string().optional(),
  parentId: z.string().optional(),
  sourceId: z.string().optional(),
  turnNumber: z.number().optional(),
  assistantMessageId: z.string().optional(),
  parentSourceReceiptId: z.string().optional(),
  childId: z.string().optional(),
  runId: z.string().optional(),
  childMessageId: z.string().optional(),
});
export type HostReceipt = z.infer<typeof receipt>;

const hostDomain = defineDomain({ name: 'pb00_host_receipts', version: 1, tables: { receipts: domainTable(receipt) } });
export const lifecycleDomain = defineDomain({ name: 'pb00_lifecycle', version: 1, tables: { receipts: domainTable(receipt) } });

export async function openReceipts(ctx: Context) {
  const domain = await ctx.storageDomain.open(hostDomain);
  const table = domain.table('receipts');
  return {
    async create(row: HostReceipt) {
      if (table.get(row.assignment.effectId)) throw new Error('Receipt already exists');
      await table.put(row.assignment.effectId, row);
    },
    save: (row: HostReceipt) => table.put(row.assignment.effectId, row),
    get: (effectId: string) => table.get(effectId),
    close: () => domain.close(),
  };
}
