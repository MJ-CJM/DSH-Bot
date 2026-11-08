import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useState } from "react";
import {
	feedbackDataset, feedbackProposal,
	type FeedbackCandidate, type FeedbackProposal, type FeedbackWorkflowAction, type FeedbackWorkflowView, type FeedbackContext,
} from "../../shared/proactive/feedback.js";

export type { FeedbackContext } from "../../shared/proactive/feedback.js";
type OwnerAction = Exclude<FeedbackWorkflowAction, { action: "settle-candidate" }>;
interface Props extends PropsLocale<"dsh-bot"> {
	view: FeedbackWorkflowView;
	contexts: FeedbackContext[];
	pending: boolean;
	onAction(input: OwnerAction): Promise<void>;
	onMore?(after: string): Promise<void>;
	onHistory?(id: string): Promise<FeedbackCandidate[]>;
	onReadSkill?(bot: FeedbackProposal["origin"]["bot"], name: string): Promise<{ content?: string; hash: string | null }>;
	onSettings?(setting: "tools" | "workspace" | "model" | "notifications" | "proactive"): void;
}
const kinds = ["rework", "false-positive", "false-negative", "attention", "preference", "skill", "permission"] as const;

/** Feedback stays a candidate until the owner reviews its exact change. */
export function FeedbackPanel({ view, contexts, pending, onAction, onMore, onHistory, onReadSkill, onSettings, t }: Props) {
	const [selected, setSelected] = useState("");
	const [kind, setKind] = useState<(typeof kinds)[number]>("false-positive");
	const [reason, setReason] = useState("");
	const [content, setContent] = useState("");
	const [skill, setSkill] = useState("");
	const [setting, setSetting] = useState<"tools" | "workspace" | "model" | "notifications" | "proactive">("workspace");
	const [datasetText, setDatasetText] = useState("");
	const [datasetId, setDatasetId] = useState("");
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [histories, setHistories] = useState<Record<string, FeedbackCandidate[]>>({});
	const context = contexts.find(row => row.origin.taskId === selected) ?? contexts[0];
	const locked = pending || busy;
	async function run(action: () => Promise<void>) {
		if (locked) return;
		setError(false); setBusy(true);
		try { await action(); } catch { setError(true); } finally { setBusy(false); }
	}
	async function propose() {
		if (!context) throw new Error("Select feedback context");
		const common = { origin: context.origin, reason };
		let proposal: FeedbackProposal;
		if (kind === "preference") proposal = { ...common, kind, content };
		else if (kind === "permission") proposal = { ...common, kind, setting };
		else if (kind === "rework") {
			if (!context.ticket) throw new Error("Select delivered work");
			proposal = { ...common, kind, ticketId: context.ticket.id, expectedWorkRevision: context.ticket.revision };
		} else if (kind === "skill") {
			if (!onReadSkill) throw new Error("Skill editor unavailable");
			const before = await onReadSkill(context.origin.bot, skill);
			proposal = { ...common, kind, name: skill, before: before.content ?? null, beforeHash: before.hash, content };
		} else {
			if (!context.change) throw new Error("Select CI evidence");
			proposal = kind === "false-positive" ? { ...common, kind, change: { ...context.change, mode: "suppress" } }
				: kind === "false-negative" ? { ...common, kind, change: { ...context.change, mode: "include" } }
					: { ...common, kind, change: { ...context.change, mode: "mute" } };
		}
		await onAction({ action: "propose-candidate", proposal: feedbackProposal.parse(proposal) });
		setReason(""); setContent("");
	}
	const dataset = view.datasets.find(row => `${row.id}:${row.version}` === datasetId) ?? view.datasets[0];
	return <section aria-label={t("proactive.feedbackWorkflow")} data-feedback-workflow>
		<h2>{t("proactive.feedbackWorkflow")}</h2>
		<p>{t("proactive.feedbackWorkflowHint")}</p>
		{error && <p role="alert">{t("proactive.feedbackFailed")}</p>}
		<fieldset disabled={locked || !context}>
			<legend>{t("proactive.feedbackCreate")}</legend>
			<label>{t("proactive.feedbackContext")}<select value={context?.origin.taskId ?? ""} onChange={event => setSelected(event.target.value)}>
				{contexts.map(row => <option key={row.origin.taskId} value={row.origin.taskId}>{row.label}</option>)}
			</select></label>
			<label>{t("proactive.feedbackKindLabel")}<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
				{kinds.map(value => <option key={value} value={value}>{t(`proactive.feedbackKind.${value}`)}</option>)}
			</select></label>
			<label>{t("proactive.feedbackReason")}<textarea value={reason} maxLength={kind === "rework" ? 512 : 2048} onChange={event => setReason(event.target.value)} /></label>
			{kind === "skill" && <label>{t("proactive.feedbackSkillName")}<input value={skill} maxLength={64} onChange={event => setSkill(event.target.value)} /></label>}
			{(kind === "preference" || kind === "skill") && <label>{t("proactive.feedbackContent")}<textarea value={content} maxLength={kind === "skill" ? 16384 : 2048} onChange={event => setContent(event.target.value)} /></label>}
			{kind === "permission" && <label>{t("proactive.feedbackSettingLabel")}<select value={setting} onChange={event => setSetting(event.target.value as typeof setting)}>
				{(["tools", "workspace", "model", "notifications", "proactive"] as const).map(value => <option key={value} value={value}>{t(`proactive.feedbackSetting.${value}`)}</option>)}
			</select></label>}
			<Button variant="ghost" disabled={locked || !reason.trim() || !context} onClick={() => { void run(propose); }}>{t("proactive.feedbackCreate")}</Button>
		</fieldset>
		<details>
			<summary>{t("proactive.feedbackDatasetImport")}</summary>
			<p>{t("proactive.feedbackDatasetHint")}</p>
			<label>{t("proactive.feedbackDatasetFile")}<textarea value={datasetText} maxLength={98304} disabled={locked} onChange={event => setDatasetText(event.target.value)} /></label>
			<Button variant="ghost" disabled={locked || !datasetText.trim()} onClick={() => { void run(async () => {
				await onAction({ action: "import-dataset", dataset: feedbackDataset.parse(JSON.parse(datasetText)) }); setDatasetText("");
			}); }}>{t("proactive.feedbackDatasetImport")}</Button>
		</details>
		{view.datasets.length > 0 && <label>{t("proactive.feedbackDatasetSelect")}<select disabled={locked} value={dataset ? `${dataset.id}:${dataset.version}` : ""} onChange={event => setDatasetId(event.target.value)}>
			{view.datasets.map(row => <option key={`${row.id}:${row.version}`} value={`${row.id}:${row.version}`}>{row.id} v{row.version} · {row.samples}</option>)}
		</select></label>}
		{view.candidates.map(row => {
			const rule = "change" in row.proposal;
			const canAdopt = rule ? (row.state === "eligible" || row.state === "revoked") && row.evaluation?.passed : row.state === "candidate" && row.proposal.kind !== "permission";
			return <article key={row.id} data-feedback-candidate={row.id}>
				<h3>{t(`proactive.feedbackKind.${row.proposal.kind}`)}</h3>
				<p>{row.bodyPurgedAt !== undefined ? t("proactive.feedbackBodyPurged") : row.proposal.reason}</p>
				<p role="status">{t(`proactive.feedbackState.${row.state}`)}</p>
				{row.bodyPurgedAt === undefined && row.proposal.kind === "preference" && <blockquote>{row.proposal.content}</blockquote>}
				{row.bodyPurgedAt === undefined && row.proposal.kind === "skill" && <details><summary>{t("proactive.feedbackSkillDiff")}</summary>
					<h4>{t("proactive.feedbackBefore")}</h4><pre>{row.proposal.before ?? t("proactive.feedbackNewSkill")}</pre>
					<h4>{t("proactive.feedbackAfter")}</h4><pre>{row.proposal.content}</pre>
				</details>}
				{"change" in row.proposal && <p>{row.proposal.change.sourceId} · {row.proposal.change.job} · {row.proposal.change.attempt}</p>}
				{row.evaluation && <details><summary>{t("proactive.feedbackResult")}</summary>
					<p>{row.evaluation.datasetId} v{row.evaluation.datasetVersion} · {row.evaluation.passed ? "PASS" : "FAIL"}</p>
					<code>{row.evaluation.digest}</code>
					{row.evaluation.batches.map(batch => <p key={batch.id}>{t("proactive.feedbackComparison", batch)}</p>)}
				</details>}
				{rule && row.state === "candidate" && <Button variant="ghost" disabled={locked || !dataset || !row.datasetDigests.includes(dataset.digest)} onClick={() => { void run(async () => {
					if (dataset) await onAction({ action: "evaluate-candidate", candidateId: row.id, expectedRevision: row.revision, datasetId: dataset.id, datasetVersion: dataset.version });
				}); }}>{t("proactive.feedback.evaluate")}</Button>}
				{canAdopt && <Button variant="ghost" disabled={locked} onClick={() => { void run(() => onAction({ action: "adopt-candidate", candidateId: row.id, expectedRevision: row.revision, reviewedDigest: row.proposalDigest })); }}>{t("proactive.feedbackAdoptExact")}</Button>}
				{row.state === "adopted" && row.proposal.kind !== "rework" && <Button variant="ghost" disabled={locked} onClick={() => { void run(() => onAction({ action: "revoke-candidate", candidateId: row.id, expectedRevision: row.revision, reviewedDigest: row.proposalDigest })); }}>{t("proactive.feedback.revoke")}</Button>}
				{row.bodyPurgedAt === undefined && row.proposal.kind === "permission" && onSettings && <Button variant="ghost" disabled={locked} onClick={() => { if (row.proposal.kind === "permission") onSettings(row.proposal.setting); }}>{t("proactive.feedbackOpenSettings")}</Button>}
				{onHistory && <Button variant="ghost" disabled={locked} onClick={() => { void run(async () => {
					const history = await onHistory(row.id); setHistories(current => ({ ...current, [row.id]: history }));
				}); }}>{t("proactive.feedbackHistory")}</Button>}
				{histories[row.id]?.map(version => <p key={version.revision}>{t("proactive.feedbackHistoryRow", { revision: version.revision, state: t(`proactive.feedbackState.${version.state}`) })}</p>)}
			</article>;
		})}
		{view.nextCursor && onMore && <Button variant="ghost" disabled={locked} onClick={() => { void run(async () => { if (view.nextCursor) await onMore(view.nextCursor); }); }}>{t("proactive.feedbackMore")}</Button>}
	</section>;
}
