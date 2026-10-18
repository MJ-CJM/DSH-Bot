import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from './state.js';

export interface Config { pollIntervalMs: number }
/** Client-local configuration. rc.2 does not forward the Host row's config. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  pollIntervalMs: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < MIN_POLL_INTERVAL_MS || value > MAX_POLL_INTERVAL_MS) {
      throw new TypeError('pollIntervalMs must be an integer from 1000 to 60000');
    }
    return value;
  }).default(DEFAULT_POLL_INTERVAL_MS),
});
