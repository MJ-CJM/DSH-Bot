import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { botKeySchema } from './p34.js';
import { imStatusSchema, teamBoardSchema, teamLinkSchema, teamTaskInputSchema, teamTaskSchema, teamUpdateSchema } from './collaboration.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const, typeSymbol: `dsh-bot/collaboration#${name}`, create: () => schema, encode: (v: unknown) => schema.parse(v), decode: (v: unknown) => schema.parse(v) });
const param = <S extends z.ZodType>(name: string, schema: S) => ({ name, source: 'json' as const, codec: codec(name, schema), strictCodec: codec(name, schema) });
const base = { service: 'dshBotCollaborationRemote', invocation: { kind: 'direct' as const } };
export const collaborationSpec = { package: 'dsh-bot/collaboration', methods: {
  'dshBot.collaboration/board': { ...base, parameters: [param('bot', botKeySchema)], result: codec('Board', teamBoardSchema) },
  'dshBot.collaboration/ensure': { ...base, parameters: [param('bot', botKeySchema), param('expectedRevision', z.number().int().nonnegative())], result: codec('Link', teamLinkSchema) },
  'dshBot.collaboration/createTask': { ...base, parameters: [param('bot', botKeySchema), param('input', teamTaskInputSchema)], result: codec('Task', teamTaskSchema) },
  'dshBot.collaboration/updateTask': { ...base, parameters: [param('bot', botKeySchema), param('input', teamUpdateSchema)], result: codec('Task', teamTaskSchema) },
  'dshBot.im/status': { ...base, service: 'dshBotImRemote', parameters: [], result: codec('ImStatus', imStatusSchema) },
} } as const satisfies TypertRemoteSpec;
type Methods = typeof collaborationSpec.methods;
type Args<P extends readonly unknown[]> = { -readonly [K in keyof P]: P[K] extends { codec: { create: () => infer S extends z.ZodType } } ? z.input<S> : never };
type Result<K extends keyof Methods> = z.output<ReturnType<Methods[K]['result']['create']>>;
export type CollaborationMethods = { [K in keyof Methods as K extends `dshBot.collaboration/${infer M}` ? M : never]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>> };
type Endpoints = { [K in keyof Methods]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends Endpoints {}
  interface TypertRemoteNamespaceMap {
    'dshBot.collaboration': CollaborationMethods;
    'dshBot.im': { status(): Promise<RemoteResult<z.output<typeof imStatusSchema>>> };
  }
}
export const COLLABORATION_REMOTE = createTypertRemoteInfo(collaborationSpec, z);
