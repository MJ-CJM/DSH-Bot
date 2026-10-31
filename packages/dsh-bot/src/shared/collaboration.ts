import { z } from 'zod';
import { botKeySchema, resourceId } from './integrations.js';
export const teamLinkSchema = z.strictObject({
  id: resourceId,
  bot: botKeySchema,
  leadSessionId: z.string().min(1),
  nativeTeamId: z.string().min(1),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
  schemaVersion: z.literal(1),
});
export const teamMemberSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  role: z.enum(['lead', 'teammate']),
  status: z.enum(['running', 'inactive', 'provisioning', 'failed']),
  description: z.string().optional(),
});
export const teamTaskSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
  ownerName: z.string().optional(),
  blockedBy: z.array(z.string()),
  writeScopes: z.array(z.string()),
  ready: z.boolean(),
  writeScopeWarnings: z.array(z.string()),
});
export const teamBoardSchema = z.strictObject({
  supported: z.boolean(),
  reason: z.enum(['native-service-missing', 'not-linked']).optional(),
  link: teamLinkSchema.optional(),
  members: z.array(teamMemberSchema),
  tasks: z.array(teamTaskSchema),
});
export const teamTaskInputSchema = z.strictObject({
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(16384),
  blockedBy: z.array(z.string().min(1)).max(256).default([]),
});
export const teamUpdateSchema = z.strictObject({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  action: z.enum(['claim', 'complete']),
});
export type TeamLink = z.output<typeof teamLinkSchema>;
export type TeamBoard = z.output<typeof teamBoardSchema>;
export type TeamTaskInput = z.input<typeof teamTaskInputSchema>;
export type TeamUpdate = z.input<typeof teamUpdateSchema>;
export const IM_PIN = '4645cf767257b4bc32c80f4f18e1f9f6cfbb5060';
// U01 did not prove exclusive-consumer disposal on the pinned real plugin.
// No runtime option may promote a contract mock into that missing evidence.
export const IM_RUNTIME_VERIFIED = false;
export const imStatusSchema = z.strictObject({
  pin: z.literal(IM_PIN),
  installed: z.boolean(),
  contractDetected: z.boolean(),
  inboundSupported: z.literal(false),
  outboundSupported: z.literal(false),
  reason: z.enum(['plugin-missing', 'contract-unavailable', 'consumer-gate-unverified']),
});
export type ImStatus = z.output<typeof imStatusSchema>;
