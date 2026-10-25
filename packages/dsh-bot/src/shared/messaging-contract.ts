import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { botIdSchema } from './ids.js';
import { envelopeSchema, messageRecordSchema } from './messaging.js';
export const messageRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), botId: botIdSchema }),
  z.strictObject({ action: z.enum(['cancel', 'retry']), id: z.string().min(1), revision: z.number().int().positive() }),
]);
const summarySchema = z.strictObject({ envelope: envelopeSchema, revision: z.number().int().positive(),
  delivery: messageRecordSchema.shape.delivery, processing: messageRecordSchema.shape.processing,
  response: messageRecordSchema.shape.response, lastErrorCode: z.string().optional() });
export const messageOverviewSchema = z.strictObject({ enabled: z.boolean(), pending: z.number().int().nonnegative(),
  nestedMessaging: z.literal(false), items: z.array(summarySchema).max(20) });
export type MessageOverview = z.output<typeof messageOverviewSchema>;
export type MessageRequest = z.output<typeof messageRequestSchema>;
const codec = <S extends z.ZodType>(name: string, schema: S) => ({ mode: 'strict' as const,
  typeSymbol: `dsh-bot/messaging#${name}`, create: () => schema,
  encode: (value: unknown) => schema.parse(value), decode: (value: unknown) => schema.parse(value) });
const input = codec('Request', messageRequestSchema);
export const MESSAGING_REMOTE = createTypertRemoteInfo({ package: 'dsh-bot/messaging', methods: {
  'dshBot.messaging/request': { service: 'dshBotMessagingRemote', invocation: { kind: 'direct' },
    parameters: [{ name: 'input', source: 'json', codec: input, strictCodec: input }],
    result: codec('Overview', messageOverviewSchema) },
} }, z);
export interface MessageMethods { request(input: MessageRequest): Promise<RemoteResult<MessageOverview>> }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap { 'dshBot.messaging/request': MessageMethods['request'] }
  interface TypertRemoteNamespaceMap { 'dshBot.messaging': MessageMethods }
}
