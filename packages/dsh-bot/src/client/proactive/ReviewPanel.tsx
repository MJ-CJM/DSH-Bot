import { GroupRepairEvidencePanel } from "./GroupRepairEvidencePanel.js";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { useEffect, useRef, useState } from "react";
import type {
	WorkspaceReview,
	WorkspaceReviewRequest,
} from "../../shared/proactive/workspace-repair.js";
import { WorkspaceEvidence } from "./WorkspaceEvidence.js";
import workspaceStyles from "./workspace.module.css";
import {
	reworkFeedbackSchema,
	type ProactiveWork,
	type ReworkFeedback,
	type WorkHistory,
	type WorkHistoryRequest,
} from "../../shared/proactive/work.js";
import type {
	CancelRequest,
	ExternalNoticeRequest,
	ExternalNoticeResult,
	GroupReviewRequest,
	GroupReviewResult,
	ReviewRequest,
} from "../../shared/proactive/remote-contract.js";

interface Props extends PropsLocale<"dsh-bot"> {
	row: ProactiveWork;
	pending: boolean;
	canRework: boolean;
	onGroupReview?(input: GroupReviewRequest): Promise<GroupReviewResult>;
	onExternalNotice?(
		input: ExternalNoticeRequest,
	): Promise<ExternalNoticeResult>;
	onOpen(id: string): Promise<void>;
	onCancel(input: CancelRequest): void;
	onReview(input: ReviewRequest): void;
	onHistory?(input: WorkHistoryRequest): Promise<WorkHistory>;
	onWorkspaceReview?(input: WorkspaceReviewRequest): Promise<WorkspaceReview>;
}
export function ReviewPanel({
	row,
	pending,
	canRework,
	onExternalNotice,
	onGroupReview,
	onOpen,
	onCancel,
	onReview,
	onHistory,
	onWorkspaceReview,
	t,
}: Props) {
	const fence = { ticketId: row.ticketId, expectedRevision: row.revision };
	const evidence = row.evidenceDigest;
	return (
		<article
			className={workspaceStyles.content}
			data-proactive-ticket={row.ticketId}
		>
			<h3>{row.title}</h3>
			<p role="status">{t(`proactive.state.${row.state}`)}</p>
			{row.groupRepair && (
				<GroupRepairEvidencePanel row={row} onOpen={onOpen} t={t} />
			)}
			{row.usage && (
				<p>
					{t("proactive.actualTokens", {
						input: row.usage.inputTokens,
						output: row.usage.outputTokens,
					})}
				</p>
			)}
			{row.sessionId &&
				["delivered", "accepted", "failed", "unknown"].includes(row.state) && (
					<Button
						variant="ghost"
						onClick={() => {
							if (row.sessionId) void onOpen(row.sessionId).catch(() => {});
						}}
					>
						{t("proactive.transcript")}
					</Button>
				)}
			{evidence && (
				<details>
					<summary>{t("proactive.evidence")}</summary>
					<code>{evidence}</code>
					{row.repairEvidence && (
						<>
							<p>
								{t("proactive.testEvidence", {
									tool: row.repairEvidence.verification.tool,
									before: row.repairEvidence.baseline.exitCode,
									after: row.repairEvidence.verification.exitCode,
								})}
							</p>
							<p>
								{t("proactive.proposedEdit", {
									field: row.repairEvidence.edit.field,
									value: JSON.stringify(row.repairEvidence.edit.value),
								})}
							</p>
							<p>
								{t("proactive.artifactDigest")}{" "}
								<code>{row.repairEvidence.artifactDigest}</code>
							</p>
						</>
					)}
					{row.externalEvidence && (
						<p>
							{t("proactive.externalRun", {
								id: row.externalEvidence.runId,
								units: row.externalEvidence.units,
							})}
						</p>
					)}
				</details>
			)}
			{onGroupReview &&
				(row.state === "accepted" ||
					(row.state === "delivered" &&
						(row.repairEvidence?.verification.exitCode === 0 ||
							row.workspaceEvidence?.verification.exitCode === 0))) && (
					<GroupReviewPanel
						key={row.revision}
						fence={fence}
						request={onGroupReview}
						savedFollowUp={row.groupReview?.followUp}
						onOpen={onOpen}
						t={t}
					/>
				)}
			{onExternalNotice &&
				row.state === "accepted" &&
				(row.sessionId ?? row.groupRepair?.rootSessionId) && (
					<ExternalNoticePanel
						key={row.revision}
						fence={fence}
						request={onExternalNotice}
						t={t}
					/>
				)}
			{evidence && row.state === "delivered" && (
				<>
					<Button
						variant="ghost"
						disabled={
							pending ||
							(!!row.repair &&
								row.repairEvidence?.verification.exitCode !== 0) ||
							(!!row.workspaceRepair &&
								((!!row.groupRepair &&
									row.groupRepairEvidence?.review?.verdict !== "pass") ||
									row.workspaceEvidence?.verification.exitCode !== 0 ||
									row.workspaceEvidence?.verification.timedOut ||
									row.workspaceEvidence?.verification.outputTruncated))
						}
						onClick={() =>
							onReview({
								...fence,
								commandId: crypto.randomUUID(),
								evidenceDigest: evidence,
								approved: true,
								review: "accept",
							})
						}
					>
						{t("proactive.approve")}
					</Button>
					{row.generation < (row.taskLimits?.maxAttempts ?? 3) && (
						<ReworkForm
							key={row.assignmentId}
							row={row}
							disabled={pending || !canRework}
							onSubmit={(feedback) =>
								onReview({
									...fence,
									commandId: crypto.randomUUID(),
									evidenceDigest: evidence,
									approved: true,
									review: "rework",
									feedback,
								})
							}
							t={t}
						/>
					)}
				</>
			)}
			{["pending", "claimed", "sent"].includes(row.state) && (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() => onCancel({ ...fence, commandId: crypto.randomUUID() })}
				>
					{t("proactive.cancel")}
				</Button>
			)}
			{row.rework && <FeedbackDetails feedback={row.rework.feedback} t={t} />}
			{row.workspaceEvidence && (
				<WorkspaceEvidence
					key={`${row.assignmentId}:${row.evidenceDigest}`}
					row={row}
					request={onWorkspaceReview}
					t={t}
				/>
			)}
			{onHistory && (
				<WorkHistoryPanel
					key={`${row.ticketId}:${row.assignmentId}`}
					ticketId={row.ticketId}
					request={onHistory}
					onOpen={onOpen}
					onWorkspaceReview={onWorkspaceReview}
					t={t}
				/>
			)}
		</article>
	);
}

