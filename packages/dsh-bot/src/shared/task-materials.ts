import { z } from 'zod';
import { botKeySchema } from './identity.js';

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const taskMaterialSchema = z.strictObject({
  id, operationId: id, requestDigest: digest, kind: z.enum(['file', 'input-text', 'github-ci']),
  name: z.string().min(1).max(256), sourceId: id, sourceVersion: id, digest,
  text: z.string().min(1).max(16384), question: z.string().trim().min(1).max(1000),
  citation: z.string().min(1).max(1024), readers: z.array(botKeySchema).min(1).max(65),
  createdAt: z.number(),
});
export const taskBlockerSchema = z.strictObject({
  id, assignmentId: id, desiredRevision: z.number().int(), reason: z.string().max(128),
  name: z.string().optional(), observedAt: z.number(), state: z.enum(['waiting', 'ready', 'superseded', 'continued']),
});
export const taskResumeSchema = z.strictObject({
  operationId: id, digest, messageId: id, contentDigest: digest.optional(), originalDigest: digest.optional(), previousMessageId: id.optional(), expectedRevision: z.number().int().positive(),
  state: z.enum(['dispatching', 'queued', 'unknown']), blockerIds: z.array(id), createdAt: z.number(),
});
export const taskSupportSchema = z.strictObject({
  workId: id, revision: z.number().int().positive(), originSessionId: id, inputMessageId: id,
  ownerName: z.string().optional(), originalQuestion: z.string().optional(), readerNames: z.array(z.string()).optional(),
  owner: botKeySchema, readers: z.array(botKeySchema).min(1).max(65), blockers: z.array(taskBlockerSchema), materials: z.array(taskMaterialSchema),
  resumes: z.array(taskResumeSchema),
  inputs: z.array(z.strictObject({ messageId: id, name: z.string(), version: digest })),
  ci: z.array(z.strictObject({ id, name: z.string(), version: id, citation: z.string() })),
});
export const taskSupportInputSchema = z.strictObject({ workId: id });
const binding = { workId: id, expectedRevision: z.number().int().positive(), operationId: id };
export const taskMaterialInputSchema = z.strictObject({ ...binding,
  question: z.string().trim().min(1).max(1000),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('file'), name: z.string().min(1).max(256), text: z.string().min(1).max(16384) }),
    z.strictObject({ kind: z.literal('input-text'), messageId: id, version: digest }),
    z.strictObject({ kind: z.literal('github-ci'), id, version: id }),
  ]),
});
export const taskResumeInputSchema = z.strictObject({ ...binding, text: z.string().trim().min(1).max(2048), blockerIds: z.array(id).max(65) });
export type TaskSupport = z.output<typeof taskSupportSchema>;
export type TaskMaterial = z.output<typeof taskMaterialSchema>;
export type TaskMaterialInput = z.output<typeof taskMaterialInputSchema>;
export type TaskResumeInput = z.output<typeof taskResumeInputSchema>;
