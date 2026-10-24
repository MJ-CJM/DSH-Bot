import { z } from 'zod';
import { botIdSchema } from './ids.js';
import { hasCredential } from './secrets.js';
export const P34_TEXT_MAX_BYTES = 8192;
export const p34Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
export const botKeySchema = z.strictObject({ botId: botIdSchema, botCreatedAt: z.number().int().nonnegative() });
export type BotKey = z.output<typeof botKeySchema>;
export const sameBot = (a: BotKey, b: BotKey) => a.botId === b.botId && a.botCreatedAt === b.botCreatedAt;
const plain = z.string().max(2048).refine(s => !hasCredential(s) && !/[\r\n\0]|\$\(|\$\{|!!js|`/u.test(s));
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const connectorInputSchema = z.strictObject({
  id: p34Id, label: plain.min(1).max(120), templateId: z.enum(['github', 'filesystem', 'browser', 'notion', 'custom']).default('custom'),
  templateVersion: z.literal(1).default(1), serverName: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  transport: z.enum(['stdio', 'streamable-http']), command: plain.optional(), args: z.array(plain).max(64).default([]),
  url: z.string().max(2048).optional(),
  literalEnv: z.partialRecord(z.enum(['LANG', 'LC_ALL', 'TZ', 'NODE_ENV']), plain).default({}),
  literalHeaders: z.partialRecord(z.enum(['Accept', 'Content-Type']), z.enum(['application/json', 'text/event-stream', 'application/json, text/event-stream'])).default({}),
  credentialBindings: z.array(z.strictObject({ destination: z.enum(['env', 'header']), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/),
    credentialRef: envKey, format: z.enum(['raw', 'bearer', 'basic-token']) })).max(32).default([]), enabled: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const bad = () => ctx.addIssue({ code: 'custom', message: 'Invalid connector configuration; use credential references' });
  if (v.transport === 'stdio') {
    if (!v.command?.startsWith('/') || v.url || Object.keys(v.literalHeaders).length) bad();
  } else {
    try { const url = new URL(v.url ?? ''); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || hasCredential(url.pathname)) bad(); } catch { bad(); }
    if (v.command || v.args.length || Object.keys(v.literalEnv).length) bad();
  }
  if (v.args.some(a => /(?:token|secret|password|authorization|api[_-]?key)(?:[=:]|$)|https?:\/\/[^\s]*[?@]|\bBearer\s|\bBasic\s/iu.test(a))) bad();
  const keys = new Set<string>();
  for (const b of v.credentialBindings) {
    const key = `${b.destination}:${b.key.toLowerCase()}`;
    if (keys.has(key) || (v.transport === 'stdio') !== (b.destination === 'env') || b.destination === 'env' && (b.format !== 'raw' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.key))
      || b.key in v.literalEnv || Object.keys(v.literalHeaders).some(k => k.toLowerCase() === b.key.toLowerCase())) bad();
    keys.add(key);
  }
});
const metadata = { revision: z.number().int().positive(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), schemaVersion: z.literal(1) };
export const connectorSchema = connectorInputSchema.safeExtend(metadata);
export type Connector = z.output<typeof connectorSchema>;
export const connectorOverridesSchema = z.strictObject({
  args: z.array(plain).max(64).optional(), literalEnv: connectorInputSchema.shape.literalEnv.optional(), literalHeaders: connectorInputSchema.shape.literalHeaders.optional(),
});
export const assignmentInputSchema = z.strictObject({ id: p34Id, bot: botKeySchema, connectorId: p34Id, enabled: z.boolean(), overrides: connectorOverridesSchema.default({}) });
export const assignmentSchema = assignmentInputSchema.extend({ ...metadata, desiredRevision: z.number().int().positive() });
export type Assignment = z.output<typeof assignmentSchema>;
export const connectorRuntimeSchema = z.strictObject({ assignmentId: p34Id, sessionId: z.string(), desiredRevision: z.number().int(), appliedRevision: z.number().int().optional(),
  state: z.enum(['pending', 'connecting', 'ready', 'unavailable', 'disabled']), reasonCode: z.enum(['saved', 'busy', 'missing-credential', 'initialization-failed', 'namespace-conflict', 'stopping', 'revoked', 'agent-closed']).optional(), toolCount: z.number().int().nonnegative() });
export type ConnectorRuntime = z.output<typeof connectorRuntimeSchema>;
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const policyInputSchema = z.strictObject({ id: p34Id, owner: botKeySchema, channel: z.enum(['in-app', 'im']), targetRef: p34Id.optional(), enabled: z.boolean(),
  timezone: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  quietHours: z.strictObject({ start: time, end: time }).optional(), dailyLimit: z.number().int().min(0).max(1000), cooldownSec: z.number().int().min(0).max(86400),
  authorization: z.strictObject({ mode: z.enum(['ask', 'preapproved']) }),
}).refine(v => v.channel !== 'im' || v.targetRef !== undefined);
export const policySchema = policyInputSchema.safeExtend({ ...metadata, scopeDigest: z.string(), targetDigest: z.string(), approvedAt: z.number().optional() });
export type NotificationPolicy = z.output<typeof policySchema>;
export const notifyInputSchema = z.strictObject({ operationId: p34Id, policyId: p34Id, text: z.string().min(1).refine(v => new TextEncoder().encode(v).length <= P34_TEXT_MAX_BYTES),
  relatedId: p34Id.optional() });
export type NotifyInput = z.output<typeof notifyInputSchema>;
export const notificationState = z.enum(['recorded', 'waiting_approval', 'suppressed', 'sending', 'accepted', 'failed', 'unknown', 'cancelled']);
export const notificationSchema = z.strictObject({ id: p34Id, operationId: p34Id, owner: botKeySchema, policyId: p34Id, policyRevision: z.number().int(),
  targetDigest: z.string(), scopeDigest: z.string(), text: z.string().refine(v => new TextEncoder().encode(v).length <= P34_TEXT_MAX_BYTES),
  source: z.strictObject({ kind: z.enum(['tool', 'manual-run', 'group-turn', 'schedule']), id: z.string(), sessionId: z.string().optional() }),
  state: notificationState, reasonCode: z.enum(['quiet-hours', 'daily-limit', 'cooldown', 'disabled', 'approval-denied', 'changed', 'unsupported', 'stopping', 'transport-failed', 'recovery-needed']).optional(),
  reservation: z.strictObject({ at: z.number(), day: z.string() }).optional(), readAt: z.number().optional(), attemptId: p34Id.optional(),
  platformMessageId: z.string().max(200).optional(), ...metadata });
export type NotificationRecord = z.output<typeof notificationSchema>;
export const receiptSchema = z.strictObject({ id: p34Id, intentId: p34Id, attemptId: p34Id, channel: z.enum(['in-app', 'im']), state: notificationState, acceptedAt: z.number().optional(), platformMessageId: z.string().max(200).optional(), ...metadata });
export const legacyImportSchema = z.strictObject({ id: p34Id, bot: botKeySchema, digest: z.string(), assignmentIds: z.array(p34Id), ...metadata });
export const p34CatalogSchema = z.strictObject({ definitions: z.array(connectorSchema), assignments: z.array(assignmentSchema), runtime: z.array(connectorRuntimeSchema),
  policies: z.array(policySchema), notifications: z.array(notificationSchema), unread: z.number().int().nonnegative(), imSupported: z.boolean(), desktopSupported: z.literal(false),
  defaults: z.strictObject({ dailyLimit: z.number(), cooldownSec: z.number() }) });
export type P34Catalog = z.output<typeof p34CatalogSchema>;
export const CONNECTOR_TEMPLATES = ['github', 'filesystem', 'browser', 'notion'] as const;
