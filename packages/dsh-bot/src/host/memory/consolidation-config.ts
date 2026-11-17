import Schema from '@deepseek-ai/schemastery';
export interface Config { enabled: boolean; timeoutMs: number; candidateTtlMs: number; maxInputChars: number;
  maxOutputChars: number; maxOutputTokens: number; botDaily: number; hostDaily: number }
const integer = (min: number, max: number, fallback: number) => Schema.transform(Schema.number().min(min).max(max), value => {
  if (!Number.isSafeInteger(value)) throw new Error('Expected integer'); return value;
}).default(fallback);
const schema = Schema.object({ enabled: Schema.boolean().default(false),
  timeoutMs: integer(1000, 120000, 60000), candidateTtlMs: integer(3600000, 604800000, 604800000),
  maxInputChars: integer(256, 24000, 24000), maxOutputChars: integer(128, 4000, 4000),
  maxOutputTokens: integer(32, 2048, 2048), botDaily: integer(1, 20, 3), hostDaily: integer(1, 100, 10) });

export const Config: Schema<Partial<Config>, Config> = schema.default(schema({}) as Config);
