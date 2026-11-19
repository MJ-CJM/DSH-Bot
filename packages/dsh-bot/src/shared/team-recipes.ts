import { z } from 'zod';
import { botKeySchema } from './identity.js';
import { groupModeSchema } from './groups.js';
import { GROUP_MEMBER_LIMIT } from './group-limits.js';
/** Portable preferences only. Strict objects reject history, credentials and authority. */
export const teamRecipeSchema = z.strictObject({
  format: z.literal('dsh-bot-team'), version: z.literal(1),
  name: z.string().trim().min(1).max(64), mode: groupModeSchema,
  onDemand: z.boolean(),
  roles: z.array(z.strictObject({
    id: z.string().regex(/^role-[0-9]+$/), role: z.string().trim().min(1).max(64),
    preferredBotId: z.string().min(1).max(64), template: z.enum(['standard', 'minimal']),
  })).min(2).max(16),
}).refine(value => new Set(value.roles.map(role => role.id)).size === value.roles.length);
/** New/imported preferences use the current ceiling; persisted recipes retain their original roles. */
export const teamRecipeInputSchema = teamRecipeSchema.refine(value => value.roles.length <= GROUP_MEMBER_LIMIT);
export const savedTeamRecipeSchema = z.strictObject({ id: z.string().min(1), savedAt: z.number(), recipe: teamRecipeSchema });
export const teamPreviewMappingSchema = z.array(z.strictObject({ roleId: z.string().min(1), bot: botKeySchema })).max(16);
export const teamMappingSchema = teamPreviewMappingSchema.min(2);
export const teamPreviewSchema = z.strictObject({
  recipe: teamRecipeSchema,
  roles: z.array(z.strictObject({ roleId: z.string(), bot: botKeySchema.optional(),
    match: z.enum(['preferred', 'capability', 'manual', 'unmapped']), capabilityMatch: z.boolean(),
    candidates: z.array(z.strictObject({ bot: botKeySchema, name: z.string(), template: z.enum(['standard', 'minimal']) })),
  })),
});
export type TeamRecipe = z.output<typeof teamRecipeSchema>;
export type TeamPreview = z.output<typeof teamPreviewSchema>;
