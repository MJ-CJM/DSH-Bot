import {
	governanceConfigSchema,
	type GovernanceConfig,
} from "../../shared/proactive/governance.js";
import {
	noticeConfigSchema,
	type NoticeConfig,
} from "../../shared/proactive/notices.js";
import {
	workspaceRepairConfig,
	commandExecutorConfig,
	type WorkspaceRepairConfig,
	type CommandExecutorConfig,
} from "../../shared/proactive/workspace-repair.js";
import {
	fixtureConfig,
	type FixtureConfig,
} from "../../shared/proactive/repair.js";
import { loopbackUrl } from "./executors/loopback.js";
import { ciFeedSchema, type CiFeed } from "./sources/ci-feed.js";
import Schema from "@deepseek-ai/schemastery";
import {
	autoCiRuleSchema,
	type AutoCiRule,
} from "../../shared/proactive/protocol.js";

export interface ProactiveConfig {
	proactiveGroupRepairEnabled?: boolean;
	proactiveModelOutputTokens?: number;
	proactiveGovernance?: GovernanceConfig;
	proactiveGovernanceIntervalMs?: number;
	proactiveNoticeConfig?: NoticeConfig;
	proactiveWorkspaceRepair?: WorkspaceRepairConfig | null;
	proactiveCommandExecutor?: CommandExecutorConfig | null;
	proactiveRecoveryAttempts?: number;
	proactiveRecoveryIntervalMs?: number;
	proactiveMaintenanceIntervalMs?: number;
	proactiveEnabled: boolean;
	proactiveGroupReviewEnabled: boolean;
	proactiveGroupFollowUpEnabled: boolean;
	proactiveCiFeed?: CiFeed | null;
	proactiveRepairFixture?: FixtureConfig | null;
	proactiveExternalExecutor?: string | null;
	proactiveNodeExecutable: string;
	proactiveTimeoutMs: number;
	proactiveExecutionEnabled: boolean;
	proactiveModelDailyBudget: number;
	proactiveExternalDailyBudget: number;
	proactiveNotificationPolicy?: string;
	proactiveExternalNotificationPolicy?: string;
	proactiveAutoCiRule?: AutoCiRule | null;
	proactiveProvider?: string;
	proactiveModel?: string;
	proactiveExecutionTimeoutMs: number;
}
export const proactiveConfigFields = {
	proactiveGroupRepairEnabled: Schema.boolean().default(false),
	proactiveModelOutputTokens: Schema.number()
		.min(1)
		.max(32768)
		.step(1)
		.default(1024),
	proactiveGovernance: Schema.transform(Schema.any(), (value) =>
		governanceConfigSchema.parse(value ?? {}),
	).default(governanceConfigSchema.parse({})),
	proactiveGovernanceIntervalMs: Schema.number()
		.min(60000)
		.max(86400000)
		.step(1)
		.default(3600000),
	proactiveNoticeConfig: Schema.transform(Schema.any(), (value) =>
		noticeConfigSchema.parse(value ?? {}),
	).default({ mergeWindowMs: 60000, maxBatchItems: 8, maxPending: 1000 }),
	proactiveWorkspaceRepair: Schema.transform(
		Schema.any(),
		(value) => workspaceRepairConfig.nullish().parse(value) ?? null,
	).default(null),
	proactiveCommandExecutor: Schema.transform(
		Schema.any(),
		(value) => commandExecutorConfig.nullish().parse(value) ?? null,
	).default(null),
	proactiveRecoveryAttempts: Schema.number().min(0).max(20).step(1).default(5),
	proactiveRecoveryIntervalMs: Schema.number()
		.min(100)
		.max(30000)
		.step(1)
		.default(1000),
	proactiveMaintenanceIntervalMs: Schema.number()
		.min(250)
		.max(60000)
		.step(1)
		.default(1000),
	proactiveEnabled: Schema.boolean().default(false),
	proactiveGroupReviewEnabled: Schema.boolean().default(false),
	proactiveGroupFollowUpEnabled: Schema.boolean().default(false),
	proactiveCiFeed: Schema.transform(
		Schema.any(),
		(value) => ciFeedSchema.nullish().parse(value) ?? null,
	).default(null),
	proactiveRepairFixture: Schema.transform(
		Schema.any(),
		(value) => fixtureConfig.nullish().parse(value) ?? null,
	).default(null),
	proactiveExternalExecutor: Schema.transform(
		Schema.any(),
		(value) => loopbackUrl.nullish().parse(value) ?? null,
	).default(null),
	proactiveExecutionEnabled: Schema.boolean().default(false),
	proactiveExternalNotificationPolicy: Schema.string().pattern(
		/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/,
	),
	proactiveNotificationPolicy: Schema.string().pattern(
		/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/,
	),
	proactiveModelDailyBudget: Schema.number().min(1).max(100).step(1).default(8),
	proactiveExternalDailyBudget: Schema.number()
		.min(0)
		.max(100)
		.step(1)
		.default(8),
	proactiveAutoCiRule: Schema.transform(
		Schema.any(),
		(value) => autoCiRuleSchema.nullish().parse(value) ?? null,
	).default(null),

	proactiveProvider: Schema.string().pattern(
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/,
	),
	proactiveModel: Schema.string().min(1).max(128),
	proactiveExecutionTimeoutMs: Schema.number()
		.min(1000)
		.max(300000)
		.step(1)
		.default(30000),
	proactiveNodeExecutable: Schema.string().pattern(/\S/).default("node"),
	proactiveTimeoutMs: Schema.number()
		.min(1000)
		.max(30000)
		.step(1)
		.default(5000),
};
