import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotRecord } from "../../shared/schema.js";
import type { ProactiveStatus } from "../../shared/proactive/protocol.js";
import {
	responsibilitySourceSchema,
	responsibilityTargetSchema,
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
	proactive,
	t,
}: PropsLocale<"dsh-bot"> & {
	bot: BotRecord;
	actions: ResponsibilityActions;
	proactive: { status(): Promise<ProactiveStatus> };
}) {
	const [snapshot, setSnapshot] = useState<{
		key: string;
		value: ProactiveStatus;
	}>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const sequence = useRef(0);
	const key = `${bot.id}:${bot.createdAt}:${bot.updatedAt}`;
	const status = snapshot?.key === key ? snapshot.value : undefined;
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setBusy(true);
		setError(false);
		try {
			const value = await proactive.status();
			if (request === sequence.current) setSnapshot({ key, value });
		} catch {
			if (request === sequence.current) {
				setError(true);
				setSnapshot(undefined);
			}
		} finally {
			if (request === sequence.current) setBusy(false);
		}
	}, [proactive, key]);
	useEffect(() => {
		setSnapshot(undefined);
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
	const source = responsibilitySourceSchema.safeParse(
		status?.localFeed !== "revoked" ? status?.localFeedScope : undefined,
	);
	const route = status?.directRoute;
	const target = responsibilityTargetSchema.safeParse(
		route ? { bot: owner, botUpdatedAt: bot.updatedAt, ...route } : undefined,
	);
	const ready =
		status?.state === "ready" &&
		status.capabilities.directExecution &&
		target.success &&
		source.success;
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
				disabled={busy}
				onClick={() => {
					void refresh();
				}}
			>
				{t("responsibility.refreshContext")}
			</Button>
			{busy && <p role="status">{t("responsibility.loading")}</p>}
			{(error || (!busy && !ready)) && (
				<p role="status">{t("responsibility.contextUnavailable")}</p>
			)}
			<ResponsibilityPanel
				key={`${bot.id}:${bot.createdAt}`}
				owner={owner}
				actions={actions}
				t={t}
				source={ready && source.success ? source.data : undefined}
				target={ready && target.success ? target.data : undefined}
				availableActions={availableActions}
				availableActionScopes={scopes}
			/>
		</div>
	);
}