function FeedbackDetails({
	feedback,
	t,
}: PropsLocale<"dsh-bot"> & { feedback: ReworkFeedback }) {
	return (
		<details data-proactive-feedback="">
			<summary>{t("proactive.reworkDetails")}</summary>
			<ol>
				{feedback.failures.map((failure) => (
					<li key={JSON.stringify(failure)}>
						<strong>{failure.criterion}</strong>
						<p>
							{t("proactive.reworkActual")}: {failure.actual}
						</p>
						<p>
							{t("proactive.reworkExpected")}: {failure.expected}
						</p>
					</li>
				))}
			</ol>
			{feedback.notes && <p>{feedback.notes}</p>}
		</details>
	);
}

function ReworkForm({
	row,
	disabled,
	onSubmit,
	t,
}: PropsLocale<"dsh-bot"> & {
	row: ProactiveWork;
	disabled: boolean;
	onSubmit(feedback: ReworkFeedback): void;
}) {
	const [open, setOpen] = useState(false);
	const [failures, setFailures] = useState<
		Array<ReworkFeedback["failures"][number] & { key: string }>
	>(() => [
		{ key: crypto.randomUUID(), criterion: "", actual: "", expected: "" },
	]);
	const [notes, setNotes] = useState("");
	const [invalid, setInvalid] = useState(false);
	const change = (
		index: number,
		field: keyof ReworkFeedback["failures"][number],
		value: string,
	) => {
		setFailures((rows) =>
			rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
		);
		setInvalid(false);
	};
	if (!open)
		return (
			<Button variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
				{t("proactive.rework")}
			</Button>
		);
	return (
		<form
			data-proactive-rework=""
			onSubmit={(event) => {
				event.preventDefault();
				const parsed = reworkFeedbackSchema.safeParse({
					failures: failures.map(({ key: _key, ...finding }) => finding),
					...(notes.trim() ? { notes } : {}),
				});
				if (!parsed.success) {
					setInvalid(true);
					return;
				}
				if (!disabled) onSubmit(parsed.data);
			}}
		>
			<p>{t("proactive.reworkInstructions")}</p>
			{failures.map((failure, index) => (
				<fieldset key={failure.key} disabled={disabled}>
					<legend>{t("proactive.reworkItem", { number: index + 1 })}</legend>
					<label htmlFor={`${row.assignmentId}-${failure.key}`}>
						{t("proactive.reworkCriterion")}
						<Input
							id={`${row.assignmentId}-${failure.key}`}
							required
							maxLength={160}
							value={failure.criterion}
							onChange={(event) =>
								change(index, "criterion", event.target.value)
							}
						/>
					</label>
					<label>
						{t("proactive.reworkActual")}
						<textarea
							required
							maxLength={512}
							value={failure.actual}
							onChange={(event) => change(index, "actual", event.target.value)}
						/>
					</label>
					<label>
						{t("proactive.reworkExpected")}
						<textarea
							required
							maxLength={512}
							value={failure.expected}
							onChange={(event) =>
								change(index, "expected", event.target.value)
							}
						/>
					</label>
					{failures.length > 1 && (
						<Button
							variant="ghost"
							onClick={() =>
								setFailures((rows) => rows.filter((_row, i) => i !== index))
							}
						>
							{t("proactive.reworkRemove")}
						</Button>
					)}
				</fieldset>
			))}
			{failures.length < 8 && (
				<Button
					variant="ghost"
					disabled={disabled}
					onClick={() =>
						setFailures((rows) => [
							...rows,
							{
								key: crypto.randomUUID(),
								criterion: "",
								actual: "",
								expected: "",
							},
						])
					}
				>
					{t("proactive.reworkAdd")}
				</Button>
			)}
			<label>
				{t("proactive.reworkNotes")}
				<textarea
					disabled={disabled}
					maxLength={1024}
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
				/>
			</label>
			{invalid && <p role="alert">{t("proactive.reworkInvalid")}</p>}
			<Button variant="primary" type="submit" disabled={disabled}>
				{t("proactive.reworkSubmit")}
			</Button>
			<Button
				variant="ghost"
				disabled={disabled}
				onClick={() => setOpen(false)}
			>
				{t("actions.close")}
			</Button>
		</form>
	);
}

