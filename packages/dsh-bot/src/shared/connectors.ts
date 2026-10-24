import { z } from 'zod';
import { hasCredential } from './secrets.js';
import { resourceId, botKeySchema, metadata } from './identity.js';
const plain = z
  .string()
  .max(2048)
  .refine((s) => !hasCredential(s) && !/[\r\n\0]|\$\(|\$\{|!!js|`/u.test(s));
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const connectorInputSchema = z
  .strictObject({
    id: resourceId,
    label: plain.min(1).max(120),
    templateId: z.enum(['github', 'filesystem', 'browser', 'notion', 'custom']).default('custom'),
    templateVersion: z.literal(1).default(1),
    serverName: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .refine((v) => v !== 'bot_memory_graph'),
    transport: z.enum(['stdio', 'streamable-http']),
    command: plain.optional(),
    args: z.array(plain).max(64).default([]),
    url: z.string().max(2048).optional(),
    literalEnv: z.partialRecord(z.enum(['LANG', 'LC_ALL', 'TZ', 'NODE_ENV']), plain).default({}),
    literalHeaders: z
      .partialRecord(
        z.enum(['Accept', 'Content-Type']),
        z.enum(['application/json', 'text/event-stream', 'application/json, text/event-stream']),
      )
      .default({}),
    credentialBindings: z
      .array(
        z.strictObject({
          destination: z.enum(['env', 'header']),
          key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
          credentialRef: envKey,
          format: z.enum(['raw', 'bearer', 'basic-token']),
        }),
      )
      .max(32)
      .default([]),
    enabled: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    const bad = () =>
      ctx.addIssue({ code: 'custom', message: 'Invalid connector configuration; use credential references' });
    if (v.transport === 'stdio') {
      if (!v.command?.startsWith('/') || v.url || Object.keys(v.literalHeaders).length) bad();
    } else {
      try {
        const url = new URL(v.url ?? '');
        if (
          !['https:', 'http:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          hasCredential(url.pathname)
        )
          bad();
      } catch {
        bad();
      }
      if (v.command || v.args.length || Object.keys(v.literalEnv).length) bad();
    }
    if (
      v.args.some((a) =>
        /(?:token|secret|password|authorization|api[_-]?key)(?:[=:]|$)|https?:\/\/[^\s]*[?@]|\bBearer\s|\bBasic\s/iu.test(
          a,
        ),
      )
    )
      bad();
    const keys = new Set<string>();
    for (const b of v.credentialBindings) {
      const key = `${b.destination}:${b.key.toLowerCase()}`;
      if (
        keys.has(key) ||
        (v.transport === 'stdio') !== (b.destination === 'env') ||
        (b.destination === 'env' && (b.format !== 'raw' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.key))) ||
        b.key in v.literalEnv ||
        Object.keys(v.literalHeaders).some((k) => k.toLowerCase() === b.key.toLowerCase())
      )
        bad();
      keys.add(key);
    }
  });
export const connectorSchema = connectorInputSchema.safeExtend(metadata);
export type Connector = z.output<typeof connectorSchema>;
export const connectorOverridesSchema = z.strictObject({
  args: z.array(plain).max(64).optional(),
  literalEnv: connectorInputSchema.shape.literalEnv.optional(),
  literalHeaders: connectorInputSchema.shape.literalHeaders.optional(),
});
export const assignmentInputSchema = z.strictObject({
  id: resourceId,
  bot: botKeySchema,
  connectorId: resourceId,
  enabled: z.boolean(),
  overrides: connectorOverridesSchema.default({}),
});
export const assignmentSchema = assignmentInputSchema.extend({
  ...metadata,
  desiredRevision: z.number().int().positive(),
});
export type Assignment = z.output<typeof assignmentSchema>;
export const connectorRuntimeSchema = z.strictObject({
  assignmentId: resourceId,
  sessionId: z.string(),
  desiredRevision: z.number().int(),
  appliedRevision: z.number().int().optional(),
  state: z.enum(['pending', 'connecting', 'ready', 'unavailable', 'disabled']),
  reasonCode: z
    .enum([
      'saved',
      'busy',
      'missing-credential',
      'initialization-failed',
      'namespace-conflict',
      'stopping',
      'revoked',
      'agent-closed',
    ])
    .optional(),
  toolCount: z.number().int().nonnegative(),
});
export type ConnectorRuntime = z.output<typeof connectorRuntimeSchema>;
export const legacyImportSchema = z.strictObject({
  id: resourceId,
  bot: botKeySchema,
  digest: z.string(),
  assignmentIds: z.array(resourceId),
  ...metadata,
});
export const CONNECTOR_TEMPLATES = ['github', 'filesystem', 'browser', 'notion'] as const;
