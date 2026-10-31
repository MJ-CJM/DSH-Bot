import { createForChatSchema, startOnboardingSchema, onboardingStatusSchema } from './onboarding.js';
import { autoShareStatusSchema, autoShareToggleSchema } from './data-flow.js';
import { memoryQuerySchema, memoryCreateSchema, memoryReviseSchema, memoryConfirmSchema,
  memoryResolveSchema, memoryPageSchema } from './memory-management.js';
/** Hand-authored, browser-safe contract for the locked DSH release's public Typert API. */
import type { RemoteResult, RemoteStreamHandle, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { forgetSelectionSchema, forgetPreviewSchema, forgetChoiceSchema, cleanupStatusSchema,
  rootInstructionsSchema } from './memory-forget.js';
import { botIdSchema, memoryIdSchema } from './ids.js';
import { activityListResultSchema, activitySessionIdSchema, activitySessionSchema } from './activity.js';
export type { ActivityRecord, ActivitySession, ActivityListResult } from './activity.js';
import {
  absoluteDirectorySchema,
  botCreateSchema,
  botPatchSchema,
  botRemoveOptionsSchema,
  botSchema,
  memoryAddSchema,
  memoryListOptionsSchema,
  memoryPatchSchema,
  memorySchema,
} from './schema.js';

export const botStatusSchema = z.strictObject({
  id: botIdSchema,
  presetId: z.string().min(1),
  mainSessionId: z.string().min(1).optional(),
  warnings: z.array(z.enum(['avatar/invalid'])).optional(),
  preset: z.strictObject({ state: z.enum(['ok', 'broken', 'missing']), reason: z.string().optional() }),
});
export const catalogInfoSchema = z.strictObject({ presetIdPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/) });
export type CatalogInfo = z.output<typeof catalogInfoSchema>;
export type BotStatus = z.output<typeof botStatusSchema>;
export const botHomeSchema = z.strictObject({ path: absoluteDirectorySchema });
export type BotHome = z.output<typeof botHomeSchema>;
export const botsWorkspaceSchema = z.strictObject({ workspaceId: z.string().min(1), path: absoluteDirectorySchema });
export type BotsWorkspace = z.output<typeof botsWorkspaceSchema>;
// Process-local invalidation only: consumers always re-read authoritative data.
// No persisted revision, user text, paths or credential-shaped payloads travel here.
export const botChangeSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type BotChange = z.output<typeof botChangeSchema>;

// UI may choose the Bot, never the persisted identity or provenance of a memory.
export const memoryRemoteSaveSchema = memoryAddSchema.omit({ botId: true, source: true });
export const memoryRemotePatchSchema = memoryPatchSchema.omit({ source: true });
export const memoryRemoteListSchema = memoryListOptionsSchema
  .omit({ query: true })
  .extend({ limit: memoryListOptionsSchema.shape.limit.optional() });
export const memoryRemoteSearchSchema = memoryRemoteListSchema.extend({ query: z.string() });
export type MemoryRemoteSaveInput = z.input<typeof memoryRemoteSaveSchema>;
export type MemoryRemotePatch = z.input<typeof memoryRemotePatchSchema>;
export type MemoryRemoteListInput = z.input<typeof memoryRemoteListSchema>;
export type MemoryRemoteSearchInput = z.input<typeof memoryRemoteSearchSchema>;

type ParameterInput<Parameter> = Parameter extends {
  readonly codec: { readonly create: () => infer Schema extends z.ZodType };
}
  ? z.input<Schema>
  : never;
type RequiredParameters<Parameters extends readonly unknown[]> = {
  -readonly [Index in keyof Parameters]: ParameterInput<Parameters[Index]>;
};
/** Optional final wire parameters remain optional in the business call signature. */
type MethodParameters<Parameters extends readonly unknown[]> = Parameters extends readonly [
  ...infer Required,
  infer Last,
]
  ? Last extends { readonly acceptsUndefined: true }
    ? [...RequiredParameters<Required>, options?: Exclude<ParameterInput<Last>, undefined>]
    : RequiredParameters<Parameters>
  : [];

