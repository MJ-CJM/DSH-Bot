import type { BotKey } from "../../shared/identity.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import type {
	ProactiveStatus,
	Suggestion,
} from "../../shared/proactive/protocol.js";
import type {
	FeedbackAction,
	FeedbackRule,
} from "../../shared/proactive/feedback.js";
import type { BotRecord } from "../../shared/schema.js";
import type {
	ProactiveWork,
	WorkHistory,
	WorkHistoryRequest,
} from "../../shared/proactive/work.js";
import type {
	WorkspaceReview,
	WorkspaceReviewRequest,
} from "../../shared/proactive/workspace-repair.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { WorkspaceOffer } from "./WorkspaceOffer.js";
import type {
	AcceptRequest,
	CancelRequest,
	FeedbackRequest,
	ExternalNoticeRequest,
	ExternalNoticeResult,
	GroupReviewRequest,
	GroupReviewResult,
	PauseRequest,
	RevokeSourceRequest,
	ReviewRequest,
	SuggestionActionReply,
	SuggestionRequest,
} from "../../shared/proactive/remote-contract.js";
import styles from "../styles/detail.module.css";
import workspaceStyles from "./workspace.module.css";
import workspaceCss from "./workspace.module.css?inline";

export interface ProactiveActions {
	adjust?(input: {
		commandId: string;
		decisionId: string;
		expectedRevision: number;
		title: string;
	}): Promise<SuggestionActionReply>;
	status(): Promise<ProactiveStatus>;
	suggestions(owner?: BotKey): Promise<Suggestion[]>;
	change(input: SuggestionRequest): Promise<SuggestionActionReply>;
	feedback(input: FeedbackRequest): Promise<SuggestionActionReply>;
	work(): Promise<ProactiveWork[]>;
	groupReview(input: GroupReviewRequest): Promise<GroupReviewResult>;
	externalNotice(input: ExternalNoticeRequest): Promise<ExternalNoticeResult>;
	accept(input: AcceptRequest): Promise<SuggestionActionReply>;
	pause(input: PauseRequest): Promise<SuggestionActionReply>;
	revokeSource(input: RevokeSourceRequest): Promise<SuggestionActionReply>;
	cancel(input: CancelRequest): Promise<SuggestionActionReply>;
	review(input: ReviewRequest): Promise<SuggestionActionReply>;
	workHistory?(input: WorkHistoryRequest): Promise<WorkHistory>;
	workspaceReview?(input: WorkspaceReviewRequest): Promise<WorkspaceReview>;
}

