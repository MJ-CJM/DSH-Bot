import { taskSupportSchema, taskSupportInputSchema, taskMaterialInputSchema, taskResumeInputSchema } from './task-materials.js';
import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { supergroupCancelInputSchema, supergroupSessionInputSchema, supergroupViewSchema,
  supergroupCatalogInputSchema, supergroupGroupInputSchema, supergroupSendGroupInputSchema, supergroupSendGroupResultSchema, supergroupSettingsSchema, supergroupConfigureSchema } from './supergroup.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const,
  typeSymbol: `dsh-bot/supergroup#${name}`, create: () => schema,
  encode: (value: unknown) => schema.parse(value), decode: (value: unknown) => schema.parse(value) });
const param = <S extends z.ZodType>(name: string, schema: S) => ({ name, source: 'json' as const,
  codec: codec(name, schema), strictCodec: codec(name, schema) });
const base = { service: 'dshBotSupergroupRemote', invocation: { kind: 'direct' as const } };
export const supergroupSpec = { package: 'dsh-bot/supergroup', methods: {
  'dshBotSupergroup/taskSupport': { ...base, parameters: [param('input', taskSupportInputSchema)], result: codec('TaskSupport', taskSupportSchema) },
  'dshBotSupergroup/addMaterial': { ...base, parameters: [param('input', taskMaterialInputSchema)], result: codec('TaskSupport', taskSupportSchema) },
  'dshBotSupergroup/resumeWork': { ...base, parameters: [param('input', taskResumeInputSchema)], result: codec('TaskSupport', taskSupportSchema) },
  'dshBotSupergroup/pendingTasks': { ...base, parameters: [], result: codec('PendingTasks', z.array(taskSupportSchema)) },
  'dshBotSupergroup/catalog': { ...base, parameters: [param('input', supergroupCatalogInputSchema)], result: codec('Catalog', z.array(supergroupViewSchema)) },
  'dshBotSupergroup/byGroup': { ...base, parameters: [param('input', supergroupGroupInputSchema)], result: codec('GroupView', supergroupViewSchema.nullable()) },
  'dshBotSupergroup/sendGroupInput': { ...base, parameters: [param('input', supergroupSendGroupInputSchema)], result: codec('GroupInputResult', supergroupSendGroupResultSchema) },
  'dshBotSupergroup/forSession': { ...base, parameters: [param('input', supergroupSessionInputSchema)], result: codec('View', supergroupViewSchema.nullable()) },
  'dshBotSupergroup/cancel': { ...base, parameters: [param('input', supergroupCancelInputSchema)], result: codec('Void', z.null()) },
  'dshBotSupergroup/settings': { ...base, parameters: [], result: codec('Settings', supergroupSettingsSchema) },
  'dshBotSupergroup/configure': { ...base, parameters: [param('input', supergroupConfigureSchema)], result: codec('Settings', supergroupSettingsSchema) },
} } as const satisfies TypertRemoteSpec;
type Input = z.input<typeof supergroupSessionInputSchema>;
type Cancel = z.input<typeof supergroupCancelInputSchema>;
type View = z.output<typeof supergroupViewSchema>;
interface SupergroupMethods {
  taskSupport(input: z.input<typeof taskSupportInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
  addMaterial(input: z.input<typeof taskMaterialInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
  resumeWork(input: z.input<typeof taskResumeInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
  pendingTasks(): Promise<RemoteResult<z.output<typeof taskSupportSchema>[]>>;
  catalog(input: z.input<typeof supergroupCatalogInputSchema>): Promise<RemoteResult<View[]>>;
  byGroup(input: z.input<typeof supergroupGroupInputSchema>): Promise<RemoteResult<View | null>>;
  sendGroupInput(input: z.input<typeof supergroupSendGroupInputSchema>): Promise<RemoteResult<z.output<typeof supergroupSendGroupResultSchema>>>;
  forSession(input: Input): Promise<RemoteResult<View | null>>;
  cancel(input: Cancel): Promise<RemoteResult<null>>;
  settings(): Promise<RemoteResult<z.output<typeof supergroupSettingsSchema>>>;
  configure(input: z.input<typeof supergroupConfigureSchema>): Promise<RemoteResult<z.output<typeof supergroupSettingsSchema>>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'dshBotSupergroup/taskSupport'(input: z.input<typeof taskSupportInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
    'dshBotSupergroup/addMaterial'(input: z.input<typeof taskMaterialInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
    'dshBotSupergroup/resumeWork'(input: z.input<typeof taskResumeInputSchema>): Promise<RemoteResult<z.output<typeof taskSupportSchema>>>;
    'dshBotSupergroup/pendingTasks'(): Promise<RemoteResult<z.output<typeof taskSupportSchema>[]>>;
    'dshBotSupergroup/catalog'(input: z.input<typeof supergroupCatalogInputSchema>): Promise<RemoteResult<View[]>>;
    'dshBotSupergroup/byGroup'(input: z.input<typeof supergroupGroupInputSchema>): Promise<RemoteResult<View | null>>;
    'dshBotSupergroup/sendGroupInput'(input: z.input<typeof supergroupSendGroupInputSchema>): Promise<RemoteResult<z.output<typeof supergroupSendGroupResultSchema>>>;
    'dshBotSupergroup/forSession'(input: Input): Promise<RemoteResult<View | null>>;
    'dshBotSupergroup/cancel'(input: Cancel): Promise<RemoteResult<null>>;
    'dshBotSupergroup/settings'(): Promise<RemoteResult<z.output<typeof supergroupSettingsSchema>>>;
    'dshBotSupergroup/configure'(input: z.input<typeof supergroupConfigureSchema>): Promise<RemoteResult<z.output<typeof supergroupSettingsSchema>>>;
  }
  interface TypertRemoteNamespaceMap { dshBotSupergroup: SupergroupMethods }
}
export const SUPERGROUP_REMOTE = createTypertRemoteInfo(supergroupSpec, z);