/** Signatures are derived from the same ordered schema tuples used by the codec. */
type HostMethods<Namespace extends string> = {
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as (typeof dshBotRemoteSpec.methods)[Endpoint] extends {
    readonly implementation: infer Implementation extends string;
  }
    ? Endpoint extends `${Namespace}/${string}`
      ? Implementation
      : never
    : Endpoint extends `${Namespace}/${infer Method}`
      ? Method
      : never]: (typeof dshBotRemoteSpec.methods)[Endpoint] extends { readonly mode: 'stream' }
    ? (
        signal: AbortSignal,
      ) => AsyncIterable<z.output<ReturnType<(typeof dshBotRemoteSpec.methods)[Endpoint]['result']['create']>>>
    : (
        ...args: MethodParameters<(typeof dshBotRemoteSpec.methods)[Endpoint]['parameters']>
      ) => Promise<z.output<ReturnType<(typeof dshBotRemoteSpec.methods)[Endpoint]['result']['create']>>>;
};
export type DshBotMethods = HostMethods<'dshBot'>;
export type DshBotMemoryMethods = HostMethods<'dshBot.memory'>;
export type DshBotActivityMethods = HostMethods<'dshBot.activity'>;

type RemoteMethods<Namespace extends string> = {
  // rc.2's Gateway enforces the descriptor arity even for acceptsUndefined.
  // Call delete(id, undefined) when using the Host's default removal options.
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as Endpoint extends `${Namespace}/${infer Method}`
    ? Method
    : never]: (typeof dshBotRemoteSpec.methods)[Endpoint] extends { readonly mode: 'stream' }
    ? (
        signal?: AbortSignal,
      ) => RemoteStreamHandle<
        z.output<ReturnType<(typeof dshBotRemoteSpec.methods)[Endpoint]['result']['create']>>,
        never
      >
    : (
        ...args: RequiredParameters<(typeof dshBotRemoteSpec.methods)[Endpoint]['parameters']>
      ) => Promise<RemoteResult<z.output<ReturnType<(typeof dshBotRemoteSpec.methods)[Endpoint]['result']['create']>>>>;
};
export type DshBotMemoryRemoteMethods = RemoteMethods<'dshBot.memory'>;
export type DshBotActivityRemoteMethods = RemoteMethods<'dshBot.activity'>;
export type DshBotRemoteMethods = RemoteMethods<'dshBot'> & {
  memory: DshBotMemoryRemoteMethods;
  activity: DshBotActivityRemoteMethods;
};
type DshBotRemoteEndpoints = {
  [Method in keyof RemoteMethods<'dshBot'> as `dshBot/${Method}`]: RemoteMethods<'dshBot'>[Method];
} & {
  [Method in keyof DshBotMemoryRemoteMethods as `dshBot.memory/${Method}`]: DshBotMemoryRemoteMethods[Method];
} & {
  [Method in keyof DshBotActivityRemoteMethods as `dshBot.activity/${Method}`]: DshBotActivityRemoteMethods[Method];
};

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends DshBotRemoteEndpoints {}
  interface TypertRemoteNamespaceMap {
    dshBot: DshBotRemoteMethods;
    'dshBot.memory': DshBotMemoryRemoteMethods;
    'dshBot.activity': DshBotActivityRemoteMethods;
  }
  interface RemoteErrorDetailsMap {
    'bot/not-found': Record<string, never>;
    'bot/conflict': Record<string, never>;
    'bot/invalid': Record<string, never>;
    'bot/preset-failed': Record<string, never>;
    'bot/rollback-failed': Record<string, never>;
    'bot/unavailable': Record<string, never>;
    'bot/home-cleanup-failed': Record<string, never>;
    'memory/not-found': Record<string, never>;
    'memory/too-large': Record<string, never>;
    'memory/rejected': Record<string, never>;
    'store/unavailable': Record<string, never>;
    'activity/not-found': Record<string, never>;
  }
}

