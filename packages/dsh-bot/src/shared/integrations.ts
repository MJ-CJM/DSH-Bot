// Shared integration catalog; durable identity and domain schemas have independent modules.
export * from './identity.js';
export * from './connectors.js';
export * from './notifications.js';
import { z } from 'zod';
import { connectorSchema, assignmentSchema, connectorRuntimeSchema } from './connectors.js';
import { policySchema, notificationSchema } from './notifications.js';
export const integrationCatalogSchema = z.strictObject({
  definitions: z.array(connectorSchema),
  assignments: z.array(assignmentSchema),
  runtime: z.array(connectorRuntimeSchema),
  policies: z.array(policySchema),
  notifications: z.array(notificationSchema),
  unread: z.number().int().nonnegative(),
  imSupported: z.boolean(),
  desktopSupported: z.literal(false),
  defaults: z.strictObject({ dailyLimit: z.number(), cooldownSec: z.number() }),
});
export type IntegrationCatalog = z.output<typeof integrationCatalogSchema>;
