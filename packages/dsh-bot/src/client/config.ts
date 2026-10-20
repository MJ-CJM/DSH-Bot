import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from './state.js';

export interface Config { pollIntervalMs: number; maxPollIntervalMs: number; memoryPageSize: number; sidebarSessionLimit: number }
/** Client-local configuration. rc.2 does not forward the Host row's config. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  maxPollIntervalMs: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
      throw new TypeError('maxPollIntervalMs must be an integer from 1000 to 60000');
    }
    return value;
  }).default(DEFAULT_MAX_POLL_INTERVAL_MS),
  sidebarSessionLimit: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 50) throw new TypeError('sidebarSessionLimit must be an integer from 1 to 50');
    return value;
  }).default(5),
  memoryPageSize: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 199) throw new TypeError('memoryPageSize must be an integer from 1 to 199');
    return value;
  }).default(50),
  pollIntervalMs: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
      throw new TypeError('pollIntervalMs must be an integer from 1000 to 60000');
    }
    return value;
  }).default(DEFAULT_POLL_INTERVAL_MS),
});