const codec = <Schema extends z.ZodType>(type: string, schema: Schema) => ({
  mode: 'strict' as const,
  typeSymbol: `dsh-bot#${type}`,
  create: () => schema,
});
// rc.2 only invokes explicit result encode/decode hooks; mode/create alone
// describe a parser but do not validate the Host response or Client wire value.
const activityResultCodec = <Schema extends z.ZodType>(type: string, schema: Schema) => ({
  ...codec(type, schema),
  encode: (value: unknown) => schema.parse(value),
  decode: (value: unknown) => schema.parse(value),
});
const parameter = <Schema extends z.ZodType>(name: string, type: string, schema: Schema) => {
  const value = codec(type, schema);
  return { name, source: 'json' as const, codec: value, strictCodec: value };
};
const owner = { service: 'dshBots', invocation: { kind: 'direct' as const } };
const memoryOwner = { service: 'dshBotMemory', invocation: { kind: 'direct' as const } };
const activityOwner = { service: 'dshBotActivity', invocation: { kind: 'direct' as const } };
const id = parameter('id', 'BotId', botIdSchema);
const botId = parameter('botId', 'BotId', botIdSchema);
const memoryId = parameter('id', 'MemoryId', memoryIdSchema);
const bot = codec('BotRecord', botSchema);
const memories = codec('MemoryRecord[]', z.array(memorySchema));

