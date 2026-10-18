/** Hand-authored, browser-safe contract for the locked DSH release's public Typert API. */
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { botIdSchema } from './ids.js';
import {
  botCreateSchema, botPatchSchema, botRemoveOptionsSchema, botSchema,
} from './schema.js';

export const botStatusSchema = z.strictObject({
  id: botIdSchema,
  presetId: z.string().min(1),
  preset: z.strictObject({ state: z.enum(['ok', 'broken', 'missing']), reason: z.string().optional() }),
});
export type BotStatus = z.output<typeof botStatusSchema>;

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
export type DshBotMethods = {
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as typeof dshBotRemoteSpec.methods[Endpoint] extends
    { readonly implementation: infer Implementation extends string } ? Implementation
    : Endpoint extends `dshBot/${infer Method}` ? Method : never]:
    (...args: MethodParameters<typeof dshBotRemoteSpec.methods[Endpoint]['parameters']>) =>
      Promise<z.output<ReturnType<typeof dshBotRemoteSpec.methods[Endpoint]['result']['create']>>>;
};

export type DshBotRemoteMethods = {
  // rc.2's Gateway enforces the descriptor arity even for acceptsUndefined.
  // Call delete(id, undefined) when using the Host's default removal options.
  [Endpoint in keyof typeof dshBotRemoteSpec.methods as Endpoint extends `dshBot/${infer Method}` ? Method : never]:
    (...args: RequiredParameters<typeof dshBotRemoteSpec.methods[Endpoint]['parameters']>) =>
      Promise<RemoteResult<z.output<ReturnType<typeof dshBotRemoteSpec.methods[Endpoint]['result']['create']>>>>;
};
type DshBotRemoteEndpoints = {
  [Method in keyof DshBotRemoteMethods as `dshBot/${Method}`]: DshBotRemoteMethods[Method];
};

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends DshBotRemoteEndpoints {}
  interface TypertRemoteNamespaceMap {
    dshBot: DshBotRemoteMethods;
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
const id = parameter('id', 'BotId', botIdSchema);
const bot = codec('BotRecord', botSchema);

/** Both Host descriptors and Client codecs are assembled from this single spec. */
export const dshBotRemoteSpec = {
  package: 'dsh-bot',
  methods: {
    'dshBot/list': { ...owner, parameters: [], result: codec('BotRecord[]', z.array(botSchema)) },
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
  },
} as const satisfies TypertRemoteSpec;