function WorkHistoryPanel({
	ticketId,
	request,
	onOpen,
	onWorkspaceReview,
	t,
}: PropsLocale<"dsh-bot"> & {
	ticketId: string;
	request(input: WorkHistoryRequest): Promise<WorkHistory>;
	onOpen(id: string): Promise<void>;
	onWorkspaceReview?(input: WorkspaceReviewRequest): Promise<WorkspaceReview>;
}) {
	const [result, setResult] = useState<WorkHistory>();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const sequence = useRef(0);
	useEffect(
		() => () => {
			++sequence.current;
		},
		[],
	);
	async function load(beforeGeneration?: number) {
		const current = ++sequence.current;
		setPending(true);
		setFailed(false);
		try {
			const page = await request({
				ticketId,
				...(beforeGeneration ? { beforeGeneration } : {}),
			});
			if (current === sequence.current)
				setResult((previous) => ({
					versions: beforeGeneration
						? [...(previous?.versions ?? []), ...page.versions]
						: page.versions,
					...(page.nextBeforeGeneration
						? { nextBeforeGeneration: page.nextBeforeGeneration }
						: {}),
				}));
		} catch {
			if (current === sequence.current) setFailed(true);
		} finally {
			if (current === sequence.current) setPending(false);
		}
	}
	return (
		<section data-proactive-history="" aria-label={t("proactive.history")}>
			<Button variant="ghost" disabled={pending} onClick={() => void load()}>
				{t("proactive.history")}
			</Button>
			{failed && <p role="status">{t("proactive.historyFailed")}</p>}
			{result?.versions.map((version) => (
				<details key={version.assignmentId}>
					<summary>
						{t("proactive.historyVersion", { generation: version.generation })}{" "}
						· {t(`proactive.state.${version.state}`)}
					</summary>
					{version.evidenceDigest && (
						<p>
							{t("proactive.evidence")} <code>{version.evidenceDigest}</code>
						</p>
					)}
					{version.repairEvidence && (
						<>
							<p>
								{t("proactive.testEvidence", {
									tool: version.repairEvidence.verification.tool,
									before: version.repairEvidence.baseline.exitCode,
									after: version.repairEvidence.verification.exitCode,
								})}
							</p>
							<p>
								{t("proactive.proposedEdit", {
									field: version.repairEvidence.edit.field,
									value: JSON.stringify(version.repairEvidence.edit.value),
								})}
							</p>
							<p>
								{t("proactive.artifactDigest")}{" "}
								<code>{version.repairEvidence.artifactDigest}</code>
							</p>
						</>
					)}
					{version.reviewFeedback && (
						<FeedbackDetails feedback={version.reviewFeedback} t={t} />
					)}
					{version.workspaceEvidence && (
						<WorkspaceEvidence
							key={`${version.assignmentId}:${version.evidenceDigest}`}
							row={version}
							request={onWorkspaceReview}
							t={t}
						/>
					)}
					{version.rework && (
						<FeedbackDetails feedback={version.rework.feedback} t={t} />
					)}
					{version.sessionId && (
						<Button
							variant="ghost"
							onClick={() => {
								if (version.sessionId)
									void onOpen(version.sessionId).catch(() => {});
							}}
						>
							{t("proactive.transcript")}
						</Button>
					)}
				</details>
			))}
			{result?.nextBeforeGeneration && (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() => void load(result.nextBeforeGeneration)}
				>
					{t("proactive.historyMore")}
				</Button>
			)}
		</section>
	);
}

