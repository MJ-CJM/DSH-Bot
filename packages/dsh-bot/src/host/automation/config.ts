import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';

export interface Config {
  runTimeoutMs: number;
  executorPollMs: number; stopGraceMs: number;
}
export const Config: Schema<Config> = Schema.object({
  runTimeoutMs: Schema.number().min(1000).max(86400000).step(1).default(900000),
  executorPollMs: Schema.number().min(10).max(60000).step(1).default(250),
  stopGraceMs: Schema.number().min(100).max(60000).step(1).default(5000),
});
// Retired 0.2.0 scheduling options are ignored when loading an existing Host row.
export const configSchema = z.object({
  runTimeoutMs: z.number().int().min(1000).max(86400000).default(900000),
  executorPollMs: z.number().int().min(10).max(60000).default(250),
  stopGraceMs: z.number().int().min(100).max(60000).default(5000),
});
