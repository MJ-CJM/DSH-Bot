/** Browser-safe, independent contribution; mounting P1 does not enable automation. */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { z } from 'zod';
import { automationIdSchema, runListSchema, runRecordSchema } from './automation.js';
import { aggregateSchema } from './native-schedule.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const,
  typeSymbol: `dsh-bot/automation#${name}`, create: () => schema,
  encode: (value: unknown) => schema.parse(value), decode: (value: unknown) => schema.parse(value),
});
const param = <S extends z.ZodType>(name: string, schema: S) => {
  const value = codec(name, schema);
  return { name, source: 'json' as const, codec: value, strictCodec: value };
};
const nativeOwner = { service: 'dshBotNativeSchedules', invocation: { kind: 'direct' as const } };
const runOwner = { service: 'dshBotRuns', invocation: { kind: 'direct' as const } };
export const automationStatusSchema = z.strictObject({
  state: z.enum(['starting', 'ready', 'failed', 'stopping']),
  reason: z.string().optional(),
});
export type AutomationStatus = z.output<typeof automationStatusSchema>;
export const automationRemoteSpec = { package: 'dsh-bot/automation', methods: {
  'dshBot.automation/status': { service: 'dshBotAutomation', invocation: { kind: 'direct' as const },
    parameters: [], result: codec('AutomationStatus', automationStatusSchema) },
  'dshBot.nativeSchedule/aggregate': { ...nativeOwner, parameters: [], result: codec('Aggregate', aggregateSchema) },
  'dshBot.nativeSchedule/deleteLegacy': { ...nativeOwner, parameters: [param('id', automationIdSchema)], result: codec('Deleted', z.boolean()) },
  'dshBot.nativeSchedule/runNow': { ...nativeOwner, parameters: [param('id', z.string().min(1)), param('operationId', automationIdSchema),
    param('expected', z.strictObject({ title: z.string(), prompt: z.string(), botCreatedAt: z.number() })), param('approved', z.literal(true))], result: codec('Run', runRecordSchema) },
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
    'dshBot.nativeSchedule': AutomationRemoteMethods<'dshBot.nativeSchedule'>;
    'dshBot.run': AutomationRemoteMethods<'dshBot.run'>;
    'dshBot.automation': AutomationRemoteMethods<'dshBot.automation'>;
  }
}
export const AUTOMATION_REMOTE = createTypertRemoteInfo(automationRemoteSpec, z);
export default AUTOMATION_REMOTE;
