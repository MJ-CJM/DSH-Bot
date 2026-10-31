import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { RemoteResult, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol';
import { botKeySchema } from './identity.js';
export const skillName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const capabilityRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('models') }),
  z.strictObject({ action: z.literal('modelInfo'), provider: z.string().min(1), model: z.string().min(1) }),
  z.strictObject({ action: z.literal('inspect'), bot: botKeySchema }),
  z.strictObject({ action: z.literal('freshConversation'), bot: botKeySchema, expectedSessionId: z.string().min(1).nullable() }),
  z.strictObject({ action: z.literal('skillRead'), bot: botKeySchema, name: skillName }),
  z.strictObject({ action: z.literal('skillWrite'), bot: botKeySchema, name: skillName, content: z.string().min(1).max(65536), expectedHash: z.string().nullable() }),
  z.strictObject({ action: z.literal('skillRemove'), bot: botKeySchema, name: skillName, expectedHash: z.string() }),
]);
export const platformSchema = z.object({
  browser: z.object({ provider: z.string().optional(), toolBridge: z.literal(false).default(false) }).default({ toolBridge: false }),
  voice: z.object({ available: z.boolean(), selectedProvider: z.string().optional(), providers: z.array(z.object({ id: z.string(), name: z.string(), phase: z.string() })) }).default({ available: false, providers: [] }),
}).default({ browser: { toolBridge: false }, voice: { available: false, providers: [] } });
const model = z.object({ provider: z.string(), id: z.string(), name: z.string(), inputModalities: z.array(z.string()).optional() });
export const dataFlowDiagnosticSchema = z.strictObject({ state: z.enum(['clear', 'restricted', 'unknown']),
  reasons: z.array(z.enum(['unknown-lineage', 'no-egress', 'secret', 'pending-cleanup', 'revoked', 'reader-mismatch', 'unavailable'])) });
export const capabilityResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('models'), providers: z.array(z.object({ id: z.string(), name: z.string(), available: z.boolean(), models: z.array(model) })) }),
  z.object({ kind: z.literal('modelInfo'), model: model.extend({ reasoning: z.object({ efforts: z.array(z.object({ id: z.string(), name: z.string() })) }).optional() }) }),
  z.object({ kind: z.literal('conversation'), sessionId: z.string().min(1) }),
  z.object({ kind: z.literal('inspect'), mainSessionId: z.string().optional(), dataFlow: dataFlowDiagnosticSchema.default({ state: 'unknown', reasons: ['unavailable'] }), platform: platformSchema, online: z.boolean(), skillsAvailable: z.boolean(), skills: z.array(z.object({ name: z.string(), description: z.string(), provider: z.string() })),
    ownSkills: z.array(skillName), tools: z.array(z.string()), extraDirs: z.array(z.string()) }),
  z.object({ kind: z.literal('skill'), name: skillName, content: z.string().optional(), hash: z.string().nullable() }),
  z.object({ kind: z.literal('removed') }),
]);
const codec = <S extends z.ZodType>(schema: S) => ({ mode: 'strict' as const, typeSymbol: 'dsh-bot/capabilities#Value', create: () => schema,
  encode: (v: unknown) => schema.parse(v), decode: (v: unknown) => schema.parse(v) });
export const capabilitiesSpec = { package: 'dsh-bot/capabilities', methods: {
  'dshBot.capabilities/request': { service: 'dshBotCapabilitiesRemote', invocation: { kind: 'direct' },
    parameters: [{ name: 'input', source: 'json', codec: codec(capabilityRequest), strictCodec: codec(capabilityRequest) }], result: codec(capabilityResult) },
} } as const satisfies TypertRemoteSpec;
export interface CapabilitiesMethods { request(input: z.input<typeof capabilityRequest>): Promise<RemoteResult<z.output<typeof capabilityResult>>> }
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteNamespaceMap { 'dshBot.capabilities': CapabilitiesMethods } interface TypertRemoteMap { 'dshBot.capabilities/request': CapabilitiesMethods['request'] } }
export const CAPABILITIES_REMOTE = createTypertRemoteInfo(capabilitiesSpec, z);
