import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useEffect, useRef, useState } from "react";
import styles from "./workspace.module.css";
import type { ProactiveWork } from "../../shared/proactive/work.js";
import {
	workspaceReviewSchema,
	type WorkspaceReview,
	type WorkspaceReviewRequest,
} from "../../shared/proactive/workspace-repair.js";

export function WorkspaceEvidence({
	row,
	request,
	t,
}: PropsLocale<"dsh-bot"> & {
	row: ProactiveWork;
	request?(input: WorkspaceReviewRequest): Promise<WorkspaceReview>;
}) {
	const [review, setReview] = useState<WorkspaceReview>();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const sequence = useRef(0);
	useEffect(
		() => () => {
			++sequence.current;
		},
		[],
	);
	const evidence = row.workspaceEvidence;
	if (!evidence) return null;
	async function load() {
		if (!request || !row.evidenceDigest || !evidence) return;
		const current = ++sequence.current;
		setPending(true);
		setFailed(false);
		setReview(undefined);
		try {
			const result = workspaceReviewSchema.parse(
				await request({
					ticketId: row.ticketId,
					assignmentId: row.assignmentId,
					evidenceDigest: row.evidenceDigest,
				}),
			);
			if (
				result.assignmentId !== row.assignmentId ||
				result.evidenceDigest !== evidence.artifactDigest
			)
				throw new Error("Workspace evidence version mismatch");
			if (current === sequence.current) setReview(result);
		} catch {
			if (current === sequence.current) setFailed(true);
		} finally {
			if (current === sequence.current) setPending(false);
		}
	}
	return (
		<section
			className={styles.content}
			data-workspace-evidence=""
			aria-label={t("proactive.workspaceEvidence")}
		>
			<p>
				{t("proactive.workspaceChecks", {
					before: String(evidence.baseline.exitCode),
					after: String(evidence.verification.exitCode),
				})}
			</p>
			<p>
				{t("proactive.artifactDigest")} <code>{evidence.artifactDigest}</code>
			</p>
			<p>{evidence.changedPaths.join(", ")}</p>
			{row.commandEvidence && (
				<p>
					{t("proactive.commandRun", {
						id: row.commandEvidence.runId,
						adapter: row.commandEvidence.adapterVersion,
					})}{" "}
					{row.commandEvidence.cost.kind === "unknown"
						? t("proactive.commandCostUnknown")
						: t("proactive.commandCost", {
								units: row.commandEvidence.cost.units,
								unit: row.commandEvidence.cost.unit,
							})}
				</p>
			)}
			{request && (
				<Button variant="ghost" disabled={pending} onClick={() => void load()}>
					{t("proactive.workspaceLoadEvidence")}
				</Button>
			)}
			{failed && <p role="alert">{t("proactive.workspaceEvidenceFailed")}</p>}
			{review && (
				<div data-workspace-content="">
					<p>{t("proactive.workspacePreserved")}</p>
					<details>
						<summary>{t("proactive.workspaceManifest")}</summary>
						<pre>{JSON.stringify(review.manifests, null, 2)}</pre>
					</details>
					<details>
						<summary>{t("proactive.workspaceDiff")}</summary>
						{review.diff.map((file) => (
							<div key={file.path}>
								<h4>{file.path}</h4>
								<p>{t("proactive.workspaceBefore")}</p>
								<pre>{file.before}</pre>
								<p>{t("proactive.workspaceAfter")}</p>
								<pre>{file.after}</pre>
							</div>
						))}
					</details>
					<details>
						<summary>{t("proactive.workspaceFiles")}</summary>
						{review.files.map((file) => (
							<details key={file.path}>
								<summary>
									{file.path} ·{" "}
									{t(
										file.editable
											? "proactive.workspaceEditable"
											: "proactive.workspaceReadonly",
									)}
								</summary>
								<p>{t("proactive.workspaceBefore")}</p>
								<pre>{file.before}</pre>
								<p>{t("proactive.workspaceAfter")}</p>
								<pre>{file.after}</pre>
							</details>
						))}
					</details>
					{(["baseline", "verification"] as const).map((phase) => (
						<details key={phase}>
							<summary>
								{t(
									phase === "baseline"
										? "proactive.workspaceBaseline"
										: "proactive.workspaceVerification",
								)}
							</summary>
							<pre>{JSON.stringify(review.checks[phase], null, 2)}</pre>
							<p>{t("proactive.workspaceStdout")}</p>
							<pre>{review.logs[phase].stdout}</pre>
							<p>{t("proactive.workspaceStderr")}</p>
							<pre>{review.logs[phase].stderr}</pre>
						</details>
					))}
				</div>
			)}
		</section>
	);
}
