import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { timeZoneSchema } from '../../shared/automation.js';

export interface Config {
  maxConcurrentRuns: number; maxRunsPerBotPerDay: number; maxQueuedRuns: number;
  runTimeoutMs: number; catchUpMaxAgeMs: number; sweepIntervalMs: number; delegateMaxDepth: 1; quotaTimeZone: string;
}
const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const Config: Schema<Config> = Schema.object({
  maxConcurrentRuns: Schema.number().min(1).max(64).step(1).default(2),
  maxRunsPerBotPerDay: Schema.number().min(1).max(10000).step(1).default(20),
  maxQueuedRuns: Schema.number().min(1).max(10000).step(1).default(64),
  runTimeoutMs: Schema.number().min(1000).max(86400000).step(1).default(900000),
  catchUpMaxAgeMs: Schema.number().min(0).max(31536000000).step(1).default(86400000),
  sweepIntervalMs: Schema.number().min(1000).max(3600000).step(1).default(60000),
  delegateMaxDepth: Schema.const(1).default(1),
  quotaTimeZone: Schema.string().default(systemTimeZone()),
});
export const configSchema = z.strictObject({
  maxConcurrentRuns: z.number().int().min(1).max(64).default(2),
  maxRunsPerBotPerDay: z.number().int().min(1).max(10000).default(20),
  maxQueuedRuns: z.number().int().min(1).max(10000).default(64),
  runTimeoutMs: z.number().int().min(1000).max(86400000).default(900000),
  catchUpMaxAgeMs: z.number().int().min(0).max(31536000000).default(86400000),
  sweepIntervalMs: z.number().int().min(1000).max(3600000).default(60000),
  delegateMaxDepth: z.literal(1).default(1), quotaTimeZone: timeZoneSchema.default(systemTimeZone),
});
