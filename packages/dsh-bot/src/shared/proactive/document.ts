import { z } from 'zod';
import { botKeySchema } from '../identity.js';

/** Frozen owner-provided data, never a tool/permission grant. */
export const documentSnapshotSchema = z.strictObject({
  kind: z.literal('document-analysis'), version: z.literal(1),
  name: z.string().trim().min(1).max(160),
  sourceVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  content: z.string().trim().min(1).max(8192),
  question: z.string().trim().min(1).max(1000),
  acceptance: z.string().trim().min(1).max(500),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 24 * 1024, 'Document snapshot exceeds budget');
export const documentRequestSchema = z.strictObject({
  commandId: z.uuid(), requestedAt: z.iso.datetime(), owner: botKeySchema, document: documentSnapshotSchema,
  approved: z.literal(true),
});
export type DocumentSnapshot = z.output<typeof documentSnapshotSchema>;
export type DocumentRequest = z.output<typeof documentRequestSchema>;
