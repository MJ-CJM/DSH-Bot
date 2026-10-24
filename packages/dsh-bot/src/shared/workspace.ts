import { z } from 'zod';
import { botCreateSchema, memoryAddSchema } from './schema.js';
import { botIdSchema } from './ids.js';
import { botKeySchema, resourceId } from './integrations.js';
import { hasCredential } from './secrets.js';

function hasLocalPath(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value) ||
      /\/(?:Users|home|private|Volumes|tmp|var|opt|Applications|usr|etc|root|mnt)\/|[A-Za-z]:[\\/]/u.test(value)
    );
  if (Array.isArray(value)) return value.some(hasLocalPath);
  return value !== null && typeof value === 'object' && Object.values(value).some(hasLocalPath);
}

// Portable exports carry editable values, never machine configuration or authority.
export const portableBotSchema = botCreateSchema.omit({
  id: true,
  defaultCwd: true,
  skills: true,
  mcpServers: true,
  channels: true,
});
export const skillFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(240)
    .refine(
      (p) =>
        !p.startsWith('/') &&
        !p.includes('\\') &&
        !p.includes('\0') &&
        p.split('/').every((s) => s !== '.' && s !== '..' && s !== ''),
    ),
  content: z.string().max(262144),
});
export const botExportSchema = z
  .strictObject({
    format: z.literal('dsh-bot-export'),
    version: z.literal(1),
    bot: portableBotSchema,
    skillsManifest: z.array(skillFileSchema).max(128).default([]),
    connectorTemplates: z
      .array(z.strictObject({ connectorId: resourceId, enabled: z.literal(false) }))
      .max(128)
      .default([]),
    channelTemplates: z
      .array(
        z.strictObject({
          kind: z.enum(['feishu', 'telegram', 'slack', 'email', 'desktop']),
          enabled: z.literal(false),
        }),
      )
      .max(32)
      .default([]),
    memoryRecords: z
      .array(memoryAddSchema.omit({ botId: true, source: true }))
      .max(1000)
      .default([]),
  })
  .superRefine((v, ctx) => {
    const text = JSON.stringify(v);
    if (
      new TextEncoder().encode(text).length > 1048576 ||
      hasCredential(text) ||
      hasLocalPath(v) ||
      new Set(v.skillsManifest.map((f) => f.path)).size !== v.skillsManifest.length
    )
      ctx.addIssue({ code: 'custom', message: 'Unsafe or oversized export' });
  });
export type BotExport = z.output<typeof botExportSchema>;
export const workspaceSummarySchema = z.strictObject({
  available: z.boolean(),
  sampleSize: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});
export const importPreviewSchema = z.strictObject({
  id: resourceId,
  newId: botIdSchema,
  digest: z.string(),
  files: z.array(z.string()),
  memories: z.number().int().nonnegative(),
  connectorRefs: z.array(resourceId),
  missingConnectorRefs: z.array(resourceId),
  conflict: z.boolean(),
  phase: z.enum(['preview', 'applying', 'committed', 'failed']),
  createdBot: botKeySchema.optional(),
  scope: z.enum(['bot', 'memories']).default('bot'),
  targetBot: botKeySchema.optional(),
  targetDigest: z.string().optional(),
});
export const workspaceRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('summary') }),
  z.strictObject({
    action: z.literal('export'),
    bot: botKeySchema,
    includeSkills: z.boolean(),
    includeMemories: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('preview'),
    newId: botIdSchema,
    document: botExportSchema,
  }),
  z.strictObject({
    action: z.literal('previewMemories'),
    bot: botKeySchema,
    document: botExportSchema,
  }),
  z.strictObject({ action: z.literal('inspect'), previewId: resourceId }),
  z.strictObject({
    action: z.literal('import'),
    previewId: resourceId,
    confirmed: z.literal(true),
  }),
]);
export const workspaceResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('summary'),
    summary: workspaceSummarySchema,
  }),
  z.strictObject({ kind: z.literal('export'), document: botExportSchema }),
  z.strictObject({ kind: z.literal('preview'), preview: importPreviewSchema }),
]);
