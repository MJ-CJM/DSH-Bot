import { z } from 'zod';
import { botKeySchema, p34Id } from '../../shared/p34.js';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import { assignmentSchema, connectorSchema, legacyImportSchema, notificationSchema, policySchema, receiptSchema } from '../../shared/p34.js';
export const connectorDomain = defineDomain({ name: 'dsh_bot_connectors', version: 1, tables: {
  definitions: domainTable(connectorSchema), assignments: domainTable(assignmentSchema), legacy_imports: domainTable(legacyImportSchema),
} });
export const notificationDomain = defineDomain({ name: 'dsh_bot_notifications', version: 1, tables: {
  read_state: domainTable(z.strictObject({ id: p34Id, owner: botKeySchema, revision: z.number(), createdAt: z.number(), updatedAt: z.number(), schemaVersion: z.literal(1) })),
  policies: domainTable(policySchema), intents: domainTable(notificationSchema), receipts: domainTable(receiptSchema),
} });
export interface P34Stores { connectors: Domain<typeof connectorDomain>; notifications: Domain<typeof notificationDomain>; close(): Promise<void> }
export async function openP34Stores(ctx: Context): Promise<P34Stores> {
  const connectors = await ctx.storageDomain.open(connectorDomain);
  try {
    const notifications = await ctx.storageDomain.open(notificationDomain);
    return { connectors, notifications, async close() { await notifications.close(); await connectors.close(); } };
  } catch { await connectors.close(); throw new Error('P34 storage unavailable'); }
}
