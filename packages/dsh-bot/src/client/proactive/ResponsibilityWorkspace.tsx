import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { BotRecord } from "../../shared/schema.js";
import type { ProactiveStatus } from "../../shared/proactive/protocol.js";
import {
	responsibilitySourceSchema,
} from "../../shared/proactive/responsibility.js";
import {
	ResponsibilityPanel,
	type ResponsibilityActions,
} from "./ResponsibilityPanel.js";

/** The workspace selection supplies the Bot. The Host supplies source and
 * executable scopes; this wrapper never guesses model or repair permissions. */
export function ResponsibilityWorkspace({
	bot,
	actions,
	status,
	refresh,
	loading,
	failed,
	t,
}: PropsLocale<"dsh-bot"> & {
	bot: BotRecord;
	actions: ResponsibilityActions;
	status?: ProactiveStatus;
	refresh?: () => Promise<void>;
	loading: boolean;
	failed: boolean;
}) {
	const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
	const source = responsibilitySourceSchema.safeParse(
		status?.localFeed !== "revoked" ? status?.localFeedScope : undefined,
	);
	const route = status?.capabilities.directExecution ? status.directRoute : undefined;
	const target = { bot: owner, botUpdatedAt: bot.updatedAt, ...route };
	const ready = !failed && status?.state === "ready" && source.success;
	const scopes = ready ? (status.actionScopes ?? []) : [];
	const availableActions = ready
		? [
				...new Set([
					"inspect-ci-result" as const,
					...scopes.map((scope) => scope.action),
				]),
			]
		: [];
	return (
		<div>
			<Button
				variant="ghost"
				disabled={loading || !refresh}
				onClick={() => {
					void refresh?.();
				}}
			>
				{t("responsibility.refreshContext")}
			</Button>
			{loading && <p role="status">{t("responsibility.loading")}</p>}
			{(failed || (!loading && !ready)) && (
				<p role="status">{t("responsibility.contextUnavailable")}</p>
			)}
			<ResponsibilityPanel
				key={`${bot.id}:${bot.createdAt}`}
				owner={owner}
				actions={actions}
				t={t}
				source={ready && source.success ? source.data : undefined}
				target={ready ? target : undefined}
				canAuto={!!route && ready}
				availableActions={availableActions}
				availableActionScopes={scopes}
			/>
		</div>
	);
}