export function SuggestionPanel({
	actions,
	bot,
	onOpen,
	children,
	t,
}: PropsLocale<"dsh-bot"> & {
	actions: ProactiveActions;
	bot: BotRecord;
	onOpen(id: string): Promise<void>;
	children?: ReactNode;
}) {
	const [state, setState] = useState<ProactiveStatus["state"]>("starting");
	const [rows, setRows] = useState<Suggestion[]>([]);
	const [work, setWork] = useState<ProactiveWork[]>([]);
	const [groupReview, setGroupReview] = useState(false);
	const [externalNotice, setExternalNotice] = useState(false);
	const [feed, setFeed] = useState<
		Pick<ProactiveStatus, "localFeed" | "localFeedScope">
	>({});
	const [revokePreview, setRevokePreview] = useState<string>();
	const [offers, setOffers] = useState<
		NonNullable<ProactiveStatus["repairOffers"]>
	>([]);
	const [workspaceOffers, setWorkspaceOffers] = useState<
		NonNullable<ProactiveStatus["workspaceOffers"]>
	>([]);
	const [groupRepairOffers, setGroupRepairOffers] = useState<
		NonNullable<ProactiveStatus["groupRepairOffers"]>
	>([]);
	const [route, setRoute] = useState<ProactiveStatus["directRoute"]>();
	const [control, setControl] =
		useState<NonNullable<ProactiveStatus["snapshot"]>["executionControl"]>();
	const [preview, setPreview] = useState<string>();
	const [rules, setRules] = useState<FeedbackRule[]>([]);
	const [feedbackSource, setFeedbackSource] = useState<string>();
	const [pending, setPending] = useState(false);
	const [feedback, setFeedback] = useState<"unknown" | "stale">();
	const sequence = useRef(0);
	const busy = useRef(false);
	const mounted = useRef(false);
	const refresh = useCallback(async () => {
		const revision = ++sequence.current;
		try {
			const status = await actions.status();
			const [rows, work] =
				status.state === "ready"
					? await Promise.all([
							actions.suggestions({
								botId: bot.id,
								botCreatedAt: bot.createdAt,
							}),
							actions.work(),
						])
					: [[], []];
			if (revision !== sequence.current) return;
			setState(status.state);
			setExternalNotice(status.capabilities.externalNotification);
			setGroupReview(status.capabilities.automaticGroup);
			setFeed({
				localFeed: status.localFeed,
				localFeedScope: status.localFeedScope,
			});
			setRows(rows);
			setWork(work);
			setRoute(status.directRoute);
			setOffers(status.repairOffers ?? []);
			setGroupRepairOffers(status.groupRepairOffers ?? []);
			setWorkspaceOffers(status.workspaceOffers ?? []);
			setRules(status.snapshot?.feedbackRules ?? []);
			setFeedbackSource(status.snapshot?.feedbackSource);
			setControl(
				status.directRoute || status.snapshot?.executionControl.paused
					? status.snapshot?.executionControl
					: undefined,
			);
		} catch {
			if (revision !== sequence.current) return;
			setState("unavailable");
			setExternalNotice(false);
			setGroupReview(false);
			setFeed({});
			setRows([]);
			setWork([]);
			setRoute(undefined);
			setOffers([]);
			setGroupRepairOffers([]);
			setWorkspaceOffers([]);
			setRules([]);
			setFeedbackSource(undefined);
			setControl(undefined);
		}
	}, [actions, bot.id, bot.createdAt]);

	useEffect(() => {
		mounted.current = true;
		const reload = () => {
			if (document.visibilityState === "visible" && !busy.current)
				void refresh();
			else ++sequence.current;
		};
		reload();
		document.addEventListener("visibilitychange", reload);
		return () => {
			mounted.current = false;
			++sequence.current;
			document.removeEventListener("visibilitychange", reload);
		};
	}, [refresh]);
	const nextExpiry = Math.min(...rows.map((row) => Date.parse(row.expiresAt)));
	useEffect(() => {
		if (!Number.isFinite(nextExpiry)) return;
		const timer = setTimeout(
			() => {
				setRows((current) =>
					current.filter((row) => Date.parse(row.expiresAt) > Date.now()),
				);
			},
			Math.max(0, nextExpiry - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [nextExpiry]);

	async function act(run: () => Promise<SuggestionActionReply>) {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		setFeedback(undefined);
		++sequence.current;
		try {
			const result = await run();
			if (mounted.current) setPreview(undefined);
			if (mounted.current && result.kind !== "receipt")
				setFeedback(result.kind === "unknown" ? "unknown" : "stale");
		} catch {
			if (mounted.current) setFeedback("unknown");
		} finally {
			busy.current = false;
			if (mounted.current) {
				setPending(false);
				void refresh();
			}
		}
	}

	const change = (row: Suggestion, action: SuggestionRequest["action"]) =>
		act(() =>
			actions.change({
				commandId: crypto.randomUUID(),
				decisionId: row.id,
				expectedRevision: row.revision,
				action,
			}),
		);
	const responsibilityFor = (
		row: Suggestion,
		action: string,
		scope?: string,
	) => {
		const match = row.matchedResponsibilities?.find(
			(rule) => rule.action === action && rule.actionScopeDigest === scope,
		);
		return match
			? { responsibility: { id: match.id, revision: match.revision } }
			: {};
	};
	const changeRule = (input: FeedbackAction) =>
		void act(() => actions.feedback({ commandId: crypto.randomUUID(), input }));
	const visibleWork = work.filter(
		(row) =>
			row.target.bot.botId === bot.id &&
			row.target.bot.botCreatedAt === bot.createdAt,
	);
	if (state === "disabled")
		return (
			<section className={styles.section}>
				<h2>{t("proactive.title")}</h2>
				<p>{t("proactive.disabledHint")}</p>
			</section>
		);
	const { localFeed, localFeedScope } = feed;
	const feedKey =
		localFeedScope && `${localFeedScope.id}:${localFeedScope.generation}`;
	return (
		<section
			aria-label={t("proactive.title")}
			data-proactive-suggestions=""
			className={`${styles.section} ${workspaceStyles.content}`}
		>
			<style>{workspaceCss}</style>
			<h2>{t("proactive.title")}</h2>
			<p>{t("proactive.scope")}</p>
			{children}
			<Button variant="ghost" disabled={pending} onClick={() => void refresh()}>
				{t("proactive.refresh")}
			</Button>
			{control && (
				<Button
					variant="ghost"
					disabled={pending}
					onClick={() =>
						void act(() =>
							actions.pause({
								commandId: crypto.randomUUID(),
								paused: !control.paused,
								expectedRevision: control.revision,
							}),
						)
					}
				>
					{t(control.paused ? "proactive.resume" : "proactive.pause")}
				</Button>
			)}
			{feedback && <p role="status">{t(`proactive.${feedback}`)}</p>}
			{localFeed && localFeedScope && (
				<div data-proactive-ci-feed="">
					<p role="status">
						{t("proactive.feedScope", {
							repository: localFeedScope.repository,
							branch: localFeedScope.branch,
							generation: String(localFeedScope.generation),
						})}{" "}
						· {t(`proactive.feed.${localFeed}`)}
					</p>
					{localFeed !== "revoked" &&
						(revokePreview === feedKey ? (
							<>
								<p>{t("proactive.feedRevokeHint")}</p>
								<Button
									variant="ghost"
									disabled={pending}
									onClick={() => {
										setRevokePreview(undefined);
										void act(() =>
											actions.revokeSource({
												commandId: crypto.randomUUID(),
												sourceId: localFeedScope.id,
												generation: localFeedScope.generation,
											}),
										);
									}}
								>
									{t("proactive.feedRevokeConfirm")}
								</Button>
								<Button
									variant="ghost"
									disabled={pending}
									onClick={() => setRevokePreview(undefined)}
								>
									{t("actions.close")}
								</Button>
							</>
						) : (
							<Button
								variant="ghost"
								disabled={pending}
								onClick={() => setRevokePreview(feedKey)}
							>
								{t("proactive.feedRevoke")}
							</Button>
						))}
				</div>
			)}
			{state !== "ready" && <p role="status">{t(`proactive.${state}`)}</p>}
			{state === "ready" && rows.length === 0 && <p>{t("proactive.empty")}</p>}
			{rows.map((row) => (
				<article key={row.id} data-proactive-decision={row.id}>
					<h3>{row.title}</h3>
					{row.matchedResponsibilities?.map((rule) => (
						<p key={rule.id}>{rule.name}</p>
					))}
					<p>{t("proactive.reason", { attempt: String(row.attempt) })}</p>
					<p>
						{t("proactive.expiry", {
							at: new Date(row.expiresAt).toLocaleString(),
						})}
					</p>
					{row.observeUntil && (
						<p>
							{t("proactive.observing", {
								at: new Date(row.observeUntil).toLocaleString(),
							})}
						</p>
					)}
					<details>
						<summary>{t("proactive.evidence")}</summary>
						<p>
							{row.sourceId} / {row.triggerId}
						</p>
						<p>{t("proactive.policy", { version: row.policyVersion })}</p>
						{row.context && (
							<a href={row.context.url} target="_blank" rel="noreferrer">
								{row.context.repository} · {row.context.branch} ·{" "}
								{row.context.runId} · {row.context.commit.slice(0, 12)}
							</a>
						)}
					</details>
					{route &&
						row.state === "open" &&
						(preview === row.id ? (
							<div>
								<p>
									{t("proactive.bot", {
										id: bot.id,
										at: new Date(bot.createdAt).toISOString(),
									})}
								</p>
								<p>{t("proactive.acceptHint", route)}</p>
								<p>{t("proactive.costHint")}</p>
								{actions.adjust && (
									<form
										onSubmit={(event) => {
											event.preventDefault();
											const adjust = actions.adjust;
											if (!adjust) return;
											const title = String(
												new FormData(event.currentTarget).get("objective") ??
													"",
											);
											void act(() =>
												adjust({
													commandId: crypto.randomUUID(),
													decisionId: row.id,
													expectedRevision: row.revision,
													title,
												}),
											);
										}}
									>
										<label>
											{t("proactive.adjustGoal")}
											<textarea
												name="objective"
												required
												maxLength={500}
												defaultValue={row.title}
											/>
										</label>
										<Button type="submit" disabled={pending}>
											{t("proactive.adjustSave")}
										</Button>
									</form>
								)}

								<Button
									variant="primary"
									disabled={pending}
									onClick={() =>
										void act(() =>
											actions.accept({
												commandId: crypto.randomUUID(),
												decisionId: row.id,
												expectedRevision: row.revision,
												sourceId: row.sourceId,
												policyVersion: row.policyVersion,
												approved: true,
												...responsibilityFor(row, "inspect-ci-result"),
												target: {
													...route,
													bot: { botId: bot.id, botCreatedAt: bot.createdAt },
													botUpdatedAt: bot.updatedAt,
												},
											}),
										)
									}
								>
									{t("proactive.accept")}
								</Button>
								{offers
									.filter((offer) => offer.sourceId === row.sourceId)
									.map(({ title, sourceId: _source, ...repair }) => (
										<div key={repair.executor}>
											<p>
												{t(
													repair.executor === "external"
														? "proactive.repairExternalHint"
														: "proactive.repairNativeHint",
													{ title },
												)}
											</p>
											<Button
												variant="primary"
												disabled={pending}
												onClick={() =>
													void act(() =>
														actions.accept({
															commandId: crypto.randomUUID(),
															decisionId: row.id,
															expectedRevision: row.revision,
															sourceId: row.sourceId,
															policyVersion: row.policyVersion,
															approved: true,
															repair,
															...responsibilityFor(
																row,
																repair.executor === "external"
																	? "repair-external"
																	: "repair-fixture",
																repair.specDigest,
															),
															target: {
																...route,
																bot: {
																	botId: bot.id,
																	botCreatedAt: bot.createdAt,
																},
																botUpdatedAt: bot.updatedAt,
															},
														}),
													)
												}
											>
												{t(
													repair.executor === "external"
														? "proactive.repairExternal"
														: "proactive.repairNative",
												)}
											</Button>
										</div>
									))}
								{workspaceOffers
									.filter((offer) => offer.sourceId === row.sourceId)
									.map((offer) => (
										<WorkspaceOffer
											key={`${offer.executor}:${offer.specDigest}:${offer.baselineDigest}`}
											offer={offer}
											groups={groupRepairOffers.filter(
												(item) =>
													item.grant.supervisor.bot.botId === bot.id &&
													item.grant.supervisor.bot.botCreatedAt ===
														bot.createdAt,
											)}
											pending={pending}
											t={t}
											onAccept={(workspaceRepair, groupRepair) =>
												void act(() =>
													actions.accept({
														commandId: crypto.randomUUID(),
														decisionId: row.id,
														expectedRevision: row.revision,
														sourceId: row.sourceId,
														policyVersion: row.policyVersion,
														approved: true,
														workspaceRepair,
														...(groupRepair ? { groupRepair } : {}),
														...responsibilityFor(
															row,
															"repair-workspace",
															workspaceRepair.specDigest,
														),
														target: {
															...route,
															bot: {
																botId: bot.id,
																botCreatedAt: bot.createdAt,
															},
															botUpdatedAt: bot.updatedAt,
														},
													}),
												)
											}
										/>
									))}
								<Button variant="ghost" onClick={() => setPreview(undefined)}>
									{t("actions.cancel")}
								</Button>
							</div>
						) : (
							<Button
								variant="ghost"
								disabled={pending}
								onClick={() => setPreview(row.id)}
							>
								{t("proactive.preview")}
							</Button>
						))}
					<Button
						variant="ghost"
						disabled={pending}
						onClick={() => void change(row, "dismiss")}
					>
						{t("proactive.dismiss")}
					</Button>
					<Button
						variant="ghost"
						disabled={pending || row.state === "observing"}
						onClick={() => void change(row, "observe")}
					>
						{t("proactive.observe")}
					</Button>
					{feedbackSource === row.sourceId &&
						row.job &&
						!rules.some(
							(rule) => rule.job === row.job && rule.attempt === row.attempt,
						) && (
							<Button
								variant="ghost"
								disabled={pending}
								onClick={() =>
									changeRule({
										action: "propose",
										decisionId: row.id,
										expectedRevision: row.revision,
									})
								}
							>
								{t("proactive.feedbackPropose")}
							</Button>
						)}
				</article>
			))}
			{rules.length > 0 && (
				<section aria-label={t("proactive.feedbackRules")}>
					<h2>{t("proactive.feedbackRules")}</h2>
					{rules.map((rule) => {
						const action =
							rule.state === "candidate"
								? "evaluate"
								: rule.state === "adopted"
									? "revoke"
									: rule.state === "eligible" || rule.state === "revoked"
										? "adopt"
										: undefined;
						return (
							<article key={rule.id} data-proactive-rule={rule.id}>
								<p>
									{t("proactive.feedbackScope", {
										job: rule.job,
										attempt: rule.attempt,
									})}
								</p>
								<p role="status">{t(`proactive.rule.${rule.state}`)}</p>
								{rule.evaluation && (
									<details>
										<summary>{t("proactive.feedbackResult")}</summary>
										<code>{rule.evaluation.digest}</code>
										<ol>
											{rule.evaluation.batches.map((batch) => (
												<li key={batch.id}>
													{t("proactive.feedbackBatch", batch)}
												</li>
											))}
										</ol>
									</details>
								)}
								{action && (
									<Button
										variant="ghost"
										disabled={pending}
										onClick={() =>
											changeRule({
												action,
												ruleId: rule.id,
												expectedRevision: rule.revision,
											})
										}
									>
										{t(`proactive.feedback.${action}`)}
									</Button>
								)}
							</article>
						);
					})}
				</section>
			)}
			{visibleWork.length > 0 && (
				<section aria-label={t("proactive.work")}>
					<h2>{t("proactive.work")}</h2>
					<p>{t("proactive.awaiting")}</p>
					{visibleWork.map((row) => (
						<ReviewPanel
							key={row.ticketId}
							row={row}
							pending={pending}
							canRework={!!route}
							onHistory={actions.workHistory}
							onWorkspaceReview={actions.workspaceReview}
							onExternalNotice={
								externalNotice ? actions.externalNotice : undefined
							}
							onGroupReview={
								groupReview || row.groupReview?.followUp
									? async (input) => {
											const result = await actions.groupReview(input);
											if (row.state === "delivered" && input.reviewedDigest)
												await refresh();
											return result;
										}
									: undefined
							}
							t={t}
							onOpen={onOpen}
							onCancel={(input) => void act(() => actions.cancel(input))}
							onReview={(input) => void act(() => actions.review(input))}
						/>
					))}
				</section>
			)}
		</section>
	);
}
