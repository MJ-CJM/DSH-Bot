import Schema from '@deepseek-ai/schemastery';
export interface MessagingConfig {
  messagingEnabled: boolean;
  messageRetryAttempts: number;
  messageRetryDelaysMs: number[];
  messageMaxDepth: number;
  messageMaxHop: number;
  messageThreadLimit: number;
  messageOpenAskLimit: number;
  messagePairRequests: number;
  messagePairTotal: number;
  messagePairWindowMs: number;
  messageInterruptPairLimit: number;
  messageInterruptPairWindowMs: number;
  messageInterruptTargetLimit: number;
  messageInterruptTargetWindowMs: number;
  messagePendingLimit: number;
  messageTargetPendingLimit: number;
  messageMaxBytes: number;
  messageTtlMs: number;
  messageAskTimeoutMs: number;
  messageInterruptTtlMs: number;
  messageInterruptWaitMs: number;
  messageRetentionMs: number;
  messageDedupeMs: number;
  messageDirectoryBytes: number;
}
const integer = (min: number, max: number, fallback: number) =>
  Schema.number().min(min).max(max).step(1).default(fallback);
export const messagingConfigFields = {
  messagingEnabled: Schema.boolean().default(true),
  messageRetryAttempts: integer(1, 10, 5),
  messageRetryDelaysMs: Schema.array(integer(100, 3600000, 1000))
    .min(1)
    .max(10)
    .default([1000, 5000, 30000, 300000]),
  messageMaxDepth: integer(1, 4, 3),
  messageMaxHop: integer(2, 16, 8),
  messageThreadLimit: integer(2, 256, 16),
  messageOpenAskLimit: integer(1, 16, 4),
  messagePairRequests: integer(1, 1000, 6),
  messagePairTotal: integer(2, 2000, 12),
  messagePairWindowMs: integer(1000, 3600000, 60000),
  messageInterruptPairLimit: integer(1, 10, 1),
  messageInterruptPairWindowMs: integer(1000, 3600000, 60000),
  messageInterruptTargetLimit: integer(1, 100, 3),
  messageInterruptTargetWindowMs: integer(1000, 86400000, 600000),
  messagePendingLimit: integer(2, 10000, 200),
  messageTargetPendingLimit: integer(1, 1000, 50),
  messageMaxBytes: integer(1024, 32768, 8192),
  messageTtlMs: integer(1000, 604800000, 86400000),
  messageAskTimeoutMs: integer(1000, 604800000, 86400000),
  messageInterruptTtlMs: integer(1000, 60000, 60000),
  messageInterruptWaitMs: integer(1000, 120000, 30000),
  messageRetentionMs: integer(1000, 31536000000, 604800000),
  messageDedupeMs: integer(1000, 31536000000, 2592000000),
  messageDirectoryBytes: integer(1024, 262144, 32768),
};
export function validateMessagingConfig<T extends MessagingConfig>(c: T): T {
  if (
    c.messageMaxHop < 2 * c.messageMaxDepth ||
    c.messageThreadLimit < 2 * c.messageMaxDepth ||
    c.messagePairTotal < c.messagePairRequests ||
    c.messageTargetPendingLimit > c.messagePendingLimit ||
    c.messageDedupeMs < c.messageRetentionMs
  )
    throw new TypeError('Inconsistent messaging limits');
  return c;
}
const baseConfig = Schema.object(messagingConfigFields);
export const MessagingConfig: Schema<Partial<MessagingConfig>, MessagingConfig> = Schema.transform(
  baseConfig,
  (value) => validateMessagingConfig(value as unknown as MessagingConfig),
).default(baseConfig({}) as MessagingConfig);
