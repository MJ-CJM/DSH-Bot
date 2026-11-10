import type { ProactiveSetupRequest, ProactiveSetupReply } from "../../shared/proactive/setup.js";
import { TaskOutcomes } from "./TaskOutcomes.js";
import { DocumentTask } from "./DocumentTask.js";
import type { DocumentRequest } from "../../shared/proactive/document.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
	useEffect,
	useRef,
	useState,
} from "react";
import type { Suggestion } from "../../shared/proactive/protocol.js";
import type { ProactiveWorkSnapshot } from "./work-state.js";
import type { ProactiveDetailTarget } from "../detail-state.js";
import type {
	FeedbackAction,
} from "../../shared/proactive/feedback.js";
import type { BotRecord } from "../../shared/schema.js";
import type {
	WorkHistory,
	WorkHistoryRequest,
} from "../../shared/proactive/work.js";
import type {
	WorkspaceReview,
	WorkspaceReviewRequest,
} from "../../shared/proactive/workspace-repair.js";
import { WorkCard } from './WorkCard.js';
import type { ActivityRequest, WorkDetailRequest } from '../../shared/proactive/activity.js';
import type { ActivityPage } from '../../shared/proactive/protocol.js';
import type { ProactiveWork } from '../../shared/proactive/work.js';
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
import type { WorkContinuationRequest } from '../../shared/proactive/work.js';

