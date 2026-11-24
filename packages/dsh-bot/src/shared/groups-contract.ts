import { relayDetailsRequestSchema, relayDetailsSchema } from './group-relay-details.js';
import { z } from 'zod';
import { teamRecipeSchema, savedTeamRecipeSchema, teamPreviewSchema, teamMappingSchema, teamPreviewMappingSchema } from './team-recipes.js';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { botKeySchema, resourceId } from './identity.js';
import { groupRecallInputSchema, groupRecallPageSchema } from './group-recall.js';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import {
  groupKeySchema,
  groupCreateSchema,
  groupEditSchema,
  groupMemberEditSchema,
  groupMemberEditOptionsSchema,
  groupMemberEditResultSchema,
  groupSendSchema,
  groupSetModelSchema,
  groupExportApprovalSettingsSchema,
  groupPageSchema,
  groupRecordSchema,
  groupSummarySchema,
  groupTurnSchema,
  groupViewSchema,
} from './groups.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({
  mode: 'strict' as const,
  typeSymbol: `dsh-bot/groups#${name}`,
  create: () => schema,
  encode: (v: unknown) => schema.parse(v),
  decode: (v: unknown) => schema.parse(v),
});
const param = <S extends z.ZodType>(name: string, schema: S) => ({
  name,
  source: 'json' as const,
  codec: codec(name, schema),
  strictCodec: codec(name, schema),
});
const base = { service: 'dshBotGroupsRemote', invocation: { kind: 'direct' as const } };
export const groupsSpec = {
  package: 'dsh-bot/groups',
  methods: {
    'dshBot.groups/getRelayDetails': { ...base, parameters: [param('request', relayDetailsRequestSchema)], result: codec('RelayDetails', relayDetailsSchema) },
    'dshBot.groups/getExportApprovalSettings': { ...base, parameters: [param('group', groupKeySchema)],
      result: codec('ExportApprovalSettings', groupExportApprovalSettingsSchema) },
    'dshBot.groups/setExportApproval': { ...base, parameters: [param('group', groupKeySchema), param('bot', botKeySchema),
      param('enabled', z.boolean()), param('expectedRevision', z.number().int().positive()),
      param('expectedMembershipRevision', z.number().int().positive())], result: codec('Group', groupRecordSchema) },
    'dshBot.groups/reviewExport': { ...base, parameters: [param('group', groupKeySchema), param('deliveryId', z.string().min(1))],
      result: codec('ExportReview', z.strictObject({ token: z.string().length(64), deliveryRevision: z.number().int().positive(), flowId: z.uuid(), groupName: z.string(),
        recipients: z.array(z.strictObject({ bot: botKeySchema, name: z.string() })), content: z.string() })) },
    'dshBot.groups/decideExport': { ...base, parameters: [param('group', groupKeySchema), param('deliveryId', z.string().min(1)),
      param('token', z.string().length(64)), param('allow', z.union([z.boolean(), z.literal('always')]))], result: codec('ExportDecision', z.boolean()) },
    'dshBot.groups/discardExport': { ...base, parameters: [param('group', groupKeySchema), param('deliveryId', z.string().min(1)),
      param('expectedRevision', z.number().int().positive())], result: codec('ExportDiscarded', z.boolean()) },
    'dshBot.groups/closeStaleExports': { ...base, parameters: [param('group', groupKeySchema), param('expectedMembershipRevision', z.number().int().positive())],
      result: codec('StaleExportsClosed', z.strictObject({ closed: z.number().int().nonnegative() })) },
    'dshBot.groups/revokeExport': { ...base, parameters: [param('group', groupKeySchema), param('bot', botKeySchema)], result: codec('ExportRevoked', z.boolean()) },
    'dshBot.groups/teamList': { ...base, parameters: [], result: codec('TeamList', z.array(savedTeamRecipeSchema)) },
    'dshBot.groups/teamCapture': { ...base, parameters: [param('group', groupKeySchema), param('name', z.string().trim().min(1).max(64))], result: codec('TeamRecipe', teamRecipeSchema) },
    'dshBot.groups/teamSave': { ...base, parameters: [param('recipe', teamRecipeSchema)], result: codec('SavedTeam', savedTeamRecipeSchema) },
    'dshBot.groups/teamRemove': { ...base, parameters: [param('id', z.string().min(1))], result: codec('TeamRemoved', z.boolean()) },
    'dshBot.groups/teamPreview': { ...base, parameters: [param('recipe', teamRecipeSchema), param('mappings', teamPreviewMappingSchema)], result: codec('TeamPreview', teamPreviewSchema) },
    'dshBot.groups/teamApply': { ...base, parameters: [param('group', groupKeySchema), param('recipe', teamRecipeSchema), param('mappings', teamMappingSchema),
      param('expectedRevision', z.number().int().positive()), param('expectedMembershipRevision', z.number().int().positive())], result: codec('Group', groupRecordSchema) },
    'dshBot.groups/teamApplyMembers': { ...base, parameters: [param('group', groupKeySchema), param('recipe', teamRecipeSchema), param('mappings', teamMappingSchema),
      param('expectedRevision', z.number().int().positive()), param('expectedMembershipRevision', z.number().int().positive()), param('options', groupMemberEditOptionsSchema)], result: codec('MemberEditResult', groupMemberEditResultSchema) },
    'dshBot.groups/editMembers': { ...base, parameters: [param('group', groupKeySchema), param('input', groupMemberEditSchema)], result: codec('MemberEditResult', groupMemberEditResultSchema) },
    'dshBot.groups/getMemberEditResult': { ...base, parameters: [param('group', groupKeySchema), param('operationId', resourceId)], result: codec('MemberEditResult', groupMemberEditResultSchema) },
    'dshBot.groups/recallForBot': {
      ...base, parameters: [param('bot', botKeySchema), param('input', groupRecallInputSchema)],
      result: codec('GroupRecallPage', groupRecallPageSchema),
    },
    'dshBot.groups/open': {
      ...base, parameters: [param('group', groupKeySchema)],
      result: codec('OpenedGroup', z.strictObject({ sessionId: z.string().min(1), workspaceId: z.string().min(1) })),
    },
    'dshBot.groups/openAttachment': {
      ...base,
      parameters: [param('group', groupKeySchema), param('messageId', z.string().min(1)), param('attachmentId', z.string().min(1))],
      result: codec('OpenedAttachment', z.strictObject({ opened: z.literal(true) })),
    },
    'dshBot.groups/markRead': {
      ...base,
      parameters: [
        param('group', groupKeySchema),
        param('throughSeq', z.number().int().nonnegative()),
        param('expectedRevision', z.number().int().nonnegative()),
      ],
      result: codec('Read', z.boolean()),
    },
    'dshBot.groups/list': { ...base, parameters: [], result: codec('List', z.array(groupSummarySchema)) },
    'dshBot.groups/create': {
      ...base,
      parameters: [param('input', groupCreateSchema)],
      result: codec('Group', groupRecordSchema),
    },
    'dshBot.groups/edit': {
      ...base,
      parameters: [param('group', groupKeySchema), param('input', groupEditSchema)],
      result: codec('Group', groupRecordSchema),
    },
    'dshBot.groups/setModel': {
      ...base,
      parameters: [param('group', groupKeySchema), param('input', groupSetModelSchema)],
      result: codec('Group', groupRecordSchema),
    },
    'dshBot.groups/view': {
      ...base,
      parameters: [param('group', groupKeySchema), param('page', groupPageSchema)],
      result: codec('View', groupViewSchema),
    },
    'dshBot.groups/send': {
      ...base,
      parameters: [param('group', groupKeySchema), param('input', groupSendSchema)],
      result: codec('Turn', groupTurnSchema),
    },
    'dshBot.groups/cancel': {
      ...base,
      parameters: [
        param('group', groupKeySchema),
        param('turnId', z.string().min(1)),
        param('expectedRevision', z.number().int().positive()),
      ],
      result: codec('Turn', groupTurnSchema),
    },
    'dshBot.groups/continueTurn': {
      ...base, parameters: [param('group', groupKeySchema), param('turnId', z.string().min(1)), param('expectedRevision', z.number().int().positive())],
      result: codec('Turn', groupTurnSchema),
    },
    'dshBot.groups/stopMember': {
      ...base, parameters: [param('group', groupKeySchema), param('turnId', z.string().min(1)), param('memberId', z.string().min(1)), param('expectedRevision', z.number().int().positive())],
      result: codec('Turn', groupTurnSchema),
    },
    'dshBot.groups/archive': {
      ...base,
      parameters: [param('group', groupKeySchema), param('expectedRevision', z.number().int().positive())],
      result: codec('Group', groupRecordSchema),
    },
    'dshBot.groups/deleteGroup': {
      ...base,
      parameters: [param('group', groupKeySchema), param('expectedRevision', z.number().int().positive())],
      result: codec('GroupDeleted', z.boolean()),
    },
  },
} as const satisfies TypertRemoteSpec;
type Methods = typeof groupsSpec.methods;
type Args<P extends readonly unknown[]> = {
  -readonly [K in keyof P]: P[K] extends { codec: { create: () => infer S extends z.ZodType } } ? z.input<S> : never;
};
type Result<K extends keyof Methods> = z.output<ReturnType<Methods[K]['result']['create']>>;
export type GroupMethods = {
  [K in keyof Methods as K extends `dshBot.groups/${infer M}` ? M : never]: (
    ...args: Args<Methods[K]['parameters']>
  ) => Promise<RemoteResult<Result<K>>>;
};
type Endpoints = {
  [K in keyof Methods]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>>;
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends Endpoints {}
  interface TypertRemoteNamespaceMap {
    'dshBot.groups': GroupMethods;
  }
}
export const GROUPS_REMOTE = createTypertRemoteInfo(groupsSpec, z);
