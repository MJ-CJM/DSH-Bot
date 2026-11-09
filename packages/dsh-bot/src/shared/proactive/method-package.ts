import { z } from 'zod';
import { botKeySchema } from '../identity.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const methodManifest = z.strictObject({
  format: z.literal('dsh-bot-method/v1'),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  content: z.string().min(1).max(16384), parentHash: hash.nullable(),
  contract: z.strictObject({ input: z.string().min(1).max(1000), output: z.string().min(1).max(1000), scope: z.string().min(1).max(1000), forbidden: z.string().min(1).max(1000) }),
  dependencies: z.tuple([z.strictObject({ name: z.literal('dsh'), version: z.literal('0.2.1-rc.2') })]),
  examples: z.array(z.strictObject({ input: z.string().max(1000), expected: z.string().max(1000) })).max(3),
  evaluation: z.literal('unverified'),
  reportedEvidence: z.strictObject({
    judge: z.literal('exact-json-v1'), planDigest: hash,
    outcome: z.enum(['improved', 'no-benefit', 'inconclusive']),
    model: z.string().min(1).max(200),
    runDigests: z.array(hash).max(36),
  }).optional(),
  publicContentConfirmed: z.literal(true),
});
export const methodPackage = z.strictObject({ manifest: methodManifest, digest: hash });
export const exportMethodRequest = z.strictObject({
  candidateId: z.uuid(), expectedRevision: z.number().int().nonnegative(),
  contract: methodManifest.shape.contract, examples: methodManifest.shape.examples,
  publicContentConfirmed: z.literal(true),
});
export const importMethodRequest = z.strictObject({ commandId: z.uuid(), owner: botKeySchema, package: methodPackage });
export type ExportMethodRequest = z.output<typeof exportMethodRequest>;
export type ImportMethodRequest = z.output<typeof importMethodRequest>;
export type MethodPackage = z.output<typeof methodPackage>;