function ExternalNoticePanel({
	fence,
	request,
	t,
}: PropsLocale<"dsh-bot"> & {
	fence: ExternalNoticeRequest;
	request(input: ExternalNoticeRequest): Promise<ExternalNoticeResult>;
}) {
	const [preview, setPreview] = useState<ExternalNoticeResult>();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	async function send(reviewedDigest?: string) {
		setPending(true);
		setFailed(false);
		try {
			setPreview(
				await request({
					...fence,
					...(reviewedDigest ? { reviewedDigest } : {}),
				}),
			);
		} catch {
			setPreview(undefined);
			setFailed(true);
		} finally {
			setPending(false);
		}
	}
	return (
		<div data-proactive-external-notice="">
			{preview ? (
				<>
					<p>
						{t("proactive.noticeTarget", {
							label: preview.label,
							id: preview.targetRef,
						})}
					</p>
					<p>{preview.text}</p>
					<p role="status">{t(`notifications.${preview.state}`)}</p>
					{preview.state === "recorded" && (
						<Button
							variant="primary"
							disabled={pending}
							onClick={() => void send(preview.digest)}
						>
							{t("proactive.noticeConfirm")}
						</Button>
					)}
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => setPreview(undefined)}
					>
						{t("actions.close")}
					</Button>
				</>
			) : (
				<Button variant="ghost" disabled={pending} onClick={() => void send()}>
					{t("proactive.noticePreview")}
				</Button>
			)}
			{failed && <p role="status">{t("proactive.noticeFailed")}</p>}
		</div>
	);
}

