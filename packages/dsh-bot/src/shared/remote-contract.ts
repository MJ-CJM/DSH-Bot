/** Hand-authored, browser-safe contract for the locked DSH release's public Typert API. */
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { botIdSchema, memoryIdSchema } from './ids.js';
import {
  botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema,
  memoryAddSchema, memoryListOptionsSchema, memoryPatchSchema, memorySchema,
} from './schema.js';

export const botStatusSchema = z.strictObject({
  id: botIdSchema,
  presetId: z.string().min(1),
  warnings: z.array(z.enum(['avatar/invalid'])).optional(),
  preset: z.strictObject({ state: z.enum(['ok', 'broken', 'missing']), reason: z.string().optional() }),
});
export const catalogInfoSchema = z.strictObject({ presetIdPrefix: z.string().regex(/^[a-z][a-z0-9-]*$/) });
export type CatalogInfo = z.output<typeof catalogInfoSchema>;
export type BotStatus = z.output<typeof botStatusSchema>;

// UI may choose the Bot, never the persisted identity or provenance of a memory.
export const memoryRemoteSaveSchema = memoryAddSchema.omit({ botId: true, source: true });
export const memoryRemotePatchSchema = memoryPatchSchema.omit({ source: true });
export const memoryRemoteListSchema = memoryListOptionsSchema.omit({ query: true })
  .extend({ limit: memoryListOptionsSchema.shape.limit.optional() });
export const memoryRemoteSearchSchema = memoryRemoteListSchema.extend({ query: z.string() });
export type MemoryRemoteSaveInput = z.input<typeof memoryRemoteSaveSchema>;
export type MemoryRemotePatch = z.input<typeof memoryRemotePatchSchema>;
export type MemoryRemoteListInput = z.input<typeof memoryRemoteListSchema>;
export type MemoryRemoteSearchInput = z.input<typeof memoryRemoteSearchSchema>;

type ParameterInput<Parameter> = Parameter extends { readonly codec: { readonly create: () => infer Schema extends z.ZodType } }
  ? z.input<Schema> : never;
type RequiredParameters<Parameters extends readonly unknown[]> = {
  -readonly [Index in keyof Parameters]: ParameterInput<Parameters[Index]>;
};
/** Optional final wire parameters remain optional in the business call signature. */
type MethodParameters<Parameters extends readonly unknown[]> = Parameters extends readonly [...infer Required, infer Last]
  ? Last extends { readonly acceptsUndefined: true }
    ? [...RequiredParameters<Required>, options?: Exclude<ParameterInput<Last>, undefined>]
    : RequiredParameters<Parameters>
  : [];

/** Signatures are derived from the same ordered schema tuples used by the codec. */
type HostMethods<Namespace extends string> = {
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as typeof dshBotRemoteSpec.methods[Endpoint] extends
    { readonly implementation: infer Implementation extends string }
    ? Endpoint extends `${Namespace}/${string}` ? Implementation : never
    : Endpoint extends `${Namespace}/${infer Method}` ? Method : never]:
    (...args: MethodParameters<typeof dshBotRemoteSpec.methods[Endpoint]['parameters']>) =>
      Promise<z.output<ReturnType<typeof dshBotRemoteSpec.methods[Endpoint]['result']['create']>>>;
};
export type DshBotMethods = HostMethods<'dshBot'>;
export type DshBotMemoryMethods = HostMethods<'dshBot.memory'>;

type RemoteMethods<Namespace extends string> = {
  // rc.2's Gateway enforces the descriptor arity even for acceptsUndefined.
  // Call delete(id, undefined) when using the Host's default removal options.
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as Endpoint extends `${Namespace}/${infer Method}` ? Method : never]:
    (...args: RequiredParameters<typeof dshBotRemoteSpec.methods[Endpoint]['parameters']>) =>
      Promise<RemoteResult<z.output<ReturnType<typeof dshBotRemoteSpec.methods[Endpoint]['result']['create']>>>>;
};
export type DshBotMemoryRemoteMethods = RemoteMethods<'dshBot.memory'>;
export type DshBotRemoteMethods = RemoteMethods<'dshBot'> & { memory: DshBotMemoryRemoteMethods };
type DshBotRemoteEndpoints = {
  [Method in keyof RemoteMethods<'dshBot'> as `dshBot/${Method}`]: RemoteMethods<'dshBot'>[Method];
} & {
  [Method in keyof DshBotMemoryRemoteMethods as `dshBot.memory/${Method}`]: DshBotMemoryRemoteMethods[Method];
};

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends DshBotRemoteEndpoints {}
  interface TypertRemoteNamespaceMap {
    dshBot: DshBotRemoteMethods;
    'dshBot.memory': DshBotMemoryRemoteMethods;
  }
  interface RemoteErrorDetailsMap {
    'bot/not-found': Record<string, never>;
    'bot/conflict': Record<string, never>;
    'bot/invalid': Record<string, never>;
    'bot/preset-failed': Record<string, never>;
    'bot/rollback-failed': Record<string, never>;
    'bot/unavailable': Record<string, never>;
    'memory/not-found': Record<string, never>;
    'memory/too-large': Record<string, never>;
    'memory/rejected': Record<string, never>;
    'store/unavailable': Record<string, never>;
  }
}

