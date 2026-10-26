import { z } from 'zod';
import { botIdSchema, memoryIdSchema } from './ids.js';

export const MEMORY_MAX_BYTES = 2 * 1024;
export const AVATAR_MAX_BYTES = 64 * 1024;
/** Reviewed palette IDs; the first four retain their legacy theme-alias IDs. */
export const AVATAR_COLOR_TOKENS = [
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-error-primary',
  'teal',
  'cyan',
  'indigo',
  'purple',
  'rose',
  'orange',
  'olive',
  'slate',
] as const;
export const avatarColorSchema = z.enum(AVATAR_COLOR_TOKENS);
export type AvatarColor = z.infer<typeof avatarColorSchema>;
export const AVATAR_VARIANTS = ['classic', 'glasses', 'spout', 'baby', 'hat', 'sleeping'] as const;
export type WhaleVariant = (typeof AVATAR_VARIANTS)[number];
export const avatarVariantSchema = z.enum([...AVATAR_VARIANTS, 'auto']);
export type AvatarVariant = z.infer<typeof avatarVariantSchema>;
export const MEMORY_LIST_MAX_LIMIT = 200;
export const BOT_NAME_MAX_CHARS = 64;
export const PERSONA_PREFIX_MAX_BYTES = 16 * 1024;
export const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
/** Equality only: preserve the original text in storage, including its case. */
export const normalizeMemoryContent = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export interface MemorySaveResult {
  id: string;
  deduplicated: boolean;
}
export const timestampSchema = z.number().int().nonnegative();
const nonempty = z.string().trim().min(1);
/** Existing example-seed rows remain valid; workspace identity is a separate row. */
export const botRegistryStateSchema = z
  .strictObject({
    status: z.enum(['pending', 'complete']).optional(),
    botsWorkspaceId: nonempty.optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.botsWorkspaceId !== undefined,
    'Registry state must not be empty',
  );
// Browser-safe syntax validation; the Host additionally applies its platform's
// absolute-path rules and checks the existing directory before a write.
export const absoluteDirectorySchema = nonempty.refine(
  (value) =>
    !value.includes('\0') &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value)),
  'Expected an absolute directory path',
);
// JSON omits undefined properties. Canonicalize records, but not patches:
// explicit undefined in a patch must still clear the previous optional value.
function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    ) as T;
  }
  return value;
}
const emojiSegments = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const avatarSchema = z
  .string()
  .refine((value) => utf8Bytes(value) <= AVATAR_MAX_BYTES, 'Avatar exceeds 64 KiB')
  .refine(
    (value) =>
      (/^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        value,
      ) &&
        value.split(',')[1] !== '') ||
      ([...emojiSegments.segment(value)].length === 1 &&
        /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)),
    'Expected an emoji or base64 PNG, JPEG, GIF or WebP data URL',
  );

export const mcpServerRefSchema = z.strictObject({
  serverName: nonempty,
  transport: z.enum(['stdio', 'streamable-http']),
  command: nonempty.optional(),
  args: z.array(z.string()).optional(),
  url: z.url().optional(),
  envRefs: z.record(z.string(), nonempty).optional(),
});
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const channelBindingSchema = z.strictObject({
  kind: z.enum(['feishu', 'telegram', 'slack', 'email', 'desktop']),
  target: nonempty,
  credentialRef: nonempty.optional(),
  policy: z.strictObject({
    quietHours: z.tuple([clockTime, clockTime]).optional(),
    dailyLimit: z.number().int().nonnegative(),
    cooldownSec: z.number().nonnegative(),
  }),
});

const botFields = z.strictObject({
  name: nonempty.refine((value) => [...value].length <= BOT_NAME_MAX_CHARS, 'Name exceeds 64 characters'),
  avatar: avatarSchema.optional(),
  avatarColor: avatarColorSchema.optional(),
  avatarVariant: avatarVariantSchema.optional(),
  description: z.string(),
  persona: z.strictObject({
    prefix: z.string().refine((value) => utf8Bytes(value) <= PERSONA_PREFIX_MAX_BYTES, 'Persona prefix exceeds 16 KiB'),
    suffix: z.string().optional(),
    complete: z.boolean().optional(),
  }),
  template: z.enum(['standard', 'minimal']),
  model: z.strictObject({ provider: nonempty, model: nonempty, reasoningEffort: nonempty.optional() }).optional(),
  tools: z.strictObject({ deny: z.array(nonempty) }),
  skills: z.strictObject({ extraDirs: z.array(nonempty) }),
  memory: z.strictObject({ enabled: z.boolean(), injectLimit: z.number().int().nonnegative() }),
  defaultCwd: absoluteDirectorySchema.optional(),
  mcpServers: z.array(mcpServerRefSchema),
  channels: z.array(channelBindingSchema),
  order: z.number().finite().optional(),
});