function GroupReviewPanel({
	fence,
	request,
	savedFollowUp,
	onOpen,
	t,
}: PropsLocale<"dsh-bot"> & {
	fence: GroupReviewRequest;
	request(input: GroupReviewRequest): Promise<GroupReviewResult>;
	savedFollowUp?: NonNullable<ProactiveWork["groupReview"]>["followUp"];
	onOpen(id: string): Promise<void>;
}) {
	const [result, setResult] = useState<GroupReviewResult>();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	async function update(
		fields: Omit<GroupReviewRequest, "ticketId" | "expectedRevision"> = {},
	) {
		setPending(true);
		setFailed(false);
		try {
			setResult(await request({ ...fence, ...fields }));
		} catch {
			setResult(undefined);
			setFailed(true);
		} finally {
			setPending(false);
		}
	}
	const followUpState =
		(result?.kind === "linked" ? result.followUpState : undefined) ??
		savedFollowUp?.state;
	return (
		<div className={workspaceStyles.content} data-proactive-group-review="">
			{!result && (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() => void update()}
				>
					{t("proactive.groupReview")}
				</Button>
			)}
			{result?.kind === "choices" &&
				(result.groups.length ? (
					result.groups.map((choice) => (
						<Button
							key={choice.group.groupId}
							variant="ghost"
							disabled={pending}
							onClick={() => void update({ group: choice.group })}
						>
							{choice.title}
						</Button>
					))
				) : (
					<p>{t("proactive.groupEmpty")}</p>
				))}
			{result?.kind === "preview" && (
				<>
					<p>
						{t("proactive.groupScope", {
							group: result.choice.title,
							bots: result.choice.memberBotIds.join(", "),
						})}
					</p>
					<pre>{result.text}</pre>
					{result.followUpAvailable && (
						<div>
							<p>{t("proactive.groupFollowUpScope")}</p>
							{result.choice.memberIds.map((member, index) => (
								<Button
									key={member}
									variant="ghost"
									disabled={pending}
									aria-pressed={result.followUpMemberId === member}
									onClick={() =>
										void update({
											group: result.choice.group,
											...(result.followUpMemberId === member
												? {}
												: { followUpMemberId: member }),
										})
									}
								>
									{t("proactive.groupFollowUpChoose", {
										bot: result.choice.memberBotIds[index] ?? member,
									})}
								</Button>
							))}
						</div>
					)}
					<Button
						variant="primary"
						disabled={pending}
						onClick={() =>
							void update({
								group: result.choice.group,
								reviewedDigest: result.digest,
								...(result.followUpMemberId
									? { followUpMemberId: result.followUpMemberId }
									: {}),
							})
						}
					>
						{t("proactive.groupConfirm")}
					</Button>
				</>
			)}
			{followUpState && (
				<p role="status">{t(`proactive.groupFollowUp.${followUpState}`)}</p>
			)}
			{followUpState === "armed" && savedFollowUp?.state === "armed" && (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() => void update({ cancelFollowUp: true })}
				>
					{t("proactive.groupFollowUpCancel")}
				</Button>
			)}
			{result?.kind === "linked" && (
				<Button
					variant="ghost"
					onClick={() => void onOpen(result.rootSessionId).catch(() => {})}
				>
					{t("proactive.groupOpen")}
				</Button>
			)}
			{result?.kind === "unknown" && (
				<p role="status">{t("proactive.state.unknown")}</p>
			)}
			{failed && <p role="status">{t("proactive.groupFailed")}</p>}
		</div>
	);
}
