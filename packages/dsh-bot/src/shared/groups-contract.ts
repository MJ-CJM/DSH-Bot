import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { groupKeySchema, groupCreateSchema, groupEditSchema, groupSendSchema, groupPageSchema, groupRecordSchema, groupSummarySchema, groupTurnSchema, groupViewSchema } from './groups.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const, typeSymbol: `dsh-bot/groups#${name}`, create: () => schema, encode: (v: unknown) => schema.parse(v), decode: (v: unknown) => schema.parse(v) });
const param = <S extends z.ZodType>(name: string, schema: S) => ({ name, source: 'json' as const, codec: codec(name, schema), strictCodec: codec(name, schema) });
const base = { service: 'dshBotGroupsRemote', invocation: { kind: 'direct' as const } };
export const groupsSpec = { package: 'dsh-bot/groups', methods: {
  'dshBot.groups/markRead': { ...base, parameters: [param('group', groupKeySchema), param('throughSeq', z.number().int().nonnegative()), param('expectedRevision', z.number().int().nonnegative())], result: codec('Read', z.boolean()) },
  'dshBot.groups/list': { ...base, parameters: [], result: codec('List', z.array(groupSummarySchema)) },
  'dshBot.groups/create': { ...base, parameters: [param('input', groupCreateSchema)], result: codec('Group', groupRecordSchema) },
  'dshBot.groups/edit': { ...base, parameters: [param('group', groupKeySchema), param('input', groupEditSchema)], result: codec('Group', groupRecordSchema) },
  'dshBot.groups/view': { ...base, parameters: [param('group', groupKeySchema), param('page', groupPageSchema)], result: codec('View', groupViewSchema) },
  'dshBot.groups/send': { ...base, parameters: [param('group', groupKeySchema), param('input', groupSendSchema)], result: codec('Turn', groupTurnSchema) },
  'dshBot.groups/cancel': { ...base, parameters: [param('group', groupKeySchema), param('turnId', z.string().min(1)), param('expectedRevision', z.number().int().positive())], result: codec('Turn', groupTurnSchema) },
  'dshBot.groups/archive': { ...base, parameters: [param('group', groupKeySchema), param('expectedRevision', z.number().int().positive())], result: codec('Group', groupRecordSchema) },
} } as const satisfies TypertRemoteSpec;
type Methods = typeof groupsSpec.methods;
type Args<P extends readonly unknown[]> = { -readonly [K in keyof P]: P[K] extends { codec: { create: () => infer S extends z.ZodType } } ? z.input<S> : never };
type Result<K extends keyof Methods> = z.output<ReturnType<Methods[K]['result']['create']>>;
export type GroupMethods = { [K in keyof Methods as K extends `dshBot.groups/${infer M}` ? M : never]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>> };
type Endpoints = { [K in keyof Methods]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends Endpoints {}
  interface TypertRemoteNamespaceMap { 'dshBot.groups': GroupMethods }
}
export const GROUPS_REMOTE = createTypertRemoteInfo(groupsSpec, z);