const codec = <Schema extends z.ZodType>(type: string, schema: Schema) => ({
  mode: 'strict' as const, typeSymbol: `dsh-bot#${type}`, create: () => schema,
});
const parameter = <Schema extends z.ZodType>(name: string, type: string, schema: Schema) => {
  const value = codec(type, schema);
  return { name, source: 'json' as const, codec: value, strictCodec: value };
};
const owner = { service: 'dshBots', invocation: { kind: 'direct' as const } };
const memoryOwner = { service: 'dshBotMemory', invocation: { kind: 'direct' as const } };
const id = parameter('id', 'BotId', botIdSchema);
const botId = parameter('botId', 'BotId', botIdSchema);
const memoryId = parameter('id', 'MemoryId', memoryIdSchema);
const bot = codec('BotRecord', botSchema);
const memories = codec('MemoryRecord[]', z.array(memorySchema));

/** Both Host descriptors and Client codecs are assembled from this single spec. */
export const dshBotRemoteSpec = {
  package: 'dsh-bot',
  methods: {
    'dshBot/list': { ...owner, parameters: [], result: codec('BotRecord[]', z.array(botSchema)) },
    'dshBot/catalogInfo': { ...owner, parameters: [], result: codec('CatalogInfo', catalogInfoSchema) },
    'dshBot/status': { ...owner, parameters: [], result: codec('BotStatus[]', z.array(botStatusSchema)) },
    'dshBot/get': { ...owner, parameters: [id], result: bot },
    'dshBot/create': { ...owner, parameters: [parameter('input', 'BotCreateInput', botCreateSchema)], result: bot },
    'dshBot/update': { ...owner, parameters: [id, parameter('patch', 'BotPatch', botPatchSchema)], result: bot },
    'dshBot/duplicate': { ...owner, parameters: [id, parameter('newId', 'BotId', botIdSchema)], result: bot },
    // "remove" is reserved by rc.2's Client namespace service.
    'dshBot/delete': {
      ...owner,
      implementation: 'remove',
      parameters: [id, {
        ...parameter('options', 'BotRemoveOptions | undefined', botRemoveOptionsSchema.optional()),
        acceptsUndefined: true,
      }],
      result: codec('void', z.void()),
    },
    'dshBot.memory/list': {
      ...memoryOwner, parameters: [botId, parameter('options', 'MemoryRemoteListInput', memoryRemoteListSchema)], result: memories,
    },
    'dshBot.memory/search': {
      ...memoryOwner, parameters: [botId, parameter('input', 'MemoryRemoteSearchInput', memoryRemoteSearchSchema)], result: memories,
    },
    'dshBot.memory/save': {
      ...memoryOwner, parameters: [botId, parameter('input', 'MemoryRemoteSaveInput', memoryRemoteSaveSchema)],
      result: codec('MemorySaveResult', z.strictObject({ id: memoryIdSchema, deduplicated: z.boolean() })),
    },
    'dshBot.memory/update': {
      ...memoryOwner, parameters: [botId, memoryId, parameter('patch', 'MemoryRemotePatch', memoryRemotePatchSchema)],
      result: codec('MemoryRecord', memorySchema),
    },
    'dshBot.memory/delete': {
      ...memoryOwner, implementation: 'remove', parameters: [botId, memoryId], result: codec('void', z.void()),
    },
    'dshBot.memory/count': { ...memoryOwner, parameters: [botId], result: codec('MemoryCount', z.number().int().nonnegative()) },
  },
} as const satisfies TypertRemoteSpec;
