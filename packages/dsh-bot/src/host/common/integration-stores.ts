import { z } from 'zod';
import { botKeySchema, resourceId } from '../../shared/integrations.js';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import {
  assignmentSchema,
  connectorSchema,
  legacyImportSchema,
  notificationSchema,
  policySchema,
  receiptSchema,
} from '../../shared/integrations.js';
export const connectorDomain = defineDomain({
  name: 'dsh_bot_connectors',
  version: 1,
  tables: {
    definitions: domainTable(connectorSchema),
    assignments: domainTable(assignmentSchema),
    legacy_imports: domainTable(legacyImportSchema),
  },
});
export const notificationDomain = defineDomain({
  name: 'dsh_bot_notifications',
  version: 1,
  tables: {
    read_state: domainTable(
      z.strictObject({
        id: resourceId,
        owner: botKeySchema,
        revision: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        schemaVersion: z.literal(1),
      }),
    ),
    policies: domainTable(policySchema),
    intents: domainTable(notificationSchema),
    receipts: domainTable(receiptSchema),
  },
});
export interface IntegrationStores {
  connectors: Domain<typeof connectorDomain>;
  notifications: Domain<typeof notificationDomain>;
  close(): Promise<void>;
}
export async function openIntegrationStores(ctx: Context): Promise<IntegrationStores> {
  const connectors = await ctx.storageDomain.open(connectorDomain);
  try {
    const notifications = await ctx.storageDomain.open(notificationDomain);
    return {
      connectors,
      notifications,
      async close() {
        const results = await Promise.allSettled([notifications.close(), connectors.close()]);
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'Integration stores shutdown failed');
      },
    };
  } catch {
    await connectors.close();
    throw new Error('Integration storage unavailable');
  }
}
