import { messagingConfigFields, validateMessagingConfig, type MessagingConfig } from './messaging/config.js';
import Schema from '@deepseek-ai/schemastery';
import { MEMORY_LIST_MAX_LIMIT } from '../shared/schema.js';

export interface Config extends MessagingConfig {
  referenceMemoryTimeoutMs: number;
  referenceMemoryMaxFileBytes: number;
  groupMaxMembers: number;
  groupMaxTurns: number;
  groupMaxDepth: number;
  groupContextMaxBytes: number;
  groupRoundTimeoutMs: number;
  connectorApplyTimeoutMs: number;
  notificationDailyLimit: number;
  notificationCooldownSec: number;
  notificationRetentionDays: number;
  notificationMaxRecords: number;
  notificationSendTimeoutMs: number;
  seedExamples: boolean;
  presetIdPrefix: string;
  presetOrder: number;
  /** Files such as skills; storageDomain retains its separately configured backend root. */
  dataDir: string;
  maxInjectChars: number;
  privateShare: number;
  sharedShare: number;
  journalShare: number;
  journalDays: number;
  quotaTimeZone: string;
  memorySectionOrder: number;
  memoryListLimit: number;
  enableBotManageInStandard: boolean;
  botManagePersonaPreviewChars: number;
  activityMaxSessionsPerBot: number;
  activityMaxSessionsTotal: number;
}
const activityLimit = (name: string, fallback: number) =>
  Schema.transform(Schema.number(), (value) => {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
    return value;
  }).default(fallback);
const baseConfig = Schema.object({
  ...messagingConfigFields,
  referenceMemoryTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  referenceMemoryMaxFileBytes: Schema.number().min(1024).max(67108864).step(1).default(8388608),
  groupMaxMembers: Schema.number().min(2).max(16).step(1).default(8),
  groupMaxTurns: Schema.number().min(1).max(32).step(1).default(8),
  groupMaxDepth: Schema.number().min(1).max(8).step(1).default(1),
  groupContextMaxBytes: Schema.number().min(1024).max(262144).step(1).default(32768),
  groupRoundTimeoutMs: Schema.number().min(1000).max(3600000).step(1).default(300000),
  connectorApplyTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  notificationDailyLimit: Schema.number().min(0).max(1000).step(1).default(20),
  notificationCooldownSec: Schema.number().min(0).max(86400).step(1).default(60),
  notificationRetentionDays: Schema.number().min(1).max(365).step(1).default(30),
  notificationSendTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000),
  notificationMaxRecords: Schema.number().min(1).max(10000).step(1).default(1000),
  activityMaxSessionsPerBot: activityLimit('activityMaxSessionsPerBot', 50),
  activityMaxSessionsTotal: activityLimit('activityMaxSessionsTotal', 1000),
  seedExamples: Schema.boolean().default(true),
  enableBotManageInStandard: Schema.boolean().default(false),
  botManagePersonaPreviewChars: Schema.transform(Schema.number(), (value) => {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError('botManagePersonaPreviewChars must be a positive safe integer');
    return value;
  }).default(200),
  presetIdPrefix: Schema.string()
    .pattern(/^[a-z][a-z0-9-]*$/)
    .default('bot-'),
  presetOrder: Schema.transform(Schema.number(), (value) => {
    if (!Number.isFinite(value)) throw new TypeError('presetOrder must be finite');
    return value;
  }).default(50),
  dataDir: Schema.string().pattern(/\S/).default('$DSH_HOME/dsh-bot'),
  maxInjectChars: Schema.transform(Schema.number(), (value) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('maxInjectChars must be a nonnegative safe integer');
    return value;
  }).default(4000),
  privateShare: Schema.number().min(0).max(1).default(0.6),
  sharedShare: Schema.number().min(0).max(1).default(0.4),
  journalShare: Schema.number().min(0).max(1).default(0.25),
  journalDays: Schema.number().min(1).max(3650).step(1).default(30),
  quotaTimeZone: Schema.transform(Schema.string(), (value) => {
    new Intl.DateTimeFormat('en', { timeZone: value }); return value;
  }).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  memorySectionOrder: Schema.transform(Schema.number(), (value) => {
    // rc.2: persona prefix = 0, the first tool policy (PTC_ONLY) = 800.
    if (!Number.isFinite(value) || value <= 0 || value >= 800)
      throw new TypeError('memorySectionOrder must be between 0 and 800');
    return value;
  }).default(100),
  memoryListLimit: Schema.transform(Schema.number(), (value) => {
    if (!Number.isInteger(value) || value < 1 || value > MEMORY_LIST_MAX_LIMIT) {
      throw new TypeError(`memoryListLimit must be an integer from 1 to ${MEMORY_LIST_MAX_LIMIT}`);
    }
    return value;
  }).default(20),
});
export const Config: Schema<Partial<Config>, Config> = Schema.transform(baseConfig, (value) => {
  const config = value as unknown as Config;
  if (Math.abs(config.privateShare + config.sharedShare - 1) > 1e-9) throw new TypeError('Memory shares must sum to one');
  return validateMessagingConfig(config);
}).default(baseConfig({}) as Config);