export const botRecordFields = botFields.extend({
  id: botIdSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  schemaVersion: z.literal(1),
});
export const botSchema = botRecordFields
  .refine((record) => record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt')
  .transform(withoutUndefined);

export const botCreateSchema = botFields.extend({
  id: botIdSchema,
  description: botFields.shape.description.default(''),
  persona: botFields.shape.persona.default({ prefix: '' }),
  template: botFields.shape.template.default('standard'),
  tools: botFields.shape.tools.default({ deny: [] }),
  skills: botFields.shape.skills.default({ extraDirs: [] }),
  memory: botFields.shape.memory.default({ enabled: true, injectLimit: 20 }),
  mcpServers: botFields.shape.mcpServers.default([]),
  channels: botFields.shape.channels.default([]),
});
/** Patches replace whole top-level fields; identity and metadata are never writable.
 * JSON cannot carry undefined properties, so optional top-level fields also accept
 * null as an explicit clear. Keep null on the wire and normalize only on the Host.
 */
const botPatchFields = botFields.partial();
export const botPatchSchema = botPatchFields.extend({
  avatar: botFields.shape.avatar.nullable(),
  avatarColor: botFields.shape.avatarColor.nullable(),
  avatarVariant: botFields.shape.avatarVariant.nullable(),
  model: botFields.shape.model.nullable(),
  defaultCwd: botFields.shape.defaultCwd.nullable(),
  order: botFields.shape.order.nullable(),
});
export const botRemoveOptionsSchema = z.strictObject({
  deleteMemories: z.boolean().default(true),
  deleteHome: z.boolean().default(false),
});
export type BotRemoveOptions = z.input<typeof botRemoveOptionsSchema>;

export const memoryFields = z.strictObject({
  kind: z.enum(['profile', 'preference', 'fact', 'note']),
  content: nonempty.refine((value) => utf8Bytes(value) <= MEMORY_MAX_BYTES, {
    message: 'Memory exceeds 2 KiB',
    params: { code: 'memory/too-large' },
  }),
  tags: z.array(nonempty),
  pinned: z.boolean(),
  source: z
    .strictObject({ sessionId: nonempty.optional(), at: timestampSchema, by: z.enum(['model', 'user']) })
    .optional(),
});
export const memorySchema = memoryFields
  .extend({
    id: memoryIdSchema,
    botId: botIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .refine((record) => record.updatedAt >= record.createdAt, 'updatedAt precedes createdAt')
  .transform(withoutUndefined);
export const memoryAddSchema = memoryFields.extend({
  botId: botIdSchema,
  kind: memoryFields.shape.kind.default('note'),
  tags: memoryFields.shape.tags.default([]),
  pinned: memoryFields.shape.pinned.default(false),
});
export const memoryPatchSchema = memoryFields.partial();

/** Stable descending pin/time order, with ascending id as a deterministic tie-break. */
export const memoryCursorSchema = z.strictObject({
  pinned: z.boolean(),
  updatedAt: timestampSchema,
  id: memoryIdSchema,
});
export const memoryListOptionsSchema = z.strictObject({
  query: z.string().optional(),
  tag: nonempty.optional(),
  pinned: z.boolean().optional(),
  limit: z.number().int().positive().max(MEMORY_LIST_MAX_LIMIT),
  before: memoryCursorSchema.optional(),
});

export type BotRecord = z.infer<typeof botSchema>;
export type BotCreateInput = z.input<typeof botCreateSchema>;
export type BotPatch = z.input<typeof botPatchSchema>;
export function normalizeBotPatch(patch: BotPatch): z.output<typeof botPatchFields> {
  const { avatar, avatarColor, avatarVariant, model, defaultCwd, order, ...fields } = patch;
  return {
    ...fields,
    ...('avatar' in patch ? { avatar: avatar ?? undefined } : {}),
    ...('avatarColor' in patch ? { avatarColor: avatarColor ?? undefined } : {}),
    ...('avatarVariant' in patch ? { avatarVariant: avatarVariant ?? undefined } : {}),
    ...('model' in patch ? { model: model ?? undefined } : {}),
    ...('defaultCwd' in patch ? { defaultCwd: defaultCwd ?? undefined } : {}),
    ...('order' in patch ? { order: order ?? undefined } : {}),
  };
}
export type MemoryRecord = z.infer<typeof memorySchema>;
export type MemoryAddInput = z.input<typeof memoryAddSchema>;
export type MemoryPatch = z.input<typeof memoryPatchSchema>;
export type MemoryCursor = z.infer<typeof memoryCursorSchema>;
export type MemoryListOptions = z.input<typeof memoryListOptionsSchema>;