/** Both Host descriptors and Client codecs are assembled from this single spec. */
export const dshBotRemoteSpec = {
  package: 'dsh-bot',
  methods: {
    'dshBot/watch': {
      ...owner,
      mode: 'stream',
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: activityResultCodec('BotChange', botChangeSchema),
    },
    // Zero parameters deliberately support activity.list() on rc.2, whose
    // Client enforces exact arity even for optional descriptor parameters.
    'dshBot.activity/list': {
      ...activityOwner,
      parameters: [],
      result: activityResultCodec('ActivityListResult', activityListResultSchema),
    },
    'dshBot.activity/markRead': {
      ...activityOwner,
      parameters: [parameter('sessionId', 'ActivitySessionId', activitySessionIdSchema)],
      result: activityResultCodec('ActivitySession', activitySessionSchema),
    },
    'dshBot/list': { ...owner, parameters: [], result: codec('BotRecord[]', z.array(botSchema)) },
    'dshBot/catalogInfo': { ...owner, parameters: [], result: codec('CatalogInfo', catalogInfoSchema) },
    'dshBot/status': { ...owner, parameters: [], result: codec('BotStatus[]', z.array(botStatusSchema)) },
    'dshBot/get': { ...owner, parameters: [id], result: bot },
    'dshBot/openConversation': {
      ...owner,
      parameters: [botId],
      result: activityResultCodec('MainSession', z.strictObject({ sessionId: z.string().min(1) })),
    },
    'dshBot/ensureHome': { ...owner, parameters: [botId], result: activityResultCodec('BotHome', botHomeSchema) },
    'dshBot/ensureBotsWorkspace': {
      ...owner,
      parameters: [],
      result: activityResultCodec('BotsWorkspace', botsWorkspaceSchema),
    },
    'dshBot/createForChat': { ...owner, parameters: [parameter('input', 'CreateForChatInput', createForChatSchema)], result: bot },
    'dshBot/startOnboarding': { ...owner, parameters: [parameter('input', 'StartOnboardingInput', startOnboardingSchema)], result: activityResultCodec('OnboardingStatus', onboardingStatusSchema) },
    'dshBot/retryOnboarding': { ...owner, parameters: [parameter('input', 'StartOnboardingInput', startOnboardingSchema)], result: activityResultCodec('OnboardingStatus', onboardingStatusSchema) },
    'dshBot/onboardingStatus': { ...owner, parameters: [botId], result: activityResultCodec('OnboardingStatus', onboardingStatusSchema) },
    'dshBot/create': { ...owner, parameters: [parameter('input', 'BotCreateInput', botCreateSchema)], result: bot },
    'dshBot/update': { ...owner, parameters: [id, parameter('patch', 'BotPatch', botPatchSchema)], result: bot },
    'dshBot/duplicate': { ...owner, parameters: [id, parameter('newId', 'BotId', botIdSchema)], result: bot },
    // "remove" is reserved by rc.2's Client namespace service.
    'dshBot/delete': {
      ...owner,
      implementation: 'remove',
      parameters: [
        id,
        {
          ...parameter('options', 'BotRemoveOptions | undefined', botRemoveOptionsSchema.optional()),
          acceptsUndefined: true,
        },
      ],
      result: codec('void', z.void()),
    },
    'dshBot.memory/autoShareStatus': {
      ...memoryOwner, parameters: [], result: activityResultCodec('AutoShareStatus', autoShareStatusSchema),
    },
    'dshBot.memory/setAutoShare': {
      ...memoryOwner, parameters: [parameter('input', 'AutoShareToggle', autoShareToggleSchema)],
      result: activityResultCodec('AutoShareStatus', autoShareStatusSchema),
    },
    'dshBot.memory/query': {
      ...memoryOwner, parameters: [parameter('input', 'queryInput', memoryQuerySchema)],
      result: activityResultCodec('ManagedMemoryPage', memoryPageSchema),
    },
    'dshBot.memory/createManaged': {
      ...memoryOwner, parameters: [parameter('input', 'createManagedInput', memoryCreateSchema)],
      result: activityResultCodec('MemoryId', z.uuid()),
    },
    'dshBot.memory/revise': {
      ...memoryOwner, parameters: [parameter('input', 'reviseInput', memoryReviseSchema)],
      result: activityResultCodec('void', z.void()),
    },
    'dshBot.memory/confirm': {
      ...memoryOwner, parameters: [parameter('input', 'confirmInput', memoryConfirmSchema)],
      result: activityResultCodec('MemoryId', z.uuid()),
    },
    'dshBot.memory/resolve': {
      ...memoryOwner, parameters: [parameter('input', 'resolveInput', memoryResolveSchema)],
      result: activityResultCodec('void', z.void()),
    },
    'dshBot.memory/previewContribution': {
      ...memoryOwner, parameters: [parameter('input', 'previewContributionInput', z.uuid())],
      result: activityResultCodec('ForgetPreview', forgetPreviewSchema),
    },
    'dshBot.memory/previewShared': {
      ...memoryOwner, parameters: [parameter('input', 'previewSharedInput', forgetSelectionSchema)],
      result: activityResultCodec('ForgetPreview', forgetPreviewSchema),
    },
    'dshBot.memory/list': {
      ...memoryOwner,
      parameters: [botId, parameter('options', 'MemoryRemoteListInput', memoryRemoteListSchema)],
      result: memories,
    },
    'dshBot.memory/search': {
      ...memoryOwner,
      parameters: [botId, parameter('input', 'MemoryRemoteSearchInput', memoryRemoteSearchSchema)],
      result: memories,
    },
    'dshBot.memory/save': {
      ...memoryOwner,
      parameters: [botId, parameter('input', 'MemoryRemoteSaveInput', memoryRemoteSaveSchema)],
      result: codec('MemorySaveResult', z.strictObject({ id: memoryIdSchema, deduplicated: z.boolean() })),
    },
    'dshBot.memory/update': {
      ...memoryOwner,
      parameters: [botId, memoryId, parameter('patch', 'MemoryRemotePatch', memoryRemotePatchSchema)],
      result: codec('MemoryRecord', memorySchema),
    },
    'dshBot.memory/delete': {
      ...memoryOwner,
      implementation: 'remove',
      parameters: [botId, memoryId],
      result: codec('void', z.void()),
    },
    'dshBot.memory/quarantineCount': {
      ...memoryOwner,
      parameters: [],
      result: activityResultCodec('MemoryQuarantineCount', z.number().int().nonnegative()),
    },
    'dshBot.memory/count': {
      ...memoryOwner,
      parameters: [botId],
      result: codec('MemoryCount', z.number().int().nonnegative()),
    },
    'dshBot.memory/previewForget': {
      ...memoryOwner, parameters: [botId, parameter('selection', 'ForgetSelection', forgetSelectionSchema)],
      result: activityResultCodec('ForgetPreview', forgetPreviewSchema),
    },
    'dshBot.memory/chooseForget': {
      ...memoryOwner, parameters: [parameter('choice', 'ForgetChoice', forgetChoiceSchema)],
      result: activityResultCodec('CleanupStatus', cleanupStatusSchema),
    },
    'dshBot.memory/cleanupStatuses': {
      ...memoryOwner, parameters: [], result: activityResultCodec('CleanupStatus[]', z.array(cleanupStatusSchema)),
    },
    'dshBot.memory/retryCleanup': {
      ...memoryOwner, parameters: [parameter('id', 'CleanupId', z.uuid())],
      result: activityResultCodec('CleanupStatus', cleanupStatusSchema),
    },
    'dshBot.memory/rootInstructions': {
      ...memoryOwner, parameters: [], result: activityResultCodec('RootInstructions', rootInstructionsSchema),
    },
  },
} as const satisfies TypertRemoteSpec;
