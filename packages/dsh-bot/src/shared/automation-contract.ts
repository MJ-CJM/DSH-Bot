/** Browser-safe, independent contribution; mounting P1 does not enable automation. */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import {
  automationIdSchema, revisionSchema, routineCreateSchema, routinePatchSchema, routineListSchema,
  routineRecordSchema, runListSchema, runRecordSchema,
} from './automation.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const,
  typeSymbol: `dsh-bot/automation#${name}`, create: () => schema,
  encode: (value: unknown) => schema.parse(value), decode: (value: unknown) => schema.parse(value),
});
const param = <S extends z.ZodType>(name: string, schema: S) => {
  const value = codec(name, schema);
  return { name, source: 'json' as const, codec: value, strictCodec: value };
};
const routineOwner = { service: 'dshBotRoutines', invocation: { kind: 'direct' as const } };
const runOwner = { service: 'dshBotRuns', invocation: { kind: 'direct' as const } };
export const automationStatusSchema = z.strictObject({
  state: z.enum(['starting', 'ready', 'read_only', 'failed', 'stopping']),
  reason: z.string().optional(),
  owner: z.strictObject({ pid: z.number().int().positive(), startedAt: z.string(), hostname: z.string() }).optional(),
});
export type AutomationStatus = z.output<typeof automationStatusSchema>;
export const automationRemoteSpec = { package: 'dsh-bot/automation', methods: {
  'dshBot.automation/status': { service: 'dshBotAutomation', invocation: { kind: 'direct' as const },
    parameters: [], result: codec('AutomationStatus', automationStatusSchema) },
  'dshBot.routine/list': { ...routineOwner, parameters: [param('options', routineListSchema)], result: codec('Routine[]', z.array(routineRecordSchema)) },
  'dshBot.routine/get': { ...routineOwner, parameters: [param('id', automationIdSchema)], result: codec('Routine', routineRecordSchema) },
  'dshBot.routine/create': { ...routineOwner, parameters: [param('input', routineCreateSchema)], result: codec('Routine', routineRecordSchema) },
  'dshBot.routine/update': { ...routineOwner, parameters: [param('id', automationIdSchema), param('patch', routinePatchSchema), param('expectedRevision', revisionSchema)], result: codec('Routine', routineRecordSchema) },
  'dshBot.routine/delete': { ...routineOwner, implementation: 'remove', parameters: [param('id', automationIdSchema), param('expectedRevision', revisionSchema)], result: codec('Routine', routineRecordSchema) },
  'dshBot.routine/runNow': { ...routineOwner, parameters: [param('id', automationIdSchema), param('operationId', automationIdSchema)], result: codec('Run', runRecordSchema) },
  'dshBot.run/list': { ...runOwner, parameters: [param('options', runListSchema)], result: codec('Run[]', z.array(runRecordSchema)) },
  'dshBot.run/get': { ...runOwner, parameters: [param('id', automationIdSchema)], result: codec('Run', runRecordSchema) },
} } as const satisfies TypertRemoteSpec;
type Methods = typeof automationRemoteSpec.methods;
type Args<P extends readonly unknown[]> = { -readonly [K in keyof P]: P[K] extends { codec: { create: () => infer S extends z.ZodType } } ? z.input<S> : never };
type Result<K extends keyof Methods> = z.output<ReturnType<Methods[K]['result']['create']>>;
export type AutomationHostMethods<N extends string> = {
  [K in keyof Methods as K extends `${N}/${infer M}` ? Methods[K] extends { implementation: infer I extends string } ? I : M : never]:
    (...args: Args<Methods[K]['parameters']>) => Promise<Result<K>>;
};
export type AutomationRemoteMethods<N extends string> = {
  [K in keyof Methods as K extends `${N}/${infer M}` ? M : never]:
    (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>>;
};
type Endpoints = { [K in keyof Methods]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends Endpoints {}
  interface TypertRemoteNamespaceMap {
    'dshBot.routine': AutomationRemoteMethods<'dshBot.routine'>;
    'dshBot.run': AutomationRemoteMethods<'dshBot.run'>;
    'dshBot.automation': AutomationRemoteMethods<'dshBot.automation'>;
  }
}
export const AUTOMATION_REMOTE = createTypertRemoteInfo(automationRemoteSpec, z);
export default AUTOMATION_REMOTE;
