import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ProactiveWork } from "../../shared/proactive/work.js";

export function GroupRepairEvidencePanel({
	row,
	onOpen,
	t,
}: PropsLocale<"dsh-bot"> & {
	row: ProactiveWork;
	onOpen(id: string): Promise<void>;
}) {
	const grant = row.groupRepair;
	if (!grant) return null;
	const evidence = row.groupRepairEvidence;
	return (
		<section data-group-repair-evidence="">
			<h4>{t("proactive.groupRepairEvidence")}</h4>
			<p>
				{t("proactive.groupRepairRoles", {
					supervisor: grant.supervisor.bot.botId,
					implementer: grant.implementer.bot.botId,
				})}
			</p>
			<Button
				variant="ghost"
				onClick={() => {
					void onOpen(grant.rootSessionId).catch(() => {});
				}}
			>
				{t("proactive.groupRepairOpen")}
			</Button>
			{evidence?.plan && (
				<details>
					<summary>{t("proactive.groupRepairPlan")}</summary>
					<p>{evidence.plan.goal}</p>
					<p>{evidence.plan.collaborationReason}</p>
					<p>{evidence.plan.implementation}</p>
					<ul>
						{evidence.plan.files.map((path) => (
							<li key={path}>{path}</li>
						))}
					</ul>
				</details>
			)}
			{evidence?.stages.map((stage) => (
				<p key={stage.phase}>
					{t(
						stage.phase === "plan"
							? "proactive.groupRepairPlan"
							: stage.phase === "implement"
								? "proactive.groupRepairImplement"
								: "proactive.groupRepairReview",
					)}{" "}
					· {t(`proactive.groupRepairState.${stage.state}`)} · {stage.turnId}
				</p>
			))}
			{evidence?.review && (
				<details open>
					<summary>{t("proactive.groupRepairReview")}</summary>
					<p>{evidence.review.summary}</p>
					<ul>
						{evidence.review.checks.map((check) => (
							<li key={JSON.stringify(check)}>
								{check.status} · {check.criterion}
								<p>{check.evidence}</p>
							</li>
						))}
					</ul>
				</details>
			)}
		</section>
	);
}
