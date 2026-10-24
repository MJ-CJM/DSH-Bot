import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import {
  assignmentInputSchema,
  assignmentSchema,
  botKeySchema,
  connectorInputSchema,
  connectorSchema,
  connectorRuntimeSchema,
  legacyImportSchema,
  notificationSchema,
  notifyInputSchema,
  integrationCatalogSchema,
  resourceId,
  policyInputSchema,
  policySchema,
} from './integrations.js';
const codec = <S extends z.ZodType>(name: string, schema: S) => ({
  mode: 'strict' as const,
  typeSymbol: `dsh-bot/integrations#${name}`,
  create: () => schema,
  encode: (v: unknown) => schema.parse(v),
  decode: (v: unknown) => schema.parse(v),
});
const param = <S extends z.ZodType>(name: string, s: S) => ({
  name,
  source: 'json' as const,
  codec: codec(name, s),
  strictCodec: codec(name, s),
});
const base = { service: 'dshBotP34', invocation: { kind: 'direct' as const } };
const expected = param('expectedRevision', z.number().int().nonnegative());
export const integrationsSpec = {
  package: 'dsh-bot/integrations',
  methods: {
    'dshBot.connectors/catalog': { ...base, parameters: [], result: codec('Catalog', integrationCatalogSchema) },
    'dshBot.connectors/saveDefinition': {
      ...base,
      parameters: [param('input', connectorInputSchema), expected],
      result: codec('Connector', connectorSchema),
    },
    'dshBot.connectors/saveAssignment': {
      ...base,
      parameters: [param('input', assignmentInputSchema), expected],
      result: codec('Assignment', assignmentSchema),
    },
    'dshBot.connectors/applyIdle': {
      ...base,
      parameters: [param('bot', botKeySchema)],
      result: codec('Runtime', z.array(connectorRuntimeSchema)),
    },
    'dshBot.connectors/importLegacy': {
      ...base,
      parameters: [param('bot', botKeySchema)],
      result: codec('Import', legacyImportSchema),
    },
    'dshBot.notifications/savePolicy': {
      ...base,
      service: 'dshBotNotificationRemote',
      parameters: [param('input', policyInputSchema), expected, param('confirmed', z.boolean())],
      result: codec('Policy', policySchema),
    },
    'dshBot.notifications/markRead': {
      ...base,
      service: 'dshBotNotificationRemote',
      parameters: [param('id', resourceId), expected],
      result: codec('Notification', notificationSchema),
    },
    'dshBot.notifications/test': {
      ...base,
      service: 'dshBotNotificationRemote',
      implementation: 'testNotification',
      parameters: [
        param('owner', botKeySchema),
        param('input', notifyInputSchema),
        param('expectedScope', z.string()),
        param('confirmed', z.literal(true)),
      ],
      result: codec('Notification', notificationSchema),
    },
  },
} as const satisfies TypertRemoteSpec;
type Methods = typeof integrationsSpec.methods;
type Args<P extends readonly unknown[]> = {
  -readonly [K in keyof P]: P[K] extends { codec: { create: () => infer S extends z.ZodType } } ? z.input<S> : never;
};
type Result<K extends keyof Methods> = z.output<ReturnType<Methods[K]['result']['create']>>;
export type IntegrationMethods<N extends string> = {
  [K in keyof Methods as K extends `${N}/${infer M}` ? M : never]: (
    ...args: Args<Methods[K]['parameters']>
  ) => Promise<RemoteResult<Result<K>>>;
};
type Endpoints = {
  [K in keyof Methods]: (...args: Args<Methods[K]['parameters']>) => Promise<RemoteResult<Result<K>>>;
};
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap extends Endpoints {}
  interface TypertRemoteNamespaceMap {
    'dshBot.connectors': IntegrationMethods<'dshBot.connectors'>;
    'dshBot.notifications': IntegrationMethods<'dshBot.notifications'>;
  }
}
export const INTEGRATIONS_REMOTE = createTypertRemoteInfo(integrationsSpec, z);