export interface ProactiveActions {
  setup?(input: ProactiveSetupRequest): Promise<ProactiveSetupReply>;
  submitDocument?(input: DocumentRequest): Promise<SuggestionActionReply>;
  activityPage?(input: ActivityRequest): Promise<ActivityPage>;
  reconcileWork?(input: WorkDetailRequest): Promise<ProactiveWork>;
  workDetail?(input: WorkDetailRequest): Promise<ProactiveWork>;
  workContinuation?(input: WorkContinuationRequest): Promise<SuggestionActionReply>;
	adjust?(input: {
		commandId: string;
		decisionId: string;
		expectedRevision: number;
		title: string;
	}): Promise<SuggestionActionReply>;
	change(input: SuggestionRequest): Promise<SuggestionActionReply>;
	feedback(input: FeedbackRequest): Promise<SuggestionActionReply>;
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
	snapshot,
	refresh,
	target,
  followUpControls = false,
  continuationPolicy,
	onTargetReached,
	onOpen,
	t,
}: PropsLocale<"dsh-bot"> & {
	actions: ProactiveActions;
	bot: BotRecord;
	snapshot: ProactiveWorkSnapshot;
	refresh?: () => Promise<void>;
	target?: ProactiveDetailTarget;
  followUpControls?: boolean;
  continuationPolicy?: number;
	onTargetReached(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { status, error, refreshedAt } = snapshot;
  const [older, setOlder] = useState<ActivityPage>();
  const [sourceId, setSourceId] = useState('');
  const [project, setProject] = useState<{ work: Extract<ActivityPage, { collection: 'work' }>; suggestions: Extract<ActivityPage, { collection: 'suggestions' }> }>();
  const [pageError, setPageError] = useState(false);
  const [paging, setPaging] = useState(false);
  const loadedWork: readonly ProactiveWork[] = older?.collection === 'work' ? older.rows : sourceId ? project?.work.rows ?? [] : snapshot.work;
  const [focusedWork, setFocusedWork] = useState<{ ticketId: string; row?: ProactiveWork }>();
  const ticketId = target?.kind === 'work' ? target.id : undefined;
  const targetAlreadyLoaded = loadedWork.some(row => row.ticketId === ticketId);
  const directWork = (!target || focusedWork?.ticketId === ticketId) && focusedWork?.row?.target.bot.botId === bot.id
    && focusedWork?.row?.target.bot.botCreatedAt === bot.createdAt ? focusedWork.row : undefined;
  const work = directWork && !loadedWork.some(row => row.ticketId === directWork.ticketId) ? [directWork, ...loadedWork] : loadedWork;
  useEffect(() => {
    if (!ticketId || targetAlreadyLoaded || !actions.workHistory) return;
    let active = true;
    void actions.workHistory({ ticketId, limit: 1 }).then(({ versions }) => {
      if (!active) return;
      const row = versions.find(work => work.ticketId === ticketId && work.target.bot.botId === bot.id && work.target.bot.botCreatedAt === bot.createdAt);
      setFocusedWork({ ticketId, row });
    }, () => { if (active) setFocusedWork({ ticketId }); });
    return () => { active = false; };
  }, [actions.workHistory, bot.id, bot.createdAt, targetAlreadyLoaded, ticketId]);
  const pageAlive = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing Bot incarnation must reset local pagination and invalidate pending reads.
  useEffect(() => { ++pageAlive.current; setOlder(undefined); setSourceId(''); setProject(undefined); setPaging(false); setPageError(false); return () => { ++pageAlive.current; }; }, [bot.id, bot.createdAt]);
  const nextPage = async (collection: 'work' | 'suggestions') => {
    if (!actions.activityPage || paging) return;
    const cursor = older?.collection === collection ? older.next : collection === 'work' ? (sourceId ? project?.work.next : snapshot.nextWork) : (sourceId ? project?.suggestions.next : snapshot.nextSuggestions);
    if (!cursor) return;
    const epoch = ++pageAlive.current;
    setPaging(true); setPageError(false);
    try {
      const page = await actions.activityPage({ owner: { botId: bot.id, botCreatedAt: bot.createdAt }, collection, cursor, ...(sourceId ? { sourceId } : {}) });
      if (epoch === pageAlive.current) setOlder(page);
    } catch { if (epoch === pageAlive.current) setPageError(true); }
    finally { if (epoch === pageAlive.current) setPaging(false); }
  };
	const state = status?.state ?? (error ? "unavailable" : "starting");
  const selectProject = (source: string) => {
    ++pageAlive.current;
    setSourceId(source); setOlder(undefined); setProject(undefined); setPageError(false); setPaging(false);
  };
  // Reuse the shared foreground refresh cadence for the selected source. Older
  // pages remain a deliberate snapshot until the user returns to latest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshedAt intentionally drives this source projection from the existing shared poll.
  useEffect(() => {
    if (!sourceId || !actions.activityPage || older) return;
    const epoch = ++pageAlive.current;
    const owner = { botId: bot.id, botCreatedAt: bot.createdAt };
    setPaging(true);
    void Promise.all([
      actions.activityPage({ owner, collection: 'work', sourceId }),
      actions.activityPage({ owner, collection: 'suggestions', sourceId }),
    ]).then(([work, suggestions]) => {
      if (epoch === pageAlive.current && work.collection === 'work' && suggestions.collection === 'suggestions') {
        setProject({ work, suggestions }); setPageError(false);
      }
    }, () => { if (epoch === pageAlive.current) setPageError(true); })
      .finally(() => { if (epoch === pageAlive.current) setPaging(false); });
    return () => { if (pageAlive.current === epoch) ++pageAlive.current; };
  }, [sourceId, bot.id, bot.createdAt, actions.activityPage, refreshedAt, older]);
  const projects = [...new Map((snapshot.responsibilities ?? []).map(({ responsibility: duty }) =>
    [duty.source.id, { id: duty.source.id, title: `${duty.source.repository} · ${duty.source.branch}` }])).values()];
	const route = error ? undefined : status?.directRoute;
	const control = !error && (route || status?.snapshot?.executionControl.paused)
		? status?.snapshot?.executionControl
		: undefined;
	const externalNotice = !error && status?.capabilities.externalNotification;
	const groupReview = !error && status?.capabilities.automaticGroup;
	const offers = status?.repairOffers ?? [];
	const workspaceOffers = status?.workspaceOffers ?? [];
	const groupRepairOffers = status?.groupRepairOffers ?? [];
	const rules = status?.snapshot?.feedbackRules ?? [];
	const feedbackSource = status?.snapshot?.feedbackSource;
	const [revokePreview, setRevokePreview] = useState<string>();
	const [preview, setPreview] = useState<string>();
	const [pending, setPending] = useState(false);
	const [feedback, setFeedback] = useState<"unknown" | "stale">();
	const busy = useRef(false);
	const mounted = useRef(false);
	const section = useRef<HTMLElement>(null);
	const [now, setNow] = useState(Date.now);
	const rows = (older?.collection === 'suggestions' ? older.rows : sourceId ? project?.suggestions.rows ?? [] : snapshot.suggestions).filter(row => Date.parse(row.expiresAt) > Math.max(now, refreshedAt ?? 0));
	const linkedTicket = target?.kind === "suggestion" ? work.find(row => row.decisionId === target.id) : undefined;
	const focusTarget = linkedTicket ? { kind: "work" as const, id: linkedTicket.ticketId } : target;
	const targetVisible = focusTarget?.kind === "work"
		? work.some(row => row.ticketId === focusTarget.id)
		: rows.some(row => row.id === focusTarget?.id);
	const nextExpiry = Math.min(...rows.map(row => Date.parse(row.expiresAt)));
	useEffect(() => {
		mounted.current = true;
		return () => { mounted.current = false; };
	}, []);
	useEffect(() => {
		if (!Number.isFinite(nextExpiry)) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()));
		return () => clearTimeout(timer);
	}, [nextExpiry]);
	useEffect(() => {
		if (!focusTarget || !targetVisible || !section.current) return;
		const attribute = focusTarget.kind === "suggestion" ? "data-proactive-decision" : "data-proactive-ticket";
		const row = [...section.current.querySelectorAll<HTMLElement>(`[${attribute}]`)]
			.find(element => element.getAttribute(attribute) === focusTarget.id);
		if (!row) return;
		row.focus({ preventScroll: true });
		row.scrollIntoView?.({ block: "nearest" });
		onTargetReached();
	}, [focusTarget, targetVisible, onTargetReached]);

	async function act(run: () => Promise<SuggestionActionReply>) {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		setFeedback(undefined);
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
				void refresh?.();
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

	if (state === "disabled") return null;
	const { localFeed, localFeedScope } = status ?? {};
  const globalControl = control && <Button variant="ghost" disabled={pending} onClick={() => void act(() =>
    actions.pause({ commandId: crypto.randomUUID(), paused: !control.paused, expectedRevision: control.revision }))}>
    {t(control.paused ? 'proactive.resume' : 'proactive.pause')}
  </Button>;
	const feedKey =
		localFeedScope && `${localFeedScope.id}:${localFeedScope.generation}`;
	return (
		<section
			aria-label={t("proactive.title")}
			ref={section}
			data-proactive-suggestions=""
			className={`${styles.section} ${workspaceStyles.content}`}
		>
			<style>{workspaceCss}</style>
			<h2>{t("proactive.title")}</h2>
			<p>{t("proactive.scope")}</p>
      {route && !control?.paused && actions.submitDocument && <DocumentTask key={`${bot.id}:${bot.createdAt}`} owner={{ botId: bot.id, botCreatedAt: bot.createdAt }} submit={actions.submitDocument} refresh={refresh} t={t} />}
			<Button variant="ghost" disabled={pending || !refresh} onClick={() => void refresh?.()}>
				{t("proactive.refresh")}
			</Button>
      {globalControl && (followUpControls ? <details><summary>{t('followUp.advancedExecution')}</summary>{globalControl}</details> : globalControl)}
      {ticketId && focusedWork?.ticketId === ticketId && !targetAlreadyLoaded && !directWork && <p role="status">{t('followUp.openFailed')}</p>}
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
          {status?.localFeedLastSuccessAt && <p>{t('proactive.feedLastSuccess', { at: new Date(status.localFeedLastSuccessAt).toLocaleString(t('activity.locale')) })}</p>}
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
      {actions.activityPage && projects.length > 0 && <details>
        <summary>{t('proactive.findProject')}</summary>
        <select value={sourceId} aria-label={t('proactive.findProject')} disabled={paging}
          onChange={event => void selectProject(event.currentTarget.value)}>
          <option value="">{t('proactive.allProjects')}</option>
          {projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <p>{t('proactive.projectHint')}</p>
      </details>}
			{error && refreshedAt !== undefined && <p role="status">{t("proactive.refreshStale", { at: new Date(refreshedAt).toLocaleString(t("activity.locale")) })}</p>}
			{state !== "ready" && <p role="status">{t(`proactive.${state}`)}</p>}
			{state === "ready" && !error && target && !targetVisible && <p role="status">{t("proactive.targetMissing")}</p>}
			{state === "ready" && !error && rows.length === 0 && <p>{t("proactive.empty")}</p>}
			{rows.map((row) => (
				<article key={row.id} data-proactive-decision={row.id} tabIndex={-1}>
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
			{work.length > 0 && (
				<section aria-label={t("proactive.work")}>
					<h2>{t("proactive.work")}</h2>
          <TaskOutcomes rows={loadedWork} complete={!older && !(sourceId ? project?.work.next : snapshot.nextWork)} t={t} />
					<p>{t("proactive.awaiting")}</p>
					{work.map((row) => (
						<WorkCard
              load={actions.workDetail}
              continuationControls={continuationPolicy !== undefined && actions.workContinuation ? {
                policyRevision: continuationPolicy, canLaunch: !!route,
                run: async input => {
                  const reply = await actions.workContinuation?.(input);
                  if (!reply) throw new Error('Work continuation unavailable');
                  if (reply.kind === 'receipt' && directWork?.ticketId === input.ticketId && actions.workHistory) {
                    const result = await actions.workHistory({ ticketId: input.ticketId, limit: 1 }).catch(() => undefined);
                    const latest = result?.versions.find(row => row.ticketId === input.ticketId
                      && row.target.bot.botId === input.owner.botId && row.target.bot.botCreatedAt === input.owner.botCreatedAt);
                    if (latest && mounted.current) setFocusedWork({ ticketId: input.ticketId, row: latest });
                  }
                  void refresh?.();
                  return reply;
                },
              } : undefined}
              selected={focusTarget?.kind === "work" && focusTarget.id === row.ticketId}
							key={row.ticketId}
							row={row}
							pending={pending}
							canRework={!!route}
							onHistory={actions.workHistory}
							onWorkspaceReview={actions.workspaceReview}
              onReconcile={actions.reconcileWork ? async input => { await actions.reconcileWork?.(input); await refresh?.(); } : undefined}
							onExternalNotice={
								externalNotice ? actions.externalNotice : undefined
							}
							onGroupReview={
								groupReview || row.groupReview
									? async (input) => {
											const result = await actions.groupReview(input);
											if (row.state === "delivered" && input.reviewedDigest)
												await refresh?.();
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
      {actions.activityPage && <nav aria-label={t('proactive.moreActivity')}>
        {(older?.collection === 'work' ? older.next : sourceId ? project?.work.next : snapshot.nextWork) && <Button variant="ghost" disabled={paging} onClick={() => void nextPage('work')}>{t('proactive.olderWork')}</Button>}
        {(older?.collection === 'suggestions' ? older.next : sourceId ? project?.suggestions.next : snapshot.nextSuggestions) && <Button variant="ghost" disabled={paging} onClick={() => void nextPage('suggestions')}>{t('proactive.olderSuggestions')}</Button>}
        {(older || pageError || sourceId) && <Button variant="ghost" onClick={() => { ++pageAlive.current; setPaging(false); setOlder(undefined); setSourceId(''); setProject(undefined); setPageError(false); void refresh?.(); }}>{t('proactive.latestActivity')}</Button>}
        {pageError && <p role="status">{t('proactive.pageChanged')}</p>}
      </nav>}
		</section>
	);
}
